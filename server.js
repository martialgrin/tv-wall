// TV Wall: plays one video per TV, or the same video on every TV, in sync.
// No dependencies. Run `node server.js` and open the URLs it prints.

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT) || 3000;
const SCREEN_COUNT = Number(process.env.SCREENS) || 8;
const VIDEOS_DIR = path.resolve(process.env.VIDEOS_DIR || path.join(__dirname, 'videos'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATE_FILE = path.join(__dirname, 'state.json');
const THUMBS_DIR = path.join(__dirname, 'thumbs');
const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find(f => fs.existsSync(f)) || 'ffmpeg';
// Every change starts this far in the future, so all TVs can buffer and then start together.
const START_DELAY = Number(process.env.START_DELAY) || 1500;
// A TV that has not reported for this long is shown as offline.
const REPORT_TIMEOUT = 5000;

const VIDEO_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const screenIds = Array.from({ length: SCREEN_COUNT }, (_, i) => String(i + 1));

// ---------- Videos ----------

function listVideos() {
  let names;
  try {
    names = fs.readdirSync(VIDEOS_DIR);
  } catch {
    return [];
  }
  const videos = [];
  for (const name of names) {
    if (name.startsWith('.') || !VIDEO_TYPES[path.extname(name).toLowerCase()]) continue;
    try {
      const st = fs.statSync(path.join(VIDEOS_DIR, name));
      // The version changes when a file is replaced, so TVs never play a stale cached copy.
      const version = Math.round(st.mtimeMs);
      if (st.isFile()) videos.push({ name, size: st.size, version, duration: duration(name, version) });
    } catch {
      // The file disappeared between readdir and stat.
    }
  }
  return videos.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// Each video's exact length, measured once with ffprobe. Every TV schedules its playlist with these
// same numbers, so TVs playing the same playlist switch videos at the same moment.
const durations = new Map(); // "name:version" -> seconds; null while measuring, 0 if unknown
const FFPROBE = path.join(path.dirname(FFMPEG), 'ffprobe');

function duration(name, version) {
  const key = `${name}:${version}`;
  if (!durations.has(key)) {
    durations.set(key, null);
    const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(VIDEOS_DIR, name)];
    execFile(fs.existsSync(FFPROBE) ? FFPROBE : 'ffprobe', args, { timeout: 15000 }, (err, stdout) => {
      const seconds = parseFloat(stdout);
      durations.set(key, !err && seconds > 0 ? seconds : 0);
      if (seconds > 0) {
        changed();
        broadcast('state', snapshot());
      }
    });
  }
  return durations.get(key) || null;
}

function serveVideo(req, res, encodedName) {
  let name;
  try {
    name = path.basename(decodeURIComponent(encodedName));
  } catch {
    return sendJson(res, 400, { error: 'Bad file name' });
  }
  const file = path.join(VIDEOS_DIR, name);
  const type = VIDEO_TYPES[path.extname(name).toLowerCase()];
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return sendJson(res, 404, { error: 'Video not found' });
  }
  if (!type || !st.isFile()) return sendJson(res, 404, { error: 'Video not found' });

  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400',
    'Last-Modified': st.mtime.toUTCString(),
  };
  let start = 0;
  let end = st.size - 1;
  let status = 200;

  // Video players ask for byte ranges so they can seek and stream without downloading everything.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    if (range[1] === '') {
      start = Math.max(0, st.size - Number(range[2]));
    } else {
      start = Number(range[1]);
      if (range[2] !== '') end = Math.min(Number(range[2]), st.size - 1);
    }
    if ((range[1] === '' && range[2] === '') || start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }

  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  pipeline(fs.createReadStream(file, { start, end }), res, () => {});
}

// ---------- Thumbnails ----------

// One picture per video for the remote, taken with ffmpeg at 1 s and kept in thumbs/ until the video
// changes. Made one at a time, so opening the remote doesn't start several ffmpeg at once.
let thumbQueue = Promise.resolve();
const thumbJobs = new Map(); // thumbnail file -> Promise

function makeThumb(videoFile, thumbFile, name) {
  if (!thumbJobs.has(thumbFile)) {
    const job = thumbQueue.then(() => new Promise((resolve, reject) => {
      fs.mkdirSync(THUMBS_DIR, { recursive: true });
      const partial = `${thumbFile}.part.jpg`;
      const args = ['-v', 'error', '-ss', '1', '-i', videoFile, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', '-y', partial];
      execFile(FFMPEG, args, { timeout: 20000 }, err => {
        if (err) {
          fs.rm(partial, { force: true }, () => {});
          return reject(err);
        }
        fs.renameSync(partial, thumbFile);
        // Pictures of earlier versions of this video are no longer needed.
        for (const f of fs.readdirSync(THUMBS_DIR)) {
          if (f.startsWith(`${name}.`) && path.join(THUMBS_DIR, f) !== thumbFile && /\.\d+\.jpg$/.test(f)) {
            fs.rm(path.join(THUMBS_DIR, f), { force: true }, () => {});
          }
        }
        resolve();
      });
    }));
    thumbQueue = job.catch(() => {});
    thumbJobs.set(thumbFile, job);
    job.catch(() => thumbJobs.delete(thumbFile)); // try again next time
  }
  return thumbJobs.get(thumbFile);
}

function serveThumb(res, encodedName) {
  let name;
  try {
    name = path.basename(decodeURIComponent(encodedName));
  } catch {
    return sendJson(res, 400, { error: 'Bad file name' });
  }
  const video = listVideos().find(v => v.name === name);
  if (!video) return sendJson(res, 404, { error: 'Video not found' });
  const thumbFile = path.join(THUMBS_DIR, `${name}.${video.version}.jpg`);
  const send = () => {
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
    pipeline(fs.createReadStream(thumbFile), res, () => {});
  };
  if (fs.existsSync(thumbFile)) return send();
  makeThumb(path.join(VIDEOS_DIR, name), thumbFile, name)
    .then(send, () => sendJson(res, 404, { error: 'No picture for this video (is ffmpeg installed?)' }));
}

// ---------- State ----------

function emptyState() {
  const screens = {};
  // playlist: the TV's own videos, played one after another (video: the first one, for older pages).
  // keep: in "Same video on all TVs" mode, this TV keeps playing its own videos.
  for (const id of screenIds) {
    screens[id] = { video: null, playlist: [], startAt: 0, sound: false, rotation: 0, oneVideo: false, keep: false };
  }
  // soundOn: the remote's master switch. Off silences every TV; on, the TVs whose speaker is on play sound.
  return { mode: 'individual', soundOn: true, all: { video: null, startAt: 0 }, screens };
}

function loadState() {
  const loaded = emptyState();
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    // First run: give each TV its own video, in order.
    fillInOrder(loaded, Date.now() + START_DELAY);
    return loaded;
  }
  if (saved.mode === 'all' || saved.mode === 'individual') loaded.mode = saved.mode;
  if (typeof saved.soundOn === 'boolean') loaded.soundOn = saved.soundOn;
  if (saved.all) Object.assign(loaded.all, saved.all);
  for (const id of screenIds) {
    if (saved.screens && saved.screens[id]) Object.assign(loaded.screens[id], saved.screens[id]);
    const s = loaded.screens[id];
    // Saved before playlists existed: the single video becomes a playlist of one.
    if (!Array.isArray(s.playlist)) s.playlist = s.video ? [s.video] : [];
    s.video = s.playlist[0] || null;
  }
  return loaded;
}

function setPlaylist(screen, videos) {
  screen.playlist = videos;
  screen.video = videos[0] || null;
}

let saveTimer;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n', err => {
      if (err) console.error('Could not save state:', err.message);
    });
  }, 200);
}

function fillInOrder(target, startAt) {
  const videos = listVideos();
  target.mode = 'individual';
  screenIds.forEach((id, i) => {
    setPlaylist(target.screens[id], videos.length ? [videos[i % videos.length].name] : []);
    target.screens[id].startAt = startAt;
  });
}

function restartAll(startAt) {
  state.all.startAt = startAt;
  for (const id of screenIds) state.screens[id].startAt = startAt;
}

function applyCommand(cmd) {
  const startAt = Date.now() + START_DELAY;
  const names = listVideos().map(v => v.name);
  const checkVideo = video => {
    if (video === null || video === undefined || video === '') return null; // black screen
    if (!names.includes(video)) throw new Error(`Unknown video: ${video}`);
    return video;
  };
  const checkScreen = id => {
    if (!state.screens[String(id)]) throw new Error(`Unknown screen: ${id}`);
    return String(id);
  };

  switch (cmd.type) {
    case 'mode': // { mode: 'individual' | 'all' }
      if (cmd.mode !== 'individual' && cmd.mode !== 'all') throw new Error('Mode must be "individual" or "all"');
      state.mode = cmd.mode;
      if (cmd.mode === 'all' && !state.all.video && names.length) state.all.video = names[0];
      restartAll(startAt);
      break;
    case 'screen': { // { screen, video }: one TV gets a single video of its own
      const id = checkScreen(cmd.screen);
      const video = checkVideo(cmd.video);
      setPlaylist(state.screens[id], video ? [video] : []);
      state.screens[id].startAt = startAt;
      break;
    }
    case 'playlist': { // { screen, videos: [...] }: one TV plays these videos one after another
      const id = checkScreen(cmd.screen);
      if (!Array.isArray(cmd.videos)) throw new Error('videos must be a list');
      setPlaylist(state.screens[id], cmd.videos.map(checkVideo).filter(Boolean));
      state.screens[id].startAt = startAt;
      break;
    }
    case 'all': // { video }: the same video on every TV
      state.all = { video: checkVideo(cmd.video), startAt };
      state.mode = 'all';
      break;
    case 'fill': // TV 1 plays video 1, TV 2 plays video 2…
      fillInOrder(state, startAt);
      break;
    case 'restart': // every TV back to the beginning, together
      restartAll(startAt);
      break;
    case 'soundOn': // { on }: master switch for all the TVs' sound
      state.soundOn = Boolean(cmd.on);
      break;
    case 'sound': // { screen, sound }
      state.screens[checkScreen(cmd.screen)].sound = Boolean(cmd.sound);
      break;
    case 'rotate': { // { screen, rotation }: turn the picture on one TV, for screens mounted sideways
      const id = checkScreen(cmd.screen);
      const rotation = Number(cmd.rotation);
      if (![0, 90, 180, 270].includes(rotation)) throw new Error('Rotation must be 0, 90, 180 or 270');
      state.screens[id].rotation = rotation;
      break;
    }
    case 'rotateAll': // turn every TV a quarter turn clockwise
      for (const id of screenIds) state.screens[id].rotation = (state.screens[id].rotation + 90) % 360;
      break;
    case 'oneVideo': // { screen, oneVideo }: for TVs with a single video decoder, such as Samsung signage
      state.screens[checkScreen(cmd.screen)].oneVideo = Boolean(cmd.oneVideo);
      break;
    case 'keep': // { screen, keep }: this TV keeps its own video when every other TV plays the same one
      state.screens[checkScreen(cmd.screen)].keep = Boolean(cmd.keep);
      break;
    case 'identify': // show each TV's number on its screen
      signals.identify = Date.now();
      broadcast('identify', {}, c => c.role === 'player'); // for TV pages opened before signals existed
      break;
    case 'reload': // reload the player page on every TV
      signals.reload = Date.now();
      broadcast('reload', {}, c => c.role === 'player');
      break;
    default:
      throw new Error(`Unknown command: ${cmd.type}`);
  }
  console.log(`Command: ${JSON.stringify(cmd)}`);
  saveState();
  changed();
  broadcast('state', snapshot());
}

// Raised on every change, so a TV can drop an older copy of the state that arrives late.
let rev = Date.now();
function changed() {
  rev = Math.max(Date.now(), rev + 1);
}

// When "Identify TVs" and "Reload TVs" were last clicked. They travel inside the state,
// so they reach every TV even when its live connection doesn't work.
const signals = { identify: 0, reload: 0 };

// ---------- TV status ----------

const reports = {}; // latest report from each TV
const reporters = {}; // TV number -> { address: time of its last report }

// Each TV reports once a second. The reply carries the current state, so a TV gets every
// command within a second even when its live connection fails (some TV browsers hold events back).
function handleReport(body, req) {
  const id = String(body.screen);
  if (!state.screens[id]) throw new Error(`Unknown screen: ${id}`);
  const from = remoteAddress(req);
  (reporters[id] = reporters[id] || {})[from] = Date.now();
  const error = body.error ? String(body.error).slice(0, 200) : null;
  if (error && (!reports[id] || reports[id].error !== error)) {
    console.log(`TV ${id} (${from}): ${error}`);
  }
  reports[id] = {
    state: String(body.state || ''),
    video: body.video || null,
    next: body.next || null,
    time: Number(body.time) || 0,
    duration: Number(body.duration) || 0,
    drift: Number(body.drift) || 0,
    seekMs: Number(body.seekMs) || 0,
    startMs: Number(body.startMs) || 0,
    dropped: Number(body.dropped) || 0, // % of frames dropped over the last 10 s
    sound: Boolean(body.sound),
    soundBlocked: Boolean(body.soundBlocked),
    agent: String(body.agent || '').slice(0, 300),
    // Recent player events (the Samsung app sends them): the only way to see what happens on a display.
    log: Array.isArray(body.log) ? body.log.slice(-40).map(line => String(line).slice(0, 200)) : undefined,
    error,
    at: Date.now(),
  };
  return snapshot();
}

function screenStatus(id) {
  // Addresses of the devices showing this TV number; more than one means their reports mix.
  const now = Date.now();
  const seen = reporters[id] || {};
  const devices = Object.keys(seen).filter(address => now - seen[address] < REPORT_TIMEOUT);
  const report = reports[id];
  const online = Boolean(report) && now - report.at < REPORT_TIMEOUT;
  return { ...report, online, devices };
}

function allStatus() {
  return Object.fromEntries(screenIds.map(id => [id, screenStatus(id)]));
}

function snapshot() {
  return {
    now: Date.now(),
    rev,
    signals,
    mode: state.mode,
    soundOn: state.soundOn,
    all: state.all,
    screens: state.screens,
    videos: listVideos(),
    status: allStatus(),
    server: { port: PORT, addresses: localAddresses(), name: networkName() },
  };
}

// ---------- Live updates (Server-Sent Events) ----------

const clients = new Set();

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data, filter) {
  for (const c of clients) if (!filter || filter(c)) send(c.res, event, data);
}

function openEvents(req, res, url) {
  const role = url.searchParams.get('role') === 'player' ? 'player' : 'control';
  const screen = url.searchParams.get('screen');
  if (role === 'player' && !state.screens[screen]) {
    return sendJson(res, 404, { error: `Unknown screen: ${screen}` });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  const from = remoteAddress(req);
  const client = { res, role, screen, from };
  clients.add(client);
  send(res, 'state', snapshot());
  if (role === 'player') console.log(`TV ${screen} connected from ${from}`);
  req.on('close', () => {
    clients.delete(client);
    if (role === 'player') console.log(`TV ${screen} disconnected (${from})`);
  });
}

function remoteAddress(req) {
  return String(req.socket.remoteAddress).replace(/^::ffff:/, '');
}

// Keep idle connections open, and push TV status to the control panels once a second.
setInterval(() => {
  for (const c of clients) c.res.write(': keep-alive\n\n');
}, 15000);
setInterval(() => broadcast('status', allStatus(), c => c.role === 'control'), 1000);

// ---------- HTTP ----------

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readJson(req, res, handler) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 100000) req.destroy();
  });
  req.on('end', () => {
    try {
      const reply = handler(body ? JSON.parse(body) : {}, req);
      sendJson(res, 200, reply || { ok: true });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  });
}

function serveStatic(req, res, name) {
  const file = path.join(PUBLIC_DIR, name);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'Not found' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ---------- Samsung app (not used: the wall now plays on Raspberry Pis, README section 3) ----------

// Samsung signage installs apps from "Home → URL Launcher Settings → Install Web App": given
// http://<mac>:3000/samsung, the display reads sssp_config.xml there, then downloads <name>.wgt.
// The signed .wgt comes from samsung/build.sh (samsung/TVWall.wgt) or from VS Code's
// "Tizen TV: Build Signed Package" run on samsung/app (samsung/app/TVWall.wgt): the newest wins.
const SAMSUNG_APP = 'TVWall';
const SAMSUNG_DIR = path.join(__dirname, 'samsung');
const NOT_BUILT = 'The Samsung app is not signed and built yet (README, section 3b)';

function samsungPackage() {
  let newest = null;
  for (const file of [path.join(SAMSUNG_DIR, `${SAMSUNG_APP}.wgt`), path.join(SAMSUNG_DIR, 'app', `${SAMSUNG_APP}.wgt`)]) {
    try {
      const st = fs.statSync(file);
      if (!newest || st.mtimeMs > newest.st.mtimeMs) newest = { file, st };
    } catch {
      // Not built this way.
    }
  }
  return newest;
}

function serveSamsungConfig(res) {
  const pkg = samsungPackage();
  if (!pkg) {
    console.log(`  → ${NOT_BUILT}`);
    return sendJson(res, 404, { error: NOT_BUILT });
  }
  const size = pkg.st.size;
  let version = '1.0.0';
  try {
    const config = fs.readFileSync(path.join(SAMSUNG_DIR, 'app', 'config.xml'), 'utf8');
    version = /<widget[^>]*\sversion="([^"]+)"/.exec(config)[1];
  } catch {
    // Keep the default version.
  }
  res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?>\n<widget>\n  <ver>${version}</ver>\n  <size>${size}</size>\n  <widgetname>${SAMSUNG_APP}</widgetname>\n</widget>\n`);
}

function serveSamsungApp(res) {
  const pkg = samsungPackage();
  if (!pkg) return sendJson(res, 404, { error: NOT_BUILT });
  res.writeHead(200, { 'Content-Type': 'application/widget', 'Content-Length': pkg.st.size, 'Cache-Control': 'no-cache' });
  pipeline(fs.createReadStream(pkg.file), res, () => {});
}

// The Mac's Bonjour name (e.g. Name-MacBook-Pro.local). Unlike its address, it stays the same
// when the network hands out a new one, so it's the one to give the Raspberry Pis.
function networkName() {
  const name = os.hostname();
  return name.endsWith('.local') ? name : null;
}

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return sendJson(res, 400, { error: 'Bad URL' });
  }
  const p = url.pathname;

  // The Samsung app runs from its own origin, so it needs permission to read these.
  // Commands are left out: only the control panel sends those.
  if (['/api/time', '/api/state', '/api/events', '/api/report'].includes(p)) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }
  }

  if (p === '/api/time') return sendJson(res, 200, { now: Date.now() });
  if (p === '/api/state') return sendJson(res, 200, snapshot());
  if (p === '/api/events') return openEvents(req, res, url);
  if (p === '/api/command' && req.method === 'POST') return readJson(req, res, applyCommand);
  if (p === '/api/report' && req.method === 'POST') return readJson(req, res, handleReport);
  if (p.startsWith('/videos/')) return serveVideo(req, res, p.slice('/videos/'.length));
  if (p.startsWith('/thumbs/')) return serveThumb(res, p.slice('/thumbs/'.length));
  if (p === '/remote' || p === '/remote/') return serveStatic(req, res, 'remote.html'); // the phone remote
  if (p.startsWith('/samsung/')) {
    // Shown in the Terminal: the only way to see what a display asks for while installing the app.
    console.log(`Samsung app request from ${remoteAddress(req)}: ${req.url}`);
    const file = p.replace(/\/+/g, '/').toLowerCase(); // the address may have been typed with a trailing /
    if (file === '/samsung/sssp_config.xml') return serveSamsungConfig(res);
    if (file === `/samsung/${SAMSUNG_APP.toLowerCase()}.wgt`) return serveSamsungApp(res);
  }
  if (p === '/') return serveStatic(req, res, 'control.html');
  if (/^\/\d+\/?$/.test(p)) return serveStatic(req, res, 'player.html'); // /1 … /7: the TVs
  return serveStatic(req, res, p.slice(1));
});

// ---------- Start ----------

fs.mkdirSync(VIDEOS_DIR, { recursive: true });
const state = loadState();
saveState();

// Tell everyone when videos are added, removed or replaced.
let watchTimer;
fs.watch(VIDEOS_DIR, () => {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    changed();
    broadcast('state', snapshot());
  }, 1000);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other server or run with PORT=3001 node server.js`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  const hosts = localAddresses();
  const host = networkName() || hosts[0] || 'localhost';
  console.log('\nTV Wall is running\n');
  console.log(`  Control panel   http://${host}:${PORT}/`);
  console.log(`  Phone remote    http://${host}:${PORT}/remote`);
  for (const id of screenIds) console.log(`  TV ${id.padEnd(13)}http://${host}:${PORT}/${id}`);
  if (hosts.length) console.log(`\n  By address instead of name: http://${hosts.join(`:${PORT}/, http://`)}:${PORT}/ (changes with the network)`);
  console.log(`\n  Videos folder   ${VIDEOS_DIR} (${listVideos().length} videos)\n`);
});
