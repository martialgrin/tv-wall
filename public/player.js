// TV Wall player: runs fullscreen on each TV.
// Plays whatever the server assigns to this screen, locked to the server's clock so that
// every TV is at the same point in its video. Plain ES2017, for older Android signage browsers.

(function () {
  'use strict';

  var SEEK_THRESHOLD = 0.8; // seconds of drift above which we jump instead of nudging the speed
  var SEEK_COOLDOWN = 4000; // after a jump, let the TV settle this long before jumping again
  var MAX_RATE_NUDGE = 0.1; // play at most 10% faster or slower to catch up
  var STALL_TIMEOUT = 8000; // reload the video if it is stuck this long
  var SEEK_TIMEOUT = 30000; // ...or this long while jumping, which some TVs do slowly
  var LOAD_TIMEOUT = 6000;  // a new video still not playing this long after its start may lack a free decoder
  var PRELOAD = 2000;       // ms before a playlist's next video starts, begin loading it in the background
  var KEEP_TIMEOUT = 300000; // give up downloading a video into memory after this long, and try again later
  var MEDIA_ERRORS = {
    1: 'loading was interrupted',
    2: 'network error while downloading it',
    3: 'this TV could not decode it',
    4: 'this TV does not support its format or size',
  };

  var match = /^\/(\d+)/.exec(location.pathname) || /[?&]screen=(\d+)/.exec(location.search);
  var screenId = match ? match[1] : '1';
  document.title = 'TV ' + screenId;

  var els = [document.getElementById('a'), document.getElementById('b')];
  var overlay = document.getElementById('overlay');
  var hint = document.getElementById('hint');

  var clockOffset = null; // server time = performance.now() + clockOffset
  var clockRtt = 0;       // round trip of the measurement clockOffset comes from
  var clockAt = 0;        // when it was taken
  var schedule = null;    // { list, startAt }: the videos this TV plays one after another (or one, looping)
  var targetKey = null;   // what this TV should be showing now or next
  var active = null;      // { el, target }: on screen; null means black
  var pending = null;     // { el, target, positioned, started, retryAt }: loading, swapped in at startAt
  var wantSound = false;
  var soundBlocked = false; // the browser refused sound until someone presses a key
  var oneVideo = false;     // panel option for TVs with a single video decoder: never load two videos at once
  var connected = false;
  var reportBusy = false;   // a report is on its way
  var kept = {};            // server URL -> { blobUrl } once downloaded into memory, with { loading, failures, retryAt }
  var keepBroken = false;   // this browser can't play a video from memory: stream them all
  var lastError = null;
  var drift = 0;
  var stall = { time: -1, since: 0 };
  var overlayTimer = null;
  var lastRev = 0;       // revision of the newest state applied
  var signals = null;    // identify/reload clicks already seen; null until the first state
  var seekLead = 0.15;   // jumps take time, so aim ahead: learned from how long this TV's jumps take
  var startLead = 0.05;  // starting takes time too, so press play this early: learned at each start from the beginning
  var nextSeekAt = 0;

  // For the panel's crash test: counters since this page loaded, and what happened recently.
  var pageId = Math.random().toString(36).slice(2, 10); // new at each page load: shows when a TV restarts
  var health = {
    ok: 0, failed: 0, rtt: 0, clockRtt: 0, // reports that got through or not, and how long the last one took (ms)
    stalls: 0, fallbacks: 0, loadTimeouts: 0, mediaErrors: 0, lateStarts: 0, clockRejected: 0, liveErrors: 0,
  };
  var notes = [];      // { n, t, m, w }: recent events, sent until the server has them
  var noteCount = 0;
  var notesSent = 0;   // the server has every event up to this number
  var failedInARow = 0;

  function note(message, warn) {
    noteCount++;
    notes.push({ n: noteCount, t: Math.round(clockOffset === null ? Date.now() : serverNow()), m: message, w: warn ? 1 : 0 });
    if (notes.length > 30) notes.shift();
  }

  function videoName(url) {
    return decodeURIComponent(url.split('?')[0].split('/').pop());
  }

  function serverNow() {
    return performance.now() + clockOffset;
  }

  // A request that gives up after `ms`. On a weak Wi-Fi link, requests that hang would hold the
  // browser's few connections to the server, and the video could no longer load.
  function fetchJson(url, options, ms) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, ms) : null;
    if (ctrl) options.signal = ctrl.signal;
    return fetch(url, options).then(function (res) {
      return res.json();
    }).then(function (data) {
      clearTimeout(timer);
      return data;
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  // Estimate the server clock from the fastest of a few round trips.
  async function syncClock() {
    var best = null;
    for (var i = 0; i < 6; i++) {
      try {
        var t0 = performance.now();
        var data = await fetchJson('/api/time', { cache: 'no-store' }, 2000);
        var t1 = performance.now();
        if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: data.now - (t0 + t1) / 2 };
      } catch (e) {
        // Try again on the next sync.
      }
    }
    // Through a bad link the estimate can be off by half the round trip: keep the previous one
    // unless this one is about as good, or the previous one is getting old.
    if (best && (clockOffset === null || best.rtt < clockRtt * 2 + 20 || performance.now() - clockAt > 300000)) {
      clockOffset = best.offset;
      clockRtt = best.rtt;
      clockAt = performance.now();
      health.clockRtt = Math.round(best.rtt);
    } else if (best) {
      health.clockRejected++;
      note('Clock sync skipped: the fastest reply took ' + Math.round(best.rtt) + ' ms', true);
    } else {
      note('Clock sync: no reply from the server', true);
    }
  }

  // Where the video should be right now: the time since it started, looping if it's a single video.
  function expectedTime(el, target) {
    var elapsed = Math.max(0, (serverNow() - target.startAt) / 1000);
    var d = el.duration;
    if (!target.loop || !(d > 0) || !isFinite(d)) return elapsed;
    return elapsed % d;
  }

  // Jump to a position, aiming ahead by about as long as this TV takes to jump.
  function jump(el, time) {
    el.jumpStartedAt = performance.now();
    nextSeekAt = el.jumpStartedAt + SEEK_COOLDOWN;
    var target = time + seekLead;
    var d = el.duration;
    el.currentTime = el.loop && d > 0 && isFinite(d) ? target % d : target;
  }

  // ---------- Following the server ----------

  // The same state arrives over the live connection and in replies to reports: keep the newest.
  function onState(s) {
    if (s.rev < lastRev) return;
    lastRev = s.rev;
    onSignals(s.signals);
    var own = s.screens[screenId];
    if (!own) {
      lastError = 'TV ' + screenId + ' does not exist on the server';
      return;
    }
    // The shared video in "Same video" mode (unless this TV keeps its own), else this TV's playlist.
    var names = s.mode === 'all' && !own.keep ? [s.all.video] : own.playlist || [own.video];
    var startAt = s.mode === 'all' && !own.keep ? s.all.startAt : own.startAt;
    schedule = { list: tvwallSchedule.items(names, s.videos), startAt: startAt };
    wantSound = !!own.sound && s.soundOn !== false; // the remote's master switch can silence every TV
    applySound();
    document.body.className = own.rotation ? 'rot-' + own.rotation : '';
    if (!!own.oneVideo !== oneVideo) {
      oneVideo = !!own.oneVideo;
      // A video loading next to the current one may be waiting for the decoder: load it the new way.
      if (pending && pending.el) prepare(pending.target);
    }

    retarget();
  }

  // Head for the video playing now, or for the next one (or the next round of a single video)
  // when it starts within PRELOAD: it then loads in the background while the current one plays,
  // and the cut happens on time. A TV with one video at a time loops a single video in place.
  function retarget() {
    if (!schedule || clockOffset === null) return;
    var now = serverNow();
    var current = tvwallSchedule.segmentAt(schedule.list, schedule.startAt, now, oneVideo);
    var next = tvwallSchedule.segmentAt(schedule.list, schedule.startAt, now + PRELOAD, oneVideo);
    var t = next.startAt !== current.startAt || next.url !== current.url ? next : current;
    var key = t.url + '@' + t.startAt;
    if (key === targetKey) return;
    targetKey = key;
    prepare({ video: t.video, url: t.url, startAt: t.startAt, loop: t.loop });
  }

  // "Identify TVs" and "Reload TVs" arrive as the time of the last click.
  function onSignals(next) {
    if (!next) return;
    var seen = signals;
    signals = next;
    if (!seen) return; // first state since the page loaded: those clicks are old
    if (next.reload > seen.reload) location.reload();
    else if (next.identify > seen.identify) showOverlay('TV ' + screenId, 5000);
  }

  // Load the next video on the hidden element; the old one keeps playing until the cut.
  function prepare(target) {
    if (pending && pending.el) {
      clearTimeout(pending.timer);
      unload(pending.el);
    }
    pending = { target: target, el: null, positioned: false, started: false, retryAt: 0, preparedAt: performance.now() };
    if (!target.url) return; // black screen, switched at startAt by the tick
    var el;
    if (oneVideo) {
      // Stop the current video and load the next one in its place. It shows its first frame
      // until the start time, so the switch pauses briefly but still starts with the other TVs.
      if (active) {
        unload(active.el);
        active = null;
      }
      el = els[0];
      el.classList.add('on');
    } else {
      el = active && active.el === els[0] ? els[1] : els[0];
    }
    pending.el = el;
    el.muted = true;
    el.loop = target.loop; // looping in place; otherwise it ends where the next video or round takes over
    el.playbackRate = 1;
    el.src = srcFor(target.url);
    el.load();
  }

  // ---------- Keeping a single video in memory ----------

  // A single video plays round after round, each round loading it again. The browsers' own caches
  // are too small to keep a video, so each round would download it again over the Wi-Fi: download
  // it once into memory instead, and play the next rounds from there.
  function srcFor(url) {
    var k = kept[url];
    return k && k.blobUrl && !keepBroken ? k.blobUrl : url;
  }

  function keepVideos() {
    if (!schedule || typeof URL.createObjectURL !== 'function') return;
    var want = !keepBroken && schedule.list.length === 1 ? schedule.list[0].url : null;
    // Let go of videos that no longer play, once no element shows them.
    Object.keys(kept).forEach(function (url) {
      var k = kept[url];
      if (url === want || k.loading) return;
      if (k.blobUrl && els.some(function (el) { return el.getAttribute('src') === k.blobUrl; })) return;
      if (k.blobUrl) URL.revokeObjectURL(k.blobUrl);
      delete kept[url];
    });
    if (!want) return;
    var k = kept[want] || (kept[want] = { failures: 0, retryAt: 0 });
    // Not enough memory gives an error too: after a few, stream it as before.
    if (k.blobUrl || k.loading || k.failures >= 3 || performance.now() < k.retryAt) return;
    k.loading = true;
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, KEEP_TIMEOUT) : null;
    var t0 = performance.now();
    fetch(want, ctrl ? { signal: ctrl.signal } : {}).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.blob();
    }).then(function (blob) {
      k.blobUrl = URL.createObjectURL(blob);
      var s = (performance.now() - t0) / 1000;
      note('Kept ' + videoName(want) + ' in memory: ' + Math.round(blob.size / 1e6) + ' MB in ' + s.toFixed(1) + ' s (' +
        Math.round((blob.size * 8) / 1e6 / Math.max(s, 0.001)) + ' Mbit/s)');
    }).catch(function (err) {
      k.failures++;
      k.retryAt = performance.now() + 60000;
      note('Could not keep ' + videoName(want) + ' in memory (' + (err && (err.name === 'AbortError' ? 'took over ' + KEEP_TIMEOUT / 60000 + ' min' : err.message || err.name)) + ')', true);
    }).then(function () {
      clearTimeout(timer);
      k.loading = false;
    });
  }

  function unload(el) {
    el.classList.remove('on');
    el.pause();
    el.removeAttribute('src');
    el.load();
  }

  function advancePending() {
    var p = pending;
    var now = serverNow();
    var t = p.target;

    if (!p.el) {
      if (now >= t.startAt) {
        pending = null;
        if (active) {
          unload(active.el);
          active = null;
        }
      }
      return;
    }

    // The next round of the video on screen isn't loaded in time (a weak link, or still downloading
    // the first): go back to the start of the one on screen instead, as a single video used to loop.
    if (active && active.target.url === t.url && now > t.startAt + 500 && p.el.readyState < 3) {
      health.fallbacks++;
      note('Next round of ' + t.video + ' not loaded in time: looped the one on screen', true);
      unload(p.el);
      pending = null;
      active.target = t;
      active.learnAt = 0;
      stall = { time: -1, since: performance.now() };
      jump(active.el, expectedTime(active.el, t));
      var r = active.el.play();
      if (r && r.catch) r.catch(function () {});
      return;
    }

    if (active && now > t.startAt + LOAD_TIMEOUT) {
      // Some TVs can decode only one video at a time: stop the old one, then load the new one again.
      health.loadTimeouts++;
      note((t.video || 'Black screen') + ' not playing ' + LOAD_TIMEOUT / 1000 + ' s after its start: loading it again on its own', true);
      unload(active.el);
      active = null;
      prepare(t);
      return;
    }

    var el = p.el;
    if (!p.positioned) {
      if (el.readyState < 1) return; // waiting for the video's metadata
      if (now < t.startAt) {
        el.currentTime = 0;
        p.fromStart = true;
      } else {
        jump(el, expectedTime(el, t));
      }
      p.positioned = true;
      return;
    }
    if (p.started || el.seeking || now < p.retryAt) return;
    // Wait for enough data to play smoothly, but not forever.
    if (el.readyState < 3 && now < t.startAt + 3000) return;

    // Waiting at the beginning: press play early by as long as this TV takes to get going.
    var playAt = t.startAt - (p.fromStart ? startLead * 1000 : 0);
    if (now >= playAt - 10) {
      start(p);
    } else if (!p.timer) {
      p.timer = setTimeout(function () {
        if (pending === p) start(p);
      }, playAt - now);
    }
  }

  function start(p) {
    if (p.started) return;
    p.started = true;
    var result = p.el.play();
    if (result && result.catch) {
      result.catch(function (err) {
        if (pending !== p) return;
        p.started = false;
        p.timer = null;
        p.retryAt = serverNow() + 1000;
        lastError = err && err.name === 'NotAllowedError'
          ? 'The browser blocked autoplay. Press OK on the remote.'
          : 'Could not start the video';
      });
    }
  }

  // The new video is actually playing: cut to it.
  function promote(el) {
    var p = pending;
    pending = null;
    var old = active;
    var loading = ', loading took ' + ((performance.now() - p.preparedAt) / 1000).toFixed(1) + ' s';
    if (p.fromStart) {
      // A start this late shows (about 9 frames); smaller ones are caught up within a second or two.
      var late = Math.round(serverNow() - p.target.startAt);
      if (late > 300) health.lateStarts++;
      note('Started ' + p.target.video + (late > 300 ? ' ' + late + ' ms late' : ' on time (' + late + ' ms)') + loading, late > 300);
    } else {
      note('Joined ' + p.target.video + ' at ' + el.currentTime.toFixed(1) + ' s' + loading);
    }
    // Started from the beginning: measure how late it got going, once it has settled.
    active = { el: el, target: p.target, learnAt: p.fromStart ? performance.now() + 300 : 0 };
    el.classList.add('on');
    if (old && old.el !== el) unload(old.el);
    lastError = null;
    stall = { time: -1, since: performance.now() };
    applySound();
  }

  function applySound() {
    if (!active) return;
    active.el.muted = !wantSound || soundBlocked;
  }

  // Keep the active video at the same position as the server clock.
  function correctDrift() {
    if (!active || clockOffset === null) return;
    var el = active.el;
    var target = active.target;

    // A playlist's video that reached its end holds its last frame until the next one takes over.
    if (el.ended) return;

    if (el.paused) {
      // Most likely the browser refused to unmute without a key press, and paused the video.
      if (!el.muted) soundBlocked = true;
      el.muted = true;
      var r = el.play();
      if (r && r.catch) r.catch(function () {});
      return;
    }

    // A video that stops advancing (network hiccup, decoder trouble) gets reloaded at the right position.
    if (el.currentTime !== stall.time) {
      stall = { time: el.currentTime, since: performance.now() };
    } else if (performance.now() - stall.since > (el.seeking ? SEEK_TIMEOUT : STALL_TIMEOUT) && !pending) {
      health.stalls++;
      note(target.video + ' stalled at ' + el.currentTime.toFixed(1) + ' s' + (el.seeking ? ' while jumping' : '') + ': reloading it', true);
      lastError = 'Video stalled, reloading';
      prepare(active.target);
      return;
    }
    if (el.seeking || el.readyState < 2) return;

    var d = el.duration;
    var expected = expectedTime(el, target);
    // A playlist's video in its last moments: the next one is about to take over, don't correct.
    if (!target.loop && d > 0 && expected >= d - 0.1) return;
    var diff = el.currentTime - expected;
    if (target.loop && d > 0 && isFinite(d)) {
      if (diff > d / 2) diff -= d;
      else if (diff < -d / 2) diff += d;
    }
    drift = diff;

    // Learn how late this TV starts, so the next start presses play that much earlier. Half of
    // each measurement at a time, so one slow start doesn't throw the next one off.
    if (active.learnAt) {
      if (performance.now() < active.learnAt) return;
      active.learnAt = 0;
      if (Math.abs(diff) < 0.5) startLead = Math.min(1, Math.max(0, startLead - diff / 2));
    }

    // Far off: jump. Between jumps, only the speed changes, so a slow TV can't get stuck jumping.
    if (Math.abs(diff) > SEEK_THRESHOLD && performance.now() >= nextSeekAt) {
      el.playbackRate = 1;
      jump(el, expectedTime(el, target));
      return;
    }
    var rate = Math.abs(diff) < 0.015 ? 1 : Math.min(1 + MAX_RATE_NUDGE, Math.max(1 - MAX_RATE_NUDGE, 1 - diff));
    if (Math.abs(el.playbackRate - rate) > 0.005) el.playbackRate = rate;
  }

  function tick() {
    if (clockOffset === null) return;
    retarget(); // a playlist moves on to its next video by itself
    if (pending) advancePending();
  }

  els.forEach(function (el) {
    el.addEventListener('playing', function () {
      if (pending && pending.el === el) promote(el);
    });
    el.addEventListener('seeked', function () {
      if (!el.jumpStartedAt) return; // the loop going back to the start, not one of our jumps
      var took = (performance.now() - el.jumpStartedAt) / 1000;
      el.jumpStartedAt = 0;
      // Average with earlier jumps, so one unusually slow jump doesn't throw the next one off.
      seekLead = Math.min(3, Math.max(0.05, (seekLead + took) / 2));
    });
    el.addEventListener('error', function () {
      if (!el.getAttribute('src')) return; // unloaded on purpose
      var target = pending && pending.el === el ? pending.target : active && active.el === el ? active.target : null;
      if (!target) return;
      if (el.getAttribute('src').indexOf('blob:') === 0) {
        // This browser can't play a video from memory: stream it from the server.
        if (!keepBroken) note('This TV can\'t play a video from memory: streaming instead', true);
        keepBroken = true;
        if ((pending && pending.target === target) || (active && active.target === target && !pending)) prepare(target);
        return;
      }
      var err = el.error;
      var code = err ? err.code : 0;
      // A format the TV can't play won't fix itself: say so, and retry rarely instead of re-downloading every few seconds.
      var unplayable = code === 3 || code === 4;
      lastError = 'Can\'t play ' + target.video + ': ' + (MEDIA_ERRORS[code] || 'unknown error') +
        (err && err.message ? ' (' + err.message + ')' : '') +
        (unplayable ? '. Convert it with convert.sh.' : '. Retrying.');
      health.mediaErrors++;
      note(lastError, true);
      setTimeout(function () {
        var stillWanted = (pending && pending.target === target) || (active && active.target === target && !pending);
        if (stillWanted) prepare(target);
      }, unplayable ? 30000 : 3000);
    });
  });

  // ---------- Reporting to the control panel ----------

  // Frames dropped and shown in each of the last 10 reports: tells whether this TV plays smoothly.
  var frameLog = [];

  function sampleFrames(el) {
    if (!el || !el.getVideoPlaybackQuality) return;
    var q = el.getVideoPlaybackQuality();
    var prev = el.lastQuality || { dropped: 0, total: 0 };
    el.lastQuality = { dropped: q.droppedVideoFrames, total: q.totalVideoFrames };
    var total = q.totalVideoFrames - prev.total;
    if (total < 0) return; // the video was reloaded: its counters started again
    frameLog.push({ dropped: q.droppedVideoFrames - prev.dropped, total: total });
    if (frameLog.length > 10) frameLog.shift();
  }

  function droppedPercent() {
    var dropped = 0;
    var total = 0;
    frameLog.forEach(function (f) {
      dropped += f.dropped;
      total += f.total;
    });
    return total >= 30 ? Math.round((100 * dropped) / total) : 0;
  }

  function stateName() {
    // Loading a playlist's next video in the background, while one plays, still counts as playing.
    if (pending && pending.el && (!active || serverNow() >= pending.target.startAt)) return 'loading';
    if (!active) return 'black';
    return active.el.paused ? 'paused' : 'playing';
  }

  function report() {
    keepVideos();
    var el = active ? active.el : null;
    sampleFrames(el);
    var body = {
      screen: screenId,
      state: stateName(),
      video: active ? active.target.video : null,
      next: pending ? pending.target.video : null,
      time: el ? el.currentTime : 0,
      duration: el && isFinite(el.duration) ? el.duration : 0,
      drift: active ? Math.round(drift * 1000) : 0,
      seekMs: Math.round(seekLead * 1000),
      startMs: Math.round(startLead * 1000),
      dropped: droppedPercent(),
      sound: !!(el && !el.muted),
      soundBlocked: wantSound && soundBlocked,
      agent: navigator.userAgent,
      error: lastError,
      // What the browser sees of the display: shows at a glance a page that doesn't fill the TV.
      log: [
        'screen ' + screen.width + 'x' + screen.height +
        ', window ' + window.innerWidth + 'x' + window.innerHeight +
        ', outer ' + window.outerWidth + 'x' + window.outerHeight +
        ', pixel ratio ' + window.devicePixelRatio,
        'in memory: ' + (keepBroken ? 'not supported' : Object.keys(kept).map(function (url) {
          var k = kept[url];
          return videoName(url) + (k.blobUrl ? '' : k.loading ? ' (downloading)' : ' (failed ' + k.failures + 'x)');
        }).join(', ') || 'nothing'),
      ],
      page: pageId,
      up: Math.round(performance.now() / 1000),
      health: healthNow(el),
      events: notes.filter(function (e) { return e.n > notesSent; }),
    };
    // The reply is the current state: this is how commands reach TVs whose live connection holds events back.
    // One at a time: on a bad link, reports piling up would take the connections the video needs.
    if (!reportBusy) {
      reportBusy = true;
      var t0 = performance.now();
      var upTo = noteCount;
      fetchJson('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, 5000).then(function (s) {
        connected = true;
        health.ok++;
        health.rtt = Math.round(performance.now() - t0);
        notesSent = Math.max(notesSent, upTo);
        if (failedInARow) note('Server reachable again after ' + failedInARow + ' failed reports');
        failedInARow = 0;
        if (s && s.screens) onState(s);
      }).catch(function (err) {
        connected = false;
        health.failed++;
        failedInARow++;
        if (failedInARow === 1) {
          note('Lost the server: ' + (err && err.name === 'AbortError' ? 'no reply within 5 s' : 'no connection'), true);
        }
      }).then(function () {
        reportBusy = false;
      });
    }
    updateHint();
  }

  // The counters, plus how many seconds of video are loaded ahead and how much memory the page uses.
  function healthNow(el) {
    var h = {};
    for (var key in health) h[key] = health[key];
    h.buf = 0;
    try {
      for (var i = 0; el && i < el.buffered.length; i++) {
        if (el.buffered.start(i) <= el.currentTime + 0.1 && el.buffered.end(i) >= el.currentTime) {
          h.buf = Math.round((el.buffered.end(i) - el.currentTime) * 10) / 10;
        }
      }
    } catch (e) {
      // Not available on this TV.
    }
    if (performance.memory) h.heapMB = Math.round(performance.memory.usedJSHeapSize / 1e6);
    return h;
  }

  // ---------- On-screen messages ----------

  function updateHint() {
    var msg = '';
    if (!connected) msg = 'TV ' + screenId + ' · connecting to the control server…';
    else if (lastError) msg = 'TV ' + screenId + ' · ' + lastError;
    else if (wantSound && soundBlocked) msg = 'Press OK on the remote to turn the sound on';
    hint.textContent = msg;
    hint.className = msg ? 'show' : '';
  }

  function showOverlay(text, ms) {
    overlay.textContent = text;
    overlay.className = 'show';
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(function () { overlay.className = ''; }, ms);
  }

  // Any key press or click counts as permission for sound, and lets us go fullscreen.
  function onInteract() {
    soundBlocked = false;
    applySound();
    var root = document.documentElement;
    var request = root.requestFullscreen || root.webkitRequestFullscreen;
    if (request && !(document.fullscreenElement || document.webkitFullscreenElement)) {
      try {
        var r = request.call(root);
        if (r && r.catch) r.catch(function () {});
      } catch (e) {
        // Fullscreen not available here; the kiosk app handles it.
      }
    }
    updateHint();
  }
  ['keydown', 'click', 'touchstart'].forEach(function (type) {
    document.addEventListener(type, onInteract);
  });

  // ---------- Connection ----------

  // The live connection brings changes instantly; the reports bring them within a second if it fails.
  function connect() {
    var events = new EventSource('/api/events?role=player&screen=' + screenId);
    events.addEventListener('state', function (e) {
      onState(JSON.parse(e.data));
    });
    events.onopen = function () {
      syncClock(); // the server may have restarted
    };
    events.onerror = function () {
      health.liveErrors++;
      // Some TV browsers stop retrying after an error: open a new connection ourselves.
      if (events.readyState === 2) {
        events.close();
        setTimeout(connect, 3000);
      }
    };
  }

  showOverlay('TV ' + screenId, 3000);
  updateHint();
  note('Page loaded');
  syncClock().then(function () {
    connect();
    setInterval(tick, 50);
    setInterval(correctDrift, 250);
    setInterval(report, 1000);
    setInterval(syncClock, 30000);
  });
})();
