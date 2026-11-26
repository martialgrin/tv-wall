// TV Wall control panel: choose what each TV plays and watch their status live.

const $ = (selector, root = document) => root.querySelector(selector);

const SPEAKER_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/></svg>';
const SPEAKER_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/></svg>';
const ROTATE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>';
const THUMB_HTML ='<span class="thumb"><img alt="" hidden><span class="empty">Black screen</span><span class="badge"></span><span class="progress"><i></i></span></span>';

let state = null;
let videosKey = '';
const cards = new Map(); // screen id -> its elements

const screensEl = $('#screens');
const libraryEl = $('#library');
const allSelect = $('#all-video');

// ---------- Helpers ----------

function esc(text) {
  return String(text).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function formatSize(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function videoUrl(name) {
  const video = state.videos.find(v => v.name === name);
  return video ? `/videos/${encodeURIComponent(name)}?v=${video.version}` : null;
}

// Whether a TV plays the shared video: in "Same video on all TVs" mode, unless it keeps its own.
function followsAll(id) {
  return state.mode === 'all' && !state.screens[id].keep;
}

// The videos a TV plays one after another: the shared one in "Same video" mode, else its own playlist.
function playlistOf(id) {
  const s = state.screens[id];
  if (followsAll(id)) return state.all.video ? [state.all.video] : [];
  return s.playlist || (s.video ? [s.video] : []);
}

// The video a TV shows now: its report says which, while it's online; otherwise the first of its list.
function assigned(id) {
  const list = playlistOf(id);
  const st = state.status && state.status[id];
  if (list.length > 1 && st && st.online && list.includes(st.video)) return st.video;
  return list[0] || null;
}

// The Mac's network name when it has one: it stays the same when the network hands out a new address.
function host() {
  if (state.server.name) return state.server.name;
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname);
  return local ? state.server.addresses[0] || location.hostname : location.hostname;
}

function tvUrl(id) {
  return `http://${host()}:${state.server.port}/${id}`;
}

let toastTimer;
function toast(message, kind = 'error') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
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
    toast(err.message);
  }
}

// ---------- Thumbnails ----------
// Made one at a time in the browser: many <video> previews at once would use up
// the browser's few connections to the server and block the controls.

const thumbCache = new Map(); // url -> Promise<{ image, duration }>
const thumbQueue = [];
let thumbBusy = false;

function loadThumb(url) {
  if (!thumbCache.has(url)) {
    thumbCache.set(url, new Promise(resolve => {
      thumbQueue.push({ url, resolve });
      pumpThumbs();
    }));
  }
  return thumbCache.get(url);
}

function pumpThumbs() {
  if (thumbBusy || !thumbQueue.length) return;
  thumbBusy = true;
  const { url, resolve } = thumbQueue.shift();
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  let done = false;
  const finish = result => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    video.removeAttribute('src');
    video.load();
    resolve(result);
    thumbBusy = false;
    pumpThumbs();
  };
  const timer = setTimeout(() => finish({ image: null, duration: 0 }), 15000);
  video.addEventListener('loadedmetadata', () => {
    video.currentTime = Math.min(1, video.duration / 2 || 0.1);
  });
  video.addEventListener('seeked', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 384;
    canvas.height = Math.round((384 * video.videoHeight) / video.videoWidth) || 216;
    let image = null;
    try {
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      image = canvas.toDataURL('image/jpeg', 0.75);
    } catch {
      // Codec the browser can't draw; the tile just stays blank.
    }
    finish({ image, duration: video.duration });
  });
  video.addEventListener('error', () => finish({ image: null, duration: 0 }));
  video.src = url;
}

function setThumb(thumb, url) {
  if (thumb.dataset.url === (url || '')) return;
  thumb.dataset.url = url || '';
  const img = $('img', thumb);
  const empty = $('.empty', thumb);
  img.hidden = true;
  empty.hidden = false;
  empty.textContent = url ? '' : 'Black screen';
  if (!url) return;
  loadThumb(url).then(({ image }) => {
    if (thumb.dataset.url !== url) return;
    if (image) {
      img.src = image;
      img.hidden = false;
      empty.hidden = true;
    } else {
      empty.textContent = 'No preview';
    }
  });
}

// ---------- Rendering ----------

function fillOptions(select) {
  select.innerHTML = '';
  select.append(new Option('Black screen', ''));
  for (const v of state.videos) select.append(new Option(v.name, v.name));
}

function fillAddOptions(select) {
  select.innerHTML = '';
  select.append(new Option('+ Add a video…', ''));
  for (const v of state.videos) select.append(new Option(v.name, v.name));
}

// A TV's own videos, numbered in the order it plays them; the one on screen now is highlighted.
function renderPlaylist(id, c) {
  const own = state.screens[id].playlist || [];
  const locked = followsAll(id);
  const now = assigned(id);
  const html = own.length
    ? own.map((name, i) => `<span class="item${!locked && own.length > 1 && name === now ? ' now' : ''}">` +
        `<span class="n">${i + 1}</span>${esc(name)}` +
        `<button type="button" data-index="${i}" aria-label="Remove ${esc(name)} from TV ${esc(id)}"${locked ? ' disabled' : ''}>×</button></span>`).join('')
    : '<span class="none">Black screen</span>';
  if (c.playlist.innerHTML !== html) c.playlist.innerHTML = html;
  c.playlist.classList.toggle('locked', locked);
  c.select.disabled = locked;
  c.select.title = locked ? 'Switch to "Expo", or tick "Keep its own videos", to change this TV\'s videos' : '';
}

function buildCard(id) {
  const card = document.createElement('article');
  card.className = 'screen';
  card.innerHTML = `
    <header>
      <span class="dot"></span>
      <h3>TV ${id}</h3>
      <button type="button" class="rotate" title="Turn the picture on TV ${id} a quarter turn clockwise">${ROTATE_ICON}<span>0°</span></button>
      <button type="button" class="sound" aria-pressed="false" title="Sound on TV ${id}"></button>
    </header>
    ${THUMB_HTML}
    <div class="playlist" aria-label="Videos on TV ${id}, played one after another"></div>
    <select class="add" aria-label="Add a video to TV ${id}"></select>
    <label class="option" title="In &quot;Same video on all TVs&quot; mode, this TV keeps playing its own videos (listed above) instead of the shared one.">
      <input type="checkbox" class="keep"> Keep its own videos
    </label>
    <label class="option" title="For TVs that can play only one video at a time, such as Samsung signage displays. Switching then pauses briefly instead of cutting straight to the next video.">
      <input type="checkbox" class="one-video"> One video at a time
    </label>
    <p class="status"></p>`;
  const c = {
    card,
    dot: $('.dot', card),
    sound: $('.sound', card),
    rotate: $('.rotate', card),
    thumb: $('.thumb', card),
    badge: $('.badge', card),
    bar: $('.progress i', card),
    playlist: $('.playlist', card),
    select: $('select.add', card),
    keep: $('input.keep', card),
    oneVideo: $('input.one-video', card),
    status: $('.status', card),
  };
  c.sound.addEventListener('click', () => {
    command({ type: 'sound', screen: id, sound: c.sound.getAttribute('aria-pressed') !== 'true' });
  });
  c.rotate.addEventListener('click', () => {
    command({ type: 'rotate', screen: id, rotation: ((state.screens[id].rotation || 0) + 90) % 360 });
  });
  // The TV's own videos: add one at the end of the list, or remove one with its ×.
  c.select.addEventListener('change', () => {
    if (!c.select.value) return;
    command({ type: 'playlist', screen: id, videos: [...(state.screens[id].playlist || []), c.select.value] });
    c.select.value = '';
  });
  c.playlist.addEventListener('click', e => {
    const remove = e.target.closest('button[data-index]');
    if (!remove) return;
    const videos = [...(state.screens[id].playlist || [])];
    videos.splice(Number(remove.dataset.index), 1);
    command({ type: 'playlist', screen: id, videos });
  });
  c.oneVideo.addEventListener('change', () => command({ type: 'oneVideo', screen: id, oneVideo: c.oneVideo.checked }));
  c.keep.addEventListener('change', () => command({ type: 'keep', screen: id, keep: c.keep.checked }));
  return c;
}

function render() {
  for (const b of document.querySelectorAll('[data-mode]')) {
    b.setAttribute('aria-checked', String(b.dataset.mode === state.mode));
  }
  $('#all-panel').hidden = state.mode !== 'all';

  const key = state.videos.map(v => `${v.name}:${v.version}`).join('|');
  const videosChanged = key !== videosKey;
  videosKey = key;
  if (videosChanged) {
    fillOptions(allSelect);
    renderLibrary();
  }
  allSelect.value = state.all.video || '';

  for (const id of Object.keys(state.screens)) {
    let c = cards.get(id);
    if (!c) {
      c = buildCard(id);
      cards.set(id, c);
      screensEl.append(c.card);
    }
    if (videosChanged || !c.select.options.length) fillAddOptions(c.select);
    renderPlaylist(id, c);
    const url = assigned(id) ? videoUrl(assigned(id)) : null;
    setThumb(c.thumb, url);
    const sound = Boolean(state.screens[id].sound);
    c.sound.setAttribute('aria-pressed', String(sound));
    c.sound.innerHTML = sound ? SPEAKER_ON : SPEAKER_OFF;
    // The preview turns with the TV, so it shows what the screen displays.
    const rotation = state.screens[id].rotation || 0;
    $('span', c.rotate).textContent = `${rotation}°`;
    c.rotate.setAttribute('aria-label', `Rotate TV ${id}, now ${rotation}°`);
    c.rotate.classList.toggle('active', rotation !== 0);
    c.thumb.dataset.rotation = rotation;
    c.oneVideo.checked = Boolean(state.screens[id].oneVideo);
    c.keep.checked = Boolean(state.screens[id].keep);
    c.card.classList.toggle('kept', state.mode === 'all' && Boolean(state.screens[id].keep));
  }
  for (const [id, c] of cards) {
    if (!state.screens[id]) {
      c.card.remove();
      cards.delete(id);
    }
  }

  // The phone remote's master switch: speaker icons stay as they are, but every TV is silent.
  $('#sound-master').hidden = state.soundOn !== false;

  renderLibraryUsage();
  renderAddresses();
  renderStatus();
}

function renderLibrary() {
  libraryEl.innerHTML = '';
  if (!state.videos.length) {
    libraryEl.innerHTML = '<div class="empty-state">No videos yet. Put MP4 files in the <code>videos</code> folder next to <code>server.js</code>. They appear here automatically.</div>';
    return;
  }
  for (const v of state.videos) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    tile.dataset.name = v.name;
    tile.title = `Play ${v.name} on all TVs`;
    tile.innerHTML = `${THUMB_HTML}<span class="meta"><span class="name">${esc(v.name)}</span><span class="info">${formatSize(v.size)}</span><span class="where"></span></span>`;
    const url = videoUrl(v.name);
    setThumb($('.thumb', tile), url);
    loadThumb(url).then(({ duration }) => {
      if (duration) $('.info', tile).textContent = `${formatTime(duration)} · ${formatSize(v.size)}`;
    });
    tile.addEventListener('click', () => command({ type: 'all', video: v.name }));
    libraryEl.append(tile);
  }
}

function renderLibraryUsage() {
  for (const tile of libraryEl.querySelectorAll('.tile')) {
    const name = tile.dataset.name;
    const ids = Object.keys(state.screens).filter(id => playlistOf(id).includes(name));
    const onAll = state.mode === 'all' && state.all.video === name;
    const kept = Object.keys(state.screens).filter(id => state.mode === 'all' && !followsAll(id) && !playlistOf(id).includes(name));
    tile.classList.toggle('current', onAll);
    $('.where', tile).textContent = onAll
      ? kept.length ? `On all TVs except TV ${kept.join(', ')}` : 'Playing on all TVs'
      : ids.length ? `On TV ${ids.join(', ')}` : '';
  }
}

function renderStatus() {
  let online = 0;
  for (const [id, c] of cards) {
    const s = state.status[id] || {};
    // A TV playing several videos: its preview and highlighted video follow what it reports.
    if (playlistOf(id).length > 1) {
      renderPlaylist(id, c);
      setThumb(c.thumb, assigned(id) ? videoUrl(assigned(id)) : null);
    }
    let dot = 'bad';
    let badge = '';
    let pct = 0;
    const lines = [];

    if (!s.online) {
      badge = 'Offline';
      lines.push(`Open <a href="${esc(tvUrl(id))}" target="_blank">${esc(tvUrl(id))}</a> on this TV`);
    } else {
      online++;
      dot = 'ok';
      if (s.state === 'loading') {
        badge = 'Switching';
        lines.push(`Loading ${esc(s.next || 'black screen')}…`);
      } else if (s.state === 'black') {
        badge = 'Black';
        lines.push('Black screen');
      } else if (s.state === 'paused') {
        dot = 'warn';
        badge = 'Paused';
        lines.push('<span class="warn">Paused</span>');
      } else {
        pct = s.duration ? (100 * s.time) / s.duration : 0;
        const drift = Math.abs(s.drift);
        const sync = drift <= 40
          ? 'in sync'
          : `<span class="${drift > 250 ? 'bad' : 'warn'}">${drift} ms off, correcting</span>`;
        // A few dropped frames go unnoticed; more means the TV (or its Raspberry Pi) can't keep up.
        const dropped = s.dropped >= 2
          ? ` · <span class="${s.dropped >= 10 ? 'bad' : 'warn'}">${s.dropped}% frames dropped</span>`
          : '';
        // With several videos, say which one is on screen now.
        const which = playlistOf(id).length > 1 && s.video ? `${esc(s.video)} · ` : '';
        lines.push(`${which}${formatTime(s.time)} / ${formatTime(s.duration)} · ${sync}${dropped}`);
      }
      if (s.soundBlocked) {
        dot = 'warn';
        lines.push('<span class="warn">Sound blocked: press OK on the TV remote</span>');
      }
      if (s.error) {
        dot = 'warn';
        lines.push(`<span class="bad">${esc(s.error)}</span>`);
      }
    }
    const devices = s.devices || [];
    if (devices.length > 1) {
      lines.push(`<span class="warn">Open on ${devices.length} devices (${devices.map(esc).join(', ')}): close the extra ones, their reports mix</span>`);
    }

    // A single video is kept in memory on the TV, so its rounds don't use the Wi-Fi.
    const memory = (s.log || []).find(line => line.startsWith('in memory: '));

    c.dot.className = `dot ${dot}`;
    c.dot.title = devices.length
      ? `Connected from ${devices.join(', ')}${s.seekMs ? `\nJumps take about ${s.seekMs} ms` : ''}${s.startMs ? `\nStarts take about ${s.startMs} ms` : ''}${memory ? `\nVideo in memory: ${memory.slice('in memory: '.length)}` : ''}${s.agent ? `\n${s.agent}` : ''}`
      : 'Not connected';
    c.badge.textContent = badge;
    c.bar.style.width = `${Math.min(100, pct)}%`;
    const html = lines.join('<br>');
    if (c.status.innerHTML !== html) c.status.innerHTML = html;
  }
  $('#online-count').textContent = `${online} / ${cards.size} online`;
}

function renderAddresses() {
  const el = $('#addresses');
  const ids = Object.keys(state.screens);
  let html = `<div><span>Control panel</span><a href="http://${esc(host())}:${state.server.port}/" target="_blank">http://${esc(host())}:${state.server.port}/</a></div>`;
  html += `<div><span>Phone remote</span><a href="http://${esc(host())}:${state.server.port}/remote" target="_blank">http://${esc(host())}:${state.server.port}/remote</a></div>`;
  html += ids.map(id => `<div><span>TV ${id}</span><a href="${esc(tvUrl(id))}" target="_blank">${esc(tvUrl(id))}</a></div>`).join('');
  const others = state.server.addresses.filter(a => a !== host());
  if (others.length && state.server.name) {
    html += `<span class="note">If a device can't open these, use the address instead of the name: ${others.map(a => esc(`http://${a}:${state.server.port}/`)).join(', ')} (it can change when the Mac reconnects).</span>`;
  } else if (others.length) {
    html += `<span class="note">This computer also has the address ${others.map(esc).join(', ')}. Use the one on the same network as the TVs.</span>`;
  }
  if (el.innerHTML !== html) el.innerHTML = html;
}

// ---------- Controls ----------

for (const b of document.querySelectorAll('[data-mode]')) {
  b.addEventListener('click', () => {
    if (state && state.mode !== b.dataset.mode) command({ type: 'mode', mode: b.dataset.mode });
  });
}

const confirmations = {
  identify: 'Showing each number on its TV',
  reload: 'Reloading the page on every TV',
};
for (const b of document.querySelectorAll('[data-cmd]')) {
  b.addEventListener('click', async () => {
    await command({ type: b.dataset.cmd });
    if (confirmations[b.dataset.cmd]) toast(confirmations[b.dataset.cmd], 'info');
  });
}

allSelect.addEventListener('change', () => command({ type: 'all', video: allSelect.value }));
$('#sound-master-on').addEventListener('click', () => command({ type: 'soundOn', on: true }));

// ---------- Live connection ----------

function setConnected(ok) {
  const el = $('#conn');
  el.textContent = ok ? 'Connected' : 'Server not reachable, retrying…';
  el.classList.toggle('ok', ok);
  document.body.classList.toggle('disconnected', !ok); // statuses below are stale until we reconnect
}

const events = new EventSource('/api/events?role=control');
events.addEventListener('state', e => {
  state = JSON.parse(e.data);
  render();
});
events.addEventListener('status', e => {
  if (!state) return;
  state.status = JSON.parse(e.data);
  renderStatus();
});
events.onopen = () => setConnected(true);
events.onerror = () => setConnected(false);
