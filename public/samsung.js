// NOT USED: the wall now plays on Raspberry Pis (README, section 3). Kept for reference.
//
// TV Wall player for Samsung signage displays, run by the TV Wall app (samsung/app).
// Same job as player.js, but through Samsung's own video player (AVPlay): the display's
// browser can't decode portrait video at full speed and freezes for seconds on every jump.
// These displays have one video decoder, so only one video is ever open.
// The app loads this file from the server at every start: edit it here, then "Reload TVs".
// Plain ES5 for the display's browser engine (Chrome 56).

(function () {
  'use strict';

  var JUMP_BEHIND = 0.3;   // seconds behind the others before jumping ahead (AVPlay can't play faster)
  var HOLD_AHEAD = 0.08;   // seconds ahead before pausing a moment to let the others catch up
  var MAX_HOLD = 3;        // further ahead than this: jump instead of pausing
  var CONFIRM = 3;         // act only when this many fresh positions in a row agree
  var SEEK_COOLDOWN = 3000;
  var LEARN_AFTER = 700;   // ms after a jump or start before judging where it landed
  var STALL_TIMEOUT = 10000;
  var RETRY_DELAY = 5000;
  var ROTATIONS = {
    0: 'PLAYER_DISPLAY_ROTATION_NONE',
    90: 'PLAYER_DISPLAY_ROTATION_90',
    180: 'PLAYER_DISPLAY_ROTATION_180',
    270: 'PLAYER_DISPLAY_ROTATION_270'
  };

  var cfg = window.TVWALL || {};
  var server = cfg.server || '';
  var screenId = String(cfg.screen || '1');
  var av = window.webapis && window.webapis.avplay;
  document.title = 'TV ' + screenId;

  var clockOffset = null; // server time = performance.now() + clockOffset
  var versions = {};
  var lastRev = 0;
  var signals = null;
  var targetKey = null;
  var target = null;      // what the server wants on screen: { video, url, startAt }
  var player = null;      // the open video: { target, token, duration, started, lastT, learn, learnFrom }
  var loadToken = 0;
  var busy = false;       // a jump is running: AVPlay accepts no other call until it ends
  var holding = false;    // paused on purpose, waiting for the others
  var retryTimer = null;
  var nextSeekAt = 0;
  var behind = 0;
  var ahead = 0;
  var drift = 0;
  var rotation = 0;
  var displayDirty = false;
  var wantSound = false;
  var muted = null;
  var lastError = null;
  var connected = false;
  var stall = { time: -1, since: 0 };
  var lines = [];
  var overlayTimer = null;

  // How long this display takes to jump, and to start playing: learned, and kept across restarts.
  var seekLead = readNumber('tvwall.seekLead', 1);
  var startLead = readNumber('tvwall.startLead', 0.2);
  var resumeLead = readNumber('tvwall.resumeLead', 0.1);

  // ---------- Small helpers ----------

  function readNumber(key, fallback) {
    try {
      var v = parseFloat(localStorage.getItem(key));
      return isFinite(v) ? v : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function saveLeads() {
    try {
      localStorage.setItem('tvwall.seekLead', String(seekLead));
      localStorage.setItem('tvwall.startLead', String(startLead));
      localStorage.setItem('tvwall.resumeLead', String(resumeLead));
    } catch (e) { /* learned again next time */ }
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function describe(err) {
    if (!err) return 'unknown error';
    if (typeof err === 'string') return err;
    return ((err.name || '') + ' ' + (err.message || '')).trim() || String(err);
  }

  // Recent events go to the server with each report: the only way to see what happens on the display.
  function log(text) {
    var d = new Date();
    lines.push(pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + ' ' + text);
    if (lines.length > 40) lines.shift();
    try { console.log('[tvwall] ' + text); } catch (e) { /* no console */ }
  }

  window.addEventListener('error', function (e) {
    log('script error: ' + e.message + ' (line ' + e.lineno + ')');
  });

  // ---------- On-screen text (the video itself is on a layer below the page) ----------

  var style = document.createElement('style');
  style.textContent =
    '#tvwall-stage{position:absolute;left:50%;top:50%;width:1920px;height:1080px;margin:-540px 0 0 -960px;pointer-events:none}' +
    '.rot-90 #tvwall-stage,.rot-270 #tvwall-stage{width:1080px;height:1920px;margin:-960px 0 0 -540px}' +
    '.rot-90 #tvwall-stage{transform:rotate(90deg)}' +
    '.rot-180 #tvwall-stage{transform:rotate(180deg)}' +
    '.rot-270 #tvwall-stage{transform:rotate(270deg)}' +
    '#tvwall-overlay{position:absolute;left:0;right:0;top:50%;margin-top:-160px;text-align:center;' +
    'font-size:260px;font-weight:bold;line-height:320px;text-shadow:0 0 40px #000;opacity:0;transition:opacity .3s}' +
    '#tvwall-overlay.show{opacity:1}' +
    '#tvwall-hint{position:absolute;left:40px;right:40px;bottom:40px;text-align:center;font-size:30px;text-shadow:0 2px 6px #000}';
  document.head.appendChild(style);
  var stage = document.createElement('div');
  stage.id = 'tvwall-stage';
  stage.innerHTML = '<div id="tvwall-overlay"></div><div id="tvwall-hint"></div>';
  document.body.appendChild(stage);
  var overlay = document.getElementById('tvwall-overlay');
  var hint = document.getElementById('tvwall-hint');

  function showOverlay(text, ms) {
    overlay.textContent = text;
    overlay.className = 'show';
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(function () { overlay.className = ''; }, ms);
  }

  function updateHint() {
    var msg = '';
    if (!connected) msg = 'TV ' + screenId + ' · connecting to the TV Wall server…';
    else if (lastError) msg = 'TV ' + screenId + ' · ' + lastError;
    hint.textContent = msg;
  }

  // ---------- Clock ----------

  function serverNow() {
    return performance.now() + clockOffset;
  }

  // Estimate the server clock from the fastest of a few round trips.
  function syncClock() {
    var best = null;
    var i = 0;
    function next() {
      if (i++ >= 6) {
        if (best) clockOffset = best.offset;
        return Promise.resolve();
      }
      var t0 = performance.now();
      return fetch(server + '/api/time', { cache: 'no-store' })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          var t1 = performance.now();
          if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: data.now - (t0 + t1) / 2 };
        }, function () { /* try again on the next sync */ })
        .then(next);
    }
    return next();
  }

  // Where the video should be right now, looping since its start time.
  function expected() {
    var elapsed = Math.max(0, (serverNow() - player.target.startAt) / 1000);
    var d = player.duration;
    return d > 0 ? elapsed % d : elapsed;
  }

  // ---------- Following the server ----------

  // The same state arrives over the live connection and in replies to reports: keep the newest.
  function onState(s) {
    if (s.rev < lastRev) return;
    lastRev = s.rev;
    onSignals(s.signals);
    versions = {};
    s.videos.forEach(function (v) { versions[v.name] = v.version; });
    var own = s.screens[screenId];
    if (!own) {
      lastError = 'TV ' + screenId + ' does not exist on the server (red A button: settings)';
      return;
    }
    var a = s.mode === 'all' && !own.keep ? s.all : own; // a kept TV stays on its own video
    wantSound = !!own.sound;
    applySound();
    var rot = Number(own.rotation) || 0;
    if (rot !== rotation) {
      rotation = rot;
      displayDirty = true;
      document.body.className = rot ? 'rot-' + rot : '';
    }

    var url = a.video && versions[a.video] !== undefined
      ? server + '/videos/' + encodeURIComponent(a.video) + '?v=' + versions[a.video]
      : null;
    var key = url + '@' + a.startAt;
    if (key === targetKey) return;
    targetKey = key;
    target = { video: url ? a.video : null, url: url, startAt: a.startAt };
    // One decoder: stop the current video now and load the next, so it can start with the others.
    // A black screen waits for its start time instead (see tick).
    if (url) open(target);
  }

  // "Identify TVs" and "Reload TVs" arrive as the time of the last click.
  function onSignals(next) {
    if (!next) return;
    var seen = signals;
    signals = next;
    if (!seen) return; // first state since loading: those clicks are old
    if (next.reload > seen.reload) location.reload();
    else if (next.identify > seen.identify) showOverlay('TV ' + screenId, 5000);
  }

  // ---------- Samsung video player ----------

  function getState() {
    try { return av.getState(); } catch (e) { return 'NONE'; }
  }

  function close() {
    if (!av) return;
    try { av.stop(); } catch (e) { /* already stopped */ }
    try { av.close(); } catch (e) { /* already closed */ }
  }

  function open(t) {
    var token = ++loadToken;
    clearTimeout(retryTimer);
    close();
    busy = false;
    holding = false;
    behind = ahead = 0;
    player = { target: t, token: token, duration: 0, started: false, lastT: -1, learn: null, learnFrom: 0 };
    stall = { time: -1, since: performance.now() };
    if (!av) {
      lastError = 'Samsung video player (AVPlay) not available';
      return;
    }
    log('open ' + t.video);
    try {
      av.open(t.url);
      av.setListener(listener(token));
      applyDisplay();
      av.prepareAsync(function () {
        if (token !== loadToken) return;
        player.duration = av.getDuration() / 1000;
        log('ready: ' + t.video + ', ' + player.duration.toFixed(1) + ' s');
        begin(token);
      }, function (err) {
        if (token === loadToken) fail('Could not load ' + t.video, err);
      });
    } catch (e) {
      fail('Could not open ' + t.video, e);
    }
  }

  // Start at the shared start time, early by however long this display takes to get going.
  function begin(token) {
    var wait = player.target.startAt - serverNow() - startLead * 1000;
    if (wait > 0) {
      setTimeout(function () {
        if (token === loadToken) play('start');
      }, wait);
    } else {
      jump(); // joining late: jump to where the others are, then play
    }
  }

  function play(reason) {
    try {
      av.play();
      if (!player.started) {
        player.started = true;
        lastError = null;
      }
      if (reason === 'start') learnFrom('start');
      log('play (' + reason + ')');
    } catch (e) {
      fail('Could not play ' + player.target.video, e);
    }
  }

  // The next fresh position after a jump or a start shows how early to aim next time.
  function learnFrom(kind) {
    player.learn = kind;
    player.learnFrom = performance.now();
  }

  // Jump to where the others will be once the jump is done.
  function jump() {
    var p = player;
    var d = p.duration;
    var to = expected() + seekLead;
    if (d > 0) to = to % d;
    busy = true;
    behind = ahead = 0;
    nextSeekAt = performance.now() + SEEK_COOLDOWN;
    var t0 = performance.now();
    log('jump to ' + to.toFixed(2) + ' s (aiming ' + seekLead.toFixed(2) + ' s ahead)');

    function done(ok, err) {
      if (p !== player) return;
      busy = false;
      log(ok ? 'jumped in ' + ((performance.now() - t0) / 1000).toFixed(2) + ' s' : 'jump failed: ' + describe(err));
      var state = getState();
      if (state === 'READY' || state === 'PAUSED') play('after jump');
      if (!p.started) p.started = true;
      learnFrom('jump');
    }

    try {
      av.seekTo(Math.round(to * 1000), function () { done(true); }, function (err) { done(false, err); });
    } catch (e) {
      done(false, e);
    }
  }

  // Ahead of the others: pause just long enough for them to catch up, minus the time resuming takes.
  function hold(seconds) {
    var p = player;
    holding = true;
    ahead = 0;
    log('ahead by ' + seconds.toFixed(2) + ' s: pausing');
    try {
      av.pause();
    } catch (e) {
      holding = false;
      return;
    }
    setTimeout(function () {
      if (p !== player) return;
      holding = false;
      try {
        av.play();
        learnFrom('pause');
      } catch (e) {
        log('resume failed: ' + describe(e));
      }
    }, Math.max(0, seconds - resumeLead) * 1000);
  }

  function applyDisplay() {
    if (!av) return;
    displayDirty = false;
    try {
      av.setDisplayRect(0, 0, 1920, 1080);
      av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
    } catch (e) {
      log('display area not set: ' + describe(e));
    }
    try {
      av.setDisplayRotation(ROTATIONS[rotation] || ROTATIONS[0]);
      // Rotation moves the coordinate origin, so the area is set again afterwards.
      av.setDisplayRect(0, 0, 1920, 1080);
    } catch (e) {
      log('rotation not applied: ' + describe(e));
    }
  }

  function applySound() {
    if (muted === !wantSound) return;
    muted = !wantSound;
    try {
      tizen.tvaudiocontrol.setMute(muted);
    } catch (e) {
      log('sound not changed: ' + describe(e));
    }
  }

  function listener(token) {
    function mine() { return token === loadToken; }
    return {
      onbufferingstart: function () { if (mine()) log('buffering'); },
      onbufferingcomplete: function () { if (mine()) log('buffered'); },
      onstreamcompleted: function () {
        if (!mine()) return;
        // Normally the loop jump happens just before the end; this catches the case where it didn't.
        log('reached the end');
        if (!busy) jump();
      },
      onevent: function (type, data) { if (mine()) log('event ' + type + (data ? ' ' + data : '')); },
      onerror: function (type) { if (mine()) fail('Samsung player error', type); }
    };
  }

  function fail(message, err) {
    lastError = message + ': ' + describe(err);
    log(lastError);
    var p = player;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(function () {
      if (p === player && target === p.target) open(p.target);
    }, RETRY_DELAY);
  }

  // ---------- Keeping in sync ----------

  function tick() {
    if (clockOffset === null) return;
    // Black screen: close the video at its start time.
    if (target && !target.url && player && serverNow() >= target.startAt) {
      loadToken++;
      close();
      player = null;
      log('black screen');
    }
    if (player && player.started && !busy && !holding) check();
  }

  function check() {
    if (displayDirty) applyDisplay();
    var state = getState();
    if (state === 'PAUSED' || state === 'READY') {
      play('was ' + state.toLowerCase());
      return;
    }
    if (state !== 'PLAYING') return;

    var t;
    try { t = av.getCurrentTime() / 1000; } catch (e) { return; }
    var now = performance.now();
    // The position only counts when it has moved: the player reports it in steps.
    if (t === player.lastT) {
      if (now - stall.since > STALL_TIMEOUT) {
        lastError = 'Video stalled, reloading';
        log(lastError);
        open(player.target);
      }
      return;
    }
    player.lastT = t;
    stall = { time: t, since: now };

    var d = player.duration;
    var exp = expected();
    var diff = t - exp;
    if (d > 0) {
      if (diff > d / 2) diff -= d;
      else if (diff < -d / 2) diff += d;
    }
    drift = diff;

    if (player.learn && now - player.learnFrom > LEARN_AFTER) {
      if (Math.abs(diff) < 3) {
        if (player.learn === 'jump') seekLead = clamp(seekLead - diff * 0.8, 0.05, 5);
        else if (player.learn === 'start') startLead = clamp(startLead - diff * 0.8, 0, 2);
        else resumeLead = clamp(resumeLead - diff * 0.8, 0, 1);
        log('landed ' + Math.round(diff * 1000) + ' ms off after ' + player.learn + ': leads now ' +
          seekLead.toFixed(2) + ' s (jump), ' + startLead.toFixed(2) + ' s (start), ' + resumeLead.toFixed(2) + ' s (pause)');
        saveLeads();
      }
      player.learn = null;
    }

    // Loop: once a jump started now would land in the next play-through, jump there.
    if (d > 0 && exp + seekLead >= d && t > d / 2) {
      log('loop');
      jump();
      return;
    }

    behind = diff < -JUMP_BEHIND ? behind + 1 : 0;
    ahead = diff > HOLD_AHEAD ? ahead + 1 : 0;
    if (behind >= CONFIRM && now >= nextSeekAt) {
      log('behind by ' + (-diff).toFixed(2) + ' s');
      jump();
    } else if (ahead >= CONFIRM) {
      if (diff <= MAX_HOLD) hold(diff);
      else if (now >= nextSeekAt) jump();
    }
  }

  // ---------- Reporting to the control panel ----------

  function report() {
    var time = 0;
    var state = 'black';
    if (player) {
      if (!busy) {
        try { time = av.getCurrentTime() / 1000; } catch (e) { time = 0; }
      } else {
        time = Math.max(0, player.lastT);
      }
      state = !player.started ? 'loading' : holding || busy ? 'playing' : getState() === 'PAUSED' ? 'paused' : 'playing';
    }
    var body = {
      screen: screenId,
      state: state,
      video: player && player.started ? player.target.video : null,
      next: player && !player.started ? player.target.video : null,
      time: time,
      duration: player ? player.duration : 0,
      drift: player && player.started ? Math.round(drift * 1000) : 0,
      seekMs: Math.round(seekLead * 1000),
      sound: muted === false,
      soundBlocked: false,
      agent: navigator.userAgent + ' TVWallApp/' + (cfg.shell || 0) + ' AVPlay',
      error: lastError,
      log: lines.slice(-25)
    };
    // Plain text avoids a permission round trip; the reply is the current state.
    fetch(server + '/api/report', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) })
      .then(function (res) { return res.json(); })
      .then(function (s) {
        connected = true;
        if (s && s.screens) onState(s);
      })
      .catch(function () { connected = false; });
    updateHint();
  }

  // The live connection brings changes instantly; the reports bring them within a second if it fails.
  function connect() {
    var events = new EventSource(server + '/api/events?role=player&screen=' + screenId);
    events.addEventListener('state', function (e) {
      onState(JSON.parse(e.data));
    });
    events.onopen = function () {
      syncClock(); // the server may have restarted
    };
    events.onerror = function () {
      if (events.readyState === 2) {
        events.close();
        setTimeout(connect, 3000);
      }
    };
  }

  // ---------- Start ----------

  log('player started: TV ' + screenId + ', server ' + server + ', leads ' + seekLead.toFixed(2) +
    ' s (jump), ' + startLead.toFixed(2) + ' s (start), ' + resumeLead.toFixed(2) + ' s (pause)');
  showOverlay('TV ' + screenId, 3000);
  updateHint();
  try {
    webapis.appcommon.setScreenSaver(webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF);
  } catch (e) { /* not available */ }

  syncClock().then(function () {
    connect();
    setInterval(tick, 250);
    setInterval(report, 1000);
    setInterval(syncClock, 30000);
  });
})();
