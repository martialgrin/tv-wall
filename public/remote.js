// TV Wall phone remote (/remote): the few controls needed during an exhibition, sized for an iPhone.
// Sound on/off for all the TVs, which TVs play sound, Expo (each TV its own video), the same video
// on every TV, or the show (the same videos in turn, then Expo), and a restart. Uses the same live
// connection and commands as the full control panel.

(() => {
  const $ = selector => document.querySelector(selector);
  const SPEAKER_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/></svg>';
  const SPEAKER_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/></svg>';

  const soundButton = $('#sound');
  const soundHint = $('#sound-hint');
  const chipsEl = $('#sound-tvs');
  const modeHint = $('#mode-hint');
  const videosEl = $('#videos');

  let state = null;
  let videosKey = '';
  let events = null;
  let clockSkew = 0; // the server's clock minus the phone's

  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // Where the show is now, as any TV following it plays it.
  function showNow() {
    const follower = Object.keys(state.screens).find(id => !state.screens[id].keep);
    const plan = follower ? tvwallSchedule.plan(state, follower) : null;
    if (!plan || !plan.shared) return 'waiting for the videos';
    const seg = tvwallSchedule.at(plan, Date.now() + clockSkew);
    const left = formatTime((seg.phaseEnd - Date.now() - clockSkew) / 1000);
    return seg.phase === 'videos'
      ? `now ${seg.video} (${seg.index + 1} of ${plan.shared.length}), Expo in ${left}`
      : `now Expo, videos again in ${left}`;
  }

  const esc = text => String(text).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  const tvList = ids => (ids.length > 1 ? `TVs ${ids.join(', ')}` : `TV ${ids[0]}`);

  let toastTimer;
  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.className = 'toast show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 3000);
  }

  async function command(cmd) {
    try {
      const res = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cmd),
      });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    } catch (err) {
      toast(err.message || 'The TV Wall server is not reachable');
    }
  }

  // ---------- Rendering ----------

  function online(id) {
    return Boolean(state.status && state.status[id] && state.status[id].online);
  }

  function renderOnline() {
    const ids = Object.keys(state.screens);
    const count = ids.filter(online).length;
    $('#conn').textContent = `${count} / ${ids.length} TVs`;
    for (const chip of chipsEl.children) chip.classList.toggle('offline', !online(chip.dataset.id));
  }

  function renderSound() {
    const on = state.soundOn !== false;
    const ids = Object.keys(state.screens);
    const withSound = ids.filter(id => state.screens[id].sound);
    soundButton.setAttribute('aria-pressed', String(on));
    soundButton.querySelector('.icon').innerHTML = on ? SPEAKER_ON : SPEAKER_OFF;
    soundButton.querySelector('.label').textContent = on ? 'Sound on' : 'Sound off';
    if (!on) soundHint.textContent = 'All TVs are silent. Tap to turn the sound on.';
    else if (!withSound.length) soundHint.textContent = 'No TV plays sound: tap a number below.';
    else soundHint.textContent = `Sound from ${tvList(withSound)}. Tap a number to change.`;
    if (chipsEl.children.length !== ids.length) {
      chipsEl.innerHTML = ids.map(id => `<button type="button" data-id="${esc(id)}" aria-label="Sound on TV ${esc(id)}">${esc(id)}</button>`).join('');
    }
    for (const chip of chipsEl.children) {
      chip.setAttribute('aria-pressed', String(Boolean(state.screens[chip.dataset.id] && state.screens[chip.dataset.id].sound)));
    }
  }

  function renderMode() {
    for (const b of document.querySelectorAll('[data-mode]')) {
      b.setAttribute('aria-checked', String(b.dataset.mode === state.mode));
    }
    const kept = Object.keys(state.screens).filter(id => state.screens[id].keep);
    const except = kept.length ? `, except ${tvList(kept)}, which keeps its own videos` : '';
    if (state.mode === 'all') modeHint.textContent = `Every TV plays ${state.all.video || 'nothing'}${except}. Tap Expo to go back.`;
    else if (state.mode === 'show') modeHint.textContent = `Show: every TV plays the same videos in turn, then Expo for ${state.show.expoMinutes} min, and again${except}. Now: ${showNow()}.`;
    else modeHint.textContent = 'Expo: each TV plays its own videos.';
  }

  function renderVideos() {
    const key = state.videos.map(v => `${v.name}:${v.version}`).join('|');
    if (key !== videosKey) {
      videosKey = key;
      videosEl.innerHTML = state.videos.length
        ? state.videos.map(v => `
          <button type="button" class="tile" data-name="${esc(v.name)}">
            <span class="pic"><img alt="" loading="lazy" src="/thumbs/${encodeURIComponent(v.name)}?v=${v.version}" onerror="this.remove()"></span>
            <span class="name">${esc(v.name)}</span>
          </button>`).join('')
        : '<p class="empty">No videos yet: add some to the videos folder on the Mac.</p>';
    }
    // The video playing on every TV is marked; in Expo, none is.
    for (const tile of videosEl.querySelectorAll('.tile')) {
      const current = state.mode === 'all' && state.all.video === tile.dataset.name;
      tile.classList.toggle('current', current);
      const badge = tile.querySelector('.badge');
      if (current && !badge) tile.querySelector('.pic').insertAdjacentHTML('beforeend', '<span class="badge">On all TVs</span>');
      if (!current && badge) badge.remove();
    }
  }

  function render() {
    renderSound();
    renderMode();
    renderVideos();
    renderOnline();
  }

  // ---------- Controls ----------

  soundButton.addEventListener('click', () => {
    if (state) command({ type: 'soundOn', on: state.soundOn === false });
  });

  chipsEl.addEventListener('click', e => {
    const chip = e.target.closest('button[data-id]');
    if (!chip || !state) return;
    const id = chip.dataset.id;
    command({ type: 'sound', screen: id, sound: !state.screens[id].sound });
    // Turning a TV's sound on while everything is off would do nothing: turn everything on too.
    if (!state.screens[id].sound && state.soundOn === false) command({ type: 'soundOn', on: true });
  });

  for (const b of document.querySelectorAll('[data-mode]')) {
    b.addEventListener('click', () => {
      if (state && state.mode !== b.dataset.mode) command({ type: 'mode', mode: b.dataset.mode });
    });
  }

  videosEl.addEventListener('click', e => {
    const tile = e.target.closest('.tile');
    if (tile) command({ type: 'all', video: tile.dataset.name });
  });

  $('#restart').addEventListener('click', () => command({ type: 'restart' }));

  // ---------- Live connection ----------

  function setConnected(ok) {
    $('#conn').classList.toggle('ok', ok);
    if (!ok) $('#conn').textContent = 'Not connected';
    document.body.classList.toggle('offline', !ok);
  }

  function connect() {
    if (events) events.close();
    events = new EventSource('/api/events?role=control');
    events.addEventListener('state', e => {
      state = JSON.parse(e.data);
      clockSkew = state.now - Date.now();
      setConnected(true);
      render();
    });
    events.addEventListener('status', e => {
      if (!state) return;
      state.status = JSON.parse(e.data);
      renderOnline();
    });
    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
  }

  // An iPhone drops the connection when the screen locks: reconnect when the remote is back in view.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!events || events.readyState !== 1)) connect();
  });

  setInterval(() => {
    if (state && state.mode === 'show') renderMode();
  }, 1000);

  connect();
})();
