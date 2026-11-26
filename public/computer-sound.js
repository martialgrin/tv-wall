// "Sound on this computer": plays the sound of one chosen TV's video on the device showing the panel
// (for example the Mac, connected to a soundbar), locked to the same clock as the TVs.
// It plays only where someone clicked Play.
// Uses `state`, `events`, `$`, `esc`, `videoUrl` and `formatTime` from control.js.

(() => {
  const SEEK_THRESHOLD = 0.3;    // seconds off before jumping instead of nudging the speed
  const SEEK_LEAD = 0.1;         // jumps take a moment: aim a little ahead
  const SEEK_COOLDOWN = 3000;
  const MAX_RATE_NUDGE = 0.03;   // at most 3% faster or slower, so the sound stays natural

  const sourceSelect = $('#sound-source');
  const playButton = $('#sound-play');
  const volumeInput = $('#sound-volume');
  const delayInput = $('#sound-delay');
  const statusEl = $('#sound-status');

  // Settings for this device only.
  const saved = key => {
    try { return localStorage.getItem(`tvwall.sound.${key}`); } catch { return null; }
  };
  const save = (key, value) => {
    try { localStorage.setItem(`tvwall.sound.${key}`, value); } catch { /* kept until the page reloads */ }
  };

  let source = saved('source') || ''; // a TV number, or '' (off)
  let playing = false;                // Play was clicked
  let blocked = false;                // the browser wants a click before playing sound
  let clockOffset = null;             // server time = performance.now() + clockOffset
  let volume = Number(saved('volume') ?? 1);
  // One sound per video and start time: TVs showing the same thing together are heard once, not as an echo.
  const players = new Map(); // key -> { audio, target, tvs, nextSeekAt, jumpNow, drift }

  volumeInput.value = volume;
  delayInput.value = Number(saved('delay') || 0);

  const delay = () => Math.max(0, Number(delayInput.value) || 0) / 1000;
  const serverNow = () => performance.now() + clockOffset;

  // Same method as the TVs: the fastest of a few round trips.
  async function syncClock() {
    let best = null;
    for (let i = 0; i < 6; i++) {
      try {
        const t0 = performance.now();
        const data = await (await fetch('/api/time', { cache: 'no-store' })).json();
        const t1 = performance.now();
        if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: data.now - (t0 + t1) / 2 };
      } catch {
        // Try again on the next sync.
      }
    }
    if (best) clockOffset = best.offset;
  }

  // What a TV plays, by the same rules as the TV page: the shared video, or its own videos one after another.
  function scheduleOf(id) {
    const s = state.screens[id];
    const shared = state.mode === 'all' && !s.keep;
    const names = shared ? [state.all.video] : s.playlist || [s.video];
    return { names: names.filter(Boolean), list: tvwallSchedule.items(names, state.videos), startAt: shared ? state.all.startAt : s.startAt };
  }

  // What should be heard here: the chosen TV's video now, plus its next one when it starts within
  // 2 s (it loads ahead and waits for its start). One entry per video and start time.
  function wanted() {
    if (!source || !state || !state.screens[source]) return [];
    const { list, startAt } = scheduleOf(source);
    const now = clockOffset === null ? Date.now() : serverNow();
    const byKey = new Map();
    for (const seg of [tvwallSchedule.segmentAt(list, startAt, now), tvwallSchedule.segmentAt(list, startAt, now + 2000)]) {
      if (!seg.url) continue;
      const key = `${seg.url}@${seg.startAt}`;
      if (!byKey.has(key)) byKey.set(key, { key, video: seg.video, url: seg.url, startAt: seg.startAt, loop: seg.loop, tvs: [source] });
    }
    return [...byKey.values()];
  }

  function newAudio() {
    const audio = document.createElement('audio');
    audio.className = 'sound-audio';
    audio.preload = 'auto';
    audio.loop = true;
    audio.hidden = true;
    audio.volume = volume;
    document.body.append(audio);
    return audio;
  }

  // Follow the TVs: a new video loads, a restart of the same video only moves the position.
  function retarget() {
    const targets = wanted();
    const unclaimed = new Map(players);
    const next = new Map();
    for (const t of targets) {
      let p = unclaimed.get(t.key);
      if (!p && t.loop) {
        // Same single video restarted: reuse its sound, which is already loaded.
        const reuse = [...unclaimed.entries()].find(([, q]) => q.target.url === t.url && q.target.loop);
        if (reuse) {
          p = reuse[1];
          unclaimed.delete(reuse[0]);
          p.jumpNow = true;
        }
      } else {
        unclaimed.delete(t.key);
      }
      if (!p) {
        p = { audio: newAudio(), nextSeekAt: 0, jumpNow: false, drift: 0 };
        p.audio.src = t.url;
        p.audio.load();
        if (playing && !blocked) start(p);
      }
      p.target = t;
      p.tvs = t.tvs;
      p.audio.loop = t.loop; // otherwise it ends where the next video, or the next round, takes over
      next.set(t.key, p);
    }
    for (const p of unclaimed.values()) {
      p.audio.pause();
      p.audio.removeAttribute('src');
      p.audio.load();
      p.audio.remove();
    }
    players.clear();
    for (const [k, p] of next) players.set(k, p);
    updateButton();
  }

  function fillSources() {
    if (source && !state.screens[source]) source = '';
    const options = [['', 'Off']]
      .concat(Object.keys(state.screens).map(id => [id, `TV ${id} · ${scheduleOf(id).names.join(' → ') || 'black screen'}`]));
    const html = options.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
    if (sourceSelect.innerHTML !== html) sourceSelect.innerHTML = html;
    sourceSelect.value = source;
  }

  // "Stop" while sound plays; "Play" when stopped, or when the browser is waiting for a click.
  function updateButton() {
    const on = playing && !blocked;
    playButton.textContent = on ? 'Stop' : 'Play';
    playButton.setAttribute('aria-pressed', String(on));
    playButton.disabled = !source;
  }

  async function start(p) {
    try {
      await p.audio.play();
      blocked = false;
    } catch (err) {
      if (err && err.name === 'NotAllowedError') blocked = true;
    }
    updateButton();
  }

  function startAll() {
    blocked = false;
    for (const p of players.values()) {
      p.nextSeekAt = 0;
      start(p); // inside a click, so the browser allows sound
    }
  }

  function stopAll() {
    for (const p of players.values()) p.audio.pause();
  }

  // Only one tab of this browser plays: the same sound from two tabs, a moment apart, sounds like a drone.
  const otherTabs = 'BroadcastChannel' in window ? new BroadcastChannel('tvwall-sound') : null;
  let stoppedByOtherTab = false;

  function setPlaying(on) {
    playing = on;
    stoppedByOtherTab = false;
    save('playing', on ? '1' : '');
    if (on) {
      startAll();
      if (otherTabs) otherTabs.postMessage('playing');
    } else {
      stopAll();
    }
    updateButton();
    renderStatus();
  }

  if (otherTabs) {
    otherTabs.onmessage = () => {
      if (!playing) return;
      playing = false;
      stoppedByOtherTab = true;
      stopAll();
      updateButton();
      renderStatus();
    };
  }

  // Keep each sound at the same point as its TVs, every quarter of a second.
  function tick(p) {
    const audio = p.audio;
    if (audio.readyState < 1 || audio.seeking) return;
    // Before its start time (the shared start, or a playlist's next video): wait at the beginning.
    if (serverNow() + delay() * 1000 < p.target.startAt) {
      if (!audio.paused) audio.pause();
      if (audio.currentTime !== 0) audio.currentTime = 0;
      return;
    }
    // A playlist's video that reached its end stays silent until the next one takes over.
    if (audio.ended) return;
    if (audio.paused) {
      if (!blocked) {
        start(p);
        p.jumpNow = true; // starting takes a moment: move to the exact point once it plays
      }
      return;
    }
    const d = audio.duration;
    const loop = p.target.loop && d > 0 && isFinite(d);
    // Where the sound should be, sent early by the soundbar's delay so it's heard in time with the picture.
    const elapsed = Math.max(0, (serverNow() - p.target.startAt) / 1000 + delay());
    const expected = loop ? elapsed % d : elapsed;
    // A playlist's video in its last moments: the next one is about to take over, don't correct.
    if (!p.target.loop && d > 0 && expected >= d - 0.1) return;
    let diff = audio.currentTime - expected;
    if (loop) {
      if (diff > d / 2) diff -= d;
      else if (diff < -d / 2) diff += d;
    }
    p.drift = diff;
    if ((p.jumpNow && Math.abs(diff) > 0.02) || (Math.abs(diff) > SEEK_THRESHOLD && performance.now() >= p.nextSeekAt)) {
      p.jumpNow = false;
      p.nextSeekAt = performance.now() + SEEK_COOLDOWN;
      audio.playbackRate = 1;
      audio.currentTime = loop ? (expected + SEEK_LEAD) % d : expected + SEEK_LEAD;
      return;
    }
    p.jumpNow = false;
    const rate = Math.abs(diff) < 0.02 ? 1 : Math.min(1 + MAX_RATE_NUDGE, Math.max(1 - MAX_RATE_NUDGE, 1 - diff));
    if (Math.abs(audio.playbackRate - rate) > 0.002) audio.playbackRate = rate;
  }

  function tickAll() {
    if (!playing || clockOffset === null) return;
    retarget(); // a playlist moves on to its next video by itself
    for (const p of players.values()) tick(p);
  }

  function describe(p) {
    const tvs = p.tvs.length > 1 ? `TVs ${p.tvs.join(', ')}` : `TV ${p.tvs[0]}`;
    if (serverNow() + delay() * 1000 < p.target.startAt) return `next: ${p.target.video}`;
    if (p.audio.paused || p.audio.readyState < 2) return `Starting ${p.target.video} (${tvs})…`;
    const ms = Math.round(Math.abs(p.drift) * 1000);
    return `${p.target.video} (${tvs}) · ${formatTime(p.audio.currentTime)} / ${formatTime(p.audio.duration)} · ` +
      (ms <= 40 ? 'in sync' : `${ms} ms off, correcting`);
  }

  function renderStatus() {
    let text;
    if (!source) text = 'Off. Choose a TV to hear its sound on this computer.';
    else if (!players.size) text = `TV ${source} shows a black screen: no sound.`;
    else if (!playing) text = stoppedByOtherTab ? 'Stopped: another tab of this browser plays the sound now.' : 'Ready. Click Play.';
    else if (blocked) text = 'The browser needs a click before playing sound: click Play.';
    else text = `Playing ${[...players.values()].map(describe).join(' · ')}`;
    if (statusEl.textContent !== text) statusEl.textContent = text;
  }

  sourceSelect.addEventListener('change', () => {
    source = sourceSelect.value;
    save('source', source);
    retarget();
    if (!source) setPlaying(false);
    else if (playing) startAll(); // the change is a click, so the browser allows sound
    renderStatus();
  });

  playButton.addEventListener('click', () => {
    setPlaying(!playing || blocked); // a click while blocked starts the sound
  });

  volumeInput.addEventListener('input', () => {
    volume = Number(volumeInput.value);
    save('volume', volume);
    for (const p of players.values()) p.audio.volume = volume;
  });

  delayInput.addEventListener('change', () => {
    save('delay', delay() * 1000);
    for (const p of players.values()) p.jumpNow = true; // move to the new position right away
  });

  events.addEventListener('state', () => {
    fillSources();
    retarget();
  });

  // After a reload, play again if it was playing; the browser may want a click first.
  if (saved('playing') && source) playing = true;
  updateButton();

  syncClock().then(() => {
    setInterval(tickAll, 250);
    setInterval(renderStatus, 500);
    setInterval(syncClock, 30000);
  });
})();
