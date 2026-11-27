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
const LOGS_DIR = path.join(__dirname, 'logs');
// The same schedule the TVs follow, so the crash test can check each TV's position itself.
const { tvwallSchedule } = require('./public/schedule.js');
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
  if (test && test.running) {
    if (test.ours) {
      testEvent(null, `Test sent ${JSON.stringify(cmd)}`);
    } else {
      test.outsideChanges++;
      testEvent(null, `Someone sent ${JSON.stringify(cmd)} during the test`, { warn: true });
    }
  }
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
    // A new id each time the TV page loads, and its counters since then (Wi-Fi, stalls…): read by the crash test.
    page: body.page ? String(body.page).slice(0, 20) : null,
    up: Number(body.up) || 0,
    health: numbersOnly(body.health),
    error,
    at: Date.now(),
  };
  try {
    takeTvEvents(id, reports[id].page, body.events);
  } catch (err) {
    console.error('Test error:', err); // never refuse a TV's report because of the test
  }
  return snapshot();
}

function numbersOnly(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const [key, value] of Object.entries(obj).slice(0, 30)) {
    if (typeof value === 'number' && isFinite(value)) out[key.slice(0, 30)] = value;
  }
  return out;
}

// Events a TV noticed (a late start, a stall, a lost reply…). It sends them until the server has
// them, so a report that got through twice could repeat some: keep only the new ones.
const tvEventSeen = {}; // TV number -> { page, n }
function takeTvEvents(id, page, events) {
  if (!Array.isArray(events) || !page) return;
  const seen = tvEventSeen[id] && tvEventSeen[id].page === page ? tvEventSeen[id].n : 0;
  let last = seen;
  for (const e of events.slice(-40)) {
    const n = Number(e && e.n);
    if (!(n > seen)) continue;
    last = Math.max(last, n);
    testEvent(id, String(e.m).slice(0, 200), { at: Number(e.t) || Date.now(), warn: Boolean(e.w), fromTv: true });
  }
  tvEventSeen[id] = { page, n: last };
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

// ---------- Crash test ----------

// Started from the panel. Watches every TV once a second, tries the controls, and writes what it saw
// to logs/test-<date>.jsonl, one JSON object per line: "start" (the setup), "step", "event", "sample"
// (every TV, every second) and, at the end, "summary". The file grows while the test runs, so a test
// cut short still leaves its log.
const TEST_SPEED = Number(process.env.TEST_SPEED) || 1; // above 1, every step is that many times shorter: to try the test itself
const SYNC_OK = 40;           // ms: as in the panel, a TV this close to where it should be is in sync
const POSITION_OK = 1000;     // ms: the server's own estimate of a TV's position is rougher (it arrives with the report)
const REPORT_LATE = 2500;     // ms: a report this old means the Wi-Fi held it up
const RESTART_GRACE = 120000; // ms after "Reload TVs" during which a TV page restarting is expected
const TV_COUNTERS = ['ok', 'failed', 'stalls', 'fallbacks', 'loadTimeouts', 'mediaErrors', 'lateStarts', 'clockRejected', 'liveErrors'];

let test = null;          // the test running now, or the last one, for its results
let serverVersion = null; // git commit, so a log says which code ran
execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd: __dirname, timeout: 5000 }, (err, stdout) => {
  if (!err) serverVersion = stdout.trim();
});

function testSteps(minutes, withCommands) {
  const sec = 1000 / TEST_SPEED;
  const steps = [{ key: 'baseline', label: 'Watching the wall as it is', ms: 120 * sec }];
  if (withCommands) {
    const names = listVideos().map(v => v.name);
    const shared = names.includes(state.all.video) ? state.all.video : names[0];
    const quick = shared
      ? [() => testCommand({ type: 'restart' }), () => testCommand({ type: 'all', video: shared }), restoreWall]
      : [() => testCommand({ type: 'restart' }), restoreWall];
    steps.push({ key: 'restart', label: 'Restart in sync', ms: 45 * sec, run: () => testCommand({ type: 'restart' }) });
    if (shared) {
      steps.push({ key: 'all', label: `Same video on all TVs (${shared})`, ms: 75 * sec, run: () => testCommand({ type: 'all', video: shared }) });
    }
    steps.push({ key: 'back', label: 'Back to what the wall played', ms: 60 * sec, run: restoreWall });
    steps.push({
      key: 'quick', label: 'Quick changes, one every 1.5 s', ms: 50 * sec,
      run: () => [...quick, ...quick].forEach((fn, i) => test.timers.push(setTimeout(fn, i * 1500))),
    });
    steps.push({ key: 'reload', label: 'Reload the TVs', ms: 75 * sec, run: () => testCommand({ type: 'reload' }) });
  }
  const used = steps.reduce((sum, s) => sum + s.ms, 0);
  steps.push({ key: 'watch', label: 'Long run', ms: Math.max(60 * sec, (minutes * 60000) / TEST_SPEED - used) });
  return steps;
}

function startTest(options) {
  if (test && test.running) throw new Error('A test is already running');
  const minutes = Math.min(24 * 60, Math.max(5, Math.round(Number(options.minutes) || 30)));
  const withCommands = options.commands !== false;
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const now = Date.now();
  test = {
    running: true,
    file: `test-${fileStamp(new Date(now))}.jsonl`,
    options: { minutes, commands: withCommands },
    startedAt: now,
    // What the wall plays now, put back at the end.
    before: JSON.parse(JSON.stringify({ mode: state.mode, soundOn: state.soundOn, all: state.all, screens: state.screens })),
    steps: [],
    stepIndex: -1,
    stepStartedAt: now,
    settleFrom: null, // after a command: when the TVs should follow it
    reloadAt: 0,
    wallChanged: false,
    ours: false,      // the command being applied is the test's
    timers: [],
    lines: [],
    events: [],
    samples: 0,
    lagMax: 0,
    outsideChanges: 0,
    tvs: Object.fromEntries(screenIds.map(id => [id, newTv()])),
  };
  test.steps = testSteps(minutes, withCommands);
  testLine({
    type: 'start',
    t: now,
    at: new Date(now).toISOString(),
    options: test.options,
    steps: test.steps.map(s => ({ key: s.key, label: s.label, ms: s.ms })),
    server: {
      version: serverVersion,
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      host: os.hostname(),
      cpus: os.cpus().length,
      memoryGB: Number((os.totalmem() / 1e9).toFixed(1)),
      addresses: localAddresses(),
      port: PORT,
      startDelay: START_DELAY,
    },
    wall: test.before,
    videos: listVideos().map(v => ({ name: v.name, size: v.size, duration: v.duration })),
    tvs: Object.fromEntries(screenIds.map(id => {
      const s = screenStatus(id);
      return [id, { online: s.online, devices: s.devices, agent: s.agent, page: s.page, up: s.up, health: s.health, log: s.log, error: s.error }];
    })),
  });
  flushTest();
  watchLag(true);
  test.interval = setInterval(tickTest, 1000);
  test.flushTimer = setInterval(flushTest, 5000);
  console.log(`Test started (${minutes} min). Log: logs/${test.file}`);
  nextStep();
  broadcastTest();
}

function stopTest() {
  if (!test || !test.running) throw new Error('No test is running');
  closeStep();
  finishTest('stopped');
}

function finishTest(reason) {
  if (!test || !test.running) return;
  clearInterval(test.interval);
  clearInterval(test.flushTimer);
  test.timers.forEach(clearTimeout);
  test.timers = [];
  if (test.wallChanged) restoreWall();
  test.running = false;
  test.reason = reason;
  test.endedAt = Date.now();
  watchLag(false);
  test.summary = testSummary();
  testLine({ type: 'summary', ...test.summary });
  flushTest();
  console.log(`Test ${reason}. Log: logs/${test.file}`);
  broadcastTest();
}

function tickTest() {
  try {
    sampleTest();
    if (Date.now() - test.stepStartedAt >= test.steps[test.stepIndex].ms) nextStep();
    if (test.running) broadcastTest();
  } catch (err) {
    // A mistake in the test must never stop the server that runs the wall.
    console.error('Test error:', err);
    testEvent(null, `Test error: ${err.message}`, { warn: true });
    finishTest(`stopped by an error (${err.message})`);
  }
}

function nextStep() {
  closeStep();
  test.timers.forEach(clearTimeout);
  test.timers = [];
  test.stepIndex++;
  test.settleFrom = null;
  const step = test.steps[test.stepIndex];
  if (!step) return finishTest('finished');
  test.stepStartedAt = Date.now();
  testLine({ type: 'step', t: test.stepStartedAt, index: test.stepIndex, key: step.key, label: step.label, ms: step.ms });
  testEvent(null, `Step ${test.stepIndex + 1} of ${test.steps.length}: ${step.label}`);
  console.log(`Test step ${test.stepIndex + 1}/${test.steps.length}: ${step.label}`);
  if (step.run) step.run();
}

// The end of a step that changed the wall: a TV still not in sync didn't manage to follow.
function closeStep() {
  const step = test.steps[test.stepIndex];
  if (!step || test.settleFrom === null) return;
  for (const id of screenIds) {
    const acc = test.tvs[id].steps[step.key];
    if (acc && acc.online && !acc.settled) {
      acc.notSettled = true;
      testEvent(id, `Not in sync again by the end of "${step.label}"`, { warn: true });
    }
  }
}

function testCommand(cmd) {
  if (!test || !test.running) return;
  test.ours = true;
  try {
    applyCommand(cmd);
  } catch (err) {
    testEvent(null, `Could not send ${JSON.stringify(cmd)}: ${err.message}`, { warn: true });
    return;
  } finally {
    test.ours = false;
  }
  if (cmd.type === 'reload') {
    test.reloadAt = Date.now();
    settleFrom(Date.now());
  } else {
    test.wallChanged = true;
    settleFrom(Date.now() + START_DELAY);
  }
}

// Puts back what the wall played when the test started, from the start, together, as "Restart in
// sync" does. (Its old start times would make every TV join its video halfway through, which the TVs
// take for a video that failed to start.)
function restoreWall() {
  if (!test) return;
  const before = test.before;
  const startAt = Date.now() + START_DELAY;
  state.mode = before.mode;
  state.all = { ...before.all, startAt };
  for (const id of screenIds) {
    setPlaylist(state.screens[id], [...before.screens[id].playlist]);
    state.screens[id].startAt = startAt;
  }
  test.wallChanged = false;
  console.log('Test: the wall is back to what it played before the test');
  saveState();
  changed();
  broadcast('state', snapshot());
  if (test.running) {
    testEvent(null, 'Test put the wall back to what it played before');
    settleFrom(startAt);
  }
}

// A change the TVs must follow from `at`: measure how long each one takes to be in sync again.
function settleFrom(at) {
  const step = test.steps[test.stepIndex];
  if (!step) return;
  test.settleFrom = at;
  for (const id of screenIds) {
    const acc = stepAcc(id, step.key);
    acc.settled = false;
    acc.settleMs = undefined;
    test.tvs[id].badSince = 0;
    test.tvs[id].badNoted = false;
  }
}

function newTv() {
  return {
    seen: false, online: false, offlineAt: 0, offline: 0, offlineMs: 0,
    page: null, health: null, hasHealth: false, oldPage: false, restarts: 0, unexpectedRestarts: 0,
    counts: Object.fromEntries(TV_COUNTERS.map(k => [k, 0])),
    steps: {}, maxDevices: 0, error: null, badSince: 0, badNoted: false, heapFirst: null, heapLast: null,
  };
}

function newAcc() {
  return {
    samples: 0, online: 0, measured: 0, inSync: 0, playing: 0, droppedSum: 0, lateReports: 0,
    drifts: [], offsets: [], rtts: [], settled: false, settleMs: undefined, notSettled: false,
  };
}

function stepAcc(id, key) {
  const tv = test.tvs[id];
  return tv.steps[key] || (tv.steps[key] = newAcc());
}

// Where a TV should be at server time `at`, by the same schedule the TV follows: { video, pos (s) }.
function expectedAt(id, at, videos, reportedDuration) {
  const own = state.screens[id];
  const shared = state.mode === 'all' && !own.keep;
  const list = tvwallSchedule.items(shared ? [state.all.video] : own.playlist, videos);
  const seg = tvwallSchedule.segmentAt(list, shared ? state.all.startAt : own.startAt, at, own.oneVideo);
  if (!seg.url) return null;
  const d = list[seg.index].duration || reportedDuration;
  let pos = Math.max(0, (at - seg.startAt) / 1000);
  if (seg.loop && d > 0) pos %= d;
  return { video: seg.video, pos, loop: seg.loop, d };
}

function sampleTest() {
  const now = Date.now();
  const step = test.steps[test.stepIndex];
  const videos = listVideos();
  const restartExpected = now - test.reloadAt < RESTART_GRACE;
  const line = { type: 'sample', t: now, step: step.key, lag: lagMax, tv: {} };
  test.lagMax = Math.max(test.lagMax, lagMax);
  lagMax = 0;
  if (test.samples++ % 10 === 0) {
    line.sys = { load: Number(os.loadavg()[0].toFixed(2)), freeMB: Math.round(os.freemem() / 1e6) };
  }

  for (const id of screenIds) {
    const s = screenStatus(id);
    const tv = test.tvs[id];
    if (!s.at) {
      line.tv[id] = null; // hasn't reported since the server started
      continue;
    }
    const acc = stepAcc(id, step.key);
    acc.samples++;

    // Comes and goes.
    if (s.online && !tv.online) {
      if (tv.seen) testEvent(id, `Back online after ${seconds(now - tv.offlineAt)}`);
      else if (test.samples > 1) testEvent(id, 'Came online');
      tv.seen = true;
    } else if (!s.online && tv.online) {
      tv.offlineAt = now;
      if (!restartExpected) tv.offline++;
      testEvent(id, `Offline: no report for ${REPORT_TIMEOUT / 1000} s`, { warn: !restartExpected });
    }
    tv.online = s.online;
    if (!s.online && tv.seen && !restartExpected) tv.offlineMs += 1000;

    // A new page id: the TV page restarted. Expected after "Reload TVs"; otherwise it crashed,
    // lost power, or someone reloaded it.
    if (s.page && tv.page && s.page !== tv.page) {
      tv.restarts++;
      if (!restartExpected) tv.unexpectedRestarts++;
      testEvent(id, restartExpected ? 'TV page reloaded' : 'TV page restarted by itself', { warn: !restartExpected });
    }
    // The TV's counters since its page loaded: add what's new since the last sample.
    const h = s.health;
    if (h && s.page) {
      tv.hasHealth = true;
      const prev = s.page === tv.page ? tv.health : tv.page ? {} : null; // first sight: only a starting point
      if (prev) for (const k of TV_COUNTERS) tv.counts[k] += Math.max(0, (h[k] || 0) - (prev[k] || 0));
      tv.health = h;
      if (h.heapMB) {
        if (tv.heapFirst === null) tv.heapFirst = h.heapMB;
        tv.heapLast = h.heapMB;
      }
    }
    if (s.page) tv.page = s.page;
    if (s.online && !s.page) tv.oldPage = true;
    if (s.devices.length > tv.maxDevices) {
      if (s.devices.length > 1) testEvent(id, `Open on ${s.devices.length} devices at once: ${s.devices.join(', ')}`, { warn: true });
      tv.maxDevices = s.devices.length;
    }
    if (s.online && s.error !== tv.error) {
      if (s.error) testEvent(id, `On screen: ${s.error}`, { warn: true });
      tv.error = s.error;
    }

    const entry = { on: s.online ? 1 : 0, age: now - s.at };
    line.tv[id] = entry;
    if (!s.online) {
      tv.badSince = 0;
      tv.badNoted = false;
      continue;
    }
    acc.online++;
    const rtt = h && h.rtt ? h.rtt : 0;
    if (rtt) acc.rtts.push(rtt);
    if (now - s.at > REPORT_LATE && !restartExpected) acc.lateReports++; // a page reloading stops reporting for a moment

    // In sync: playing the right video, close by its own clock, and roughly where the server expects it.
    const exp = expectedAt(id, s.at - rtt / 2, videos, s.duration);
    let ok;
    let x; // ms ahead (+) or behind (-) of where the server expects it
    if (!exp) {
      ok = s.state === 'black';
    } else {
      const showing = s.state === 'playing' && s.video === exp.video;
      if (showing) {
        x = (s.time - exp.pos) * 1000;
        const dm = exp.d * 1000;
        if (exp.loop && dm > 0) {
          if (x > dm / 2) x -= dm;
          else if (x < -dm / 2) x += dm;
        }
        x = Math.round(x);
      }
      ok = showing && Math.abs(s.drift) <= SYNC_OK && Math.abs(x) < POSITION_OK;
    }

    // After a command, measure how long until the TV is in sync again, and count its sync only from then.
    let measuring = true;
    if (test.settleFrom !== null) {
      if (!acc.settled && now >= test.settleFrom && ok) {
        acc.settled = true;
        acc.settleMs = now - test.settleFrom;
      }
      measuring = acc.settled;
    }
    if (measuring && exp) {
      acc.measured++;
      if (ok) acc.inSync++;
      if (s.state === 'playing') {
        acc.playing++;
        acc.drifts.push(Math.abs(s.drift));
        acc.droppedSum += s.dropped || 0;
      }
      if (x !== undefined && rtt && rtt < 100) acc.offsets.push(x);
      // Out of sync for a while: say so once, then again when it's back.
      if (ok) {
        if (tv.badNoted) testEvent(id, `Back in sync after ${seconds(now - tv.badSince)}`);
        tv.badSince = 0;
        tv.badNoted = false;
      } else if (!tv.badSince) {
        tv.badSince = now;
      } else if (!tv.badNoted && now - tv.badSince >= 5000) {
        tv.badNoted = true;
        const what = s.state !== 'playing' ? s.state
          : s.video !== exp.video ? `showing ${s.video} instead of ${exp.video}`
          : `${s.drift} ms off by its own clock${x !== undefined ? `, about ${x} ms by the server's` : ''}`;
        testEvent(id, `Out of sync for 5 s: ${what}`, { warn: true });
      }
    } else {
      tv.badSince = 0;
      tv.badNoted = false;
    }

    Object.assign(entry, {
      s: s.state, v: s.video, t: Math.round(s.time * 100) / 100, d: s.drift, x, ok: ok ? 1 : 0,
      rtt: h ? h.rtt : undefined, buf: h ? h.buf : undefined, fd: s.dropped || undefined, mem: h ? h.heapMB : undefined,
    });
  }
  testLine(line);
}

function testSummary() {
  const tvs = {};
  const count = { ok: 0, check: 0, problem: 0, off: 0 };
  for (const id of screenIds) {
    tvs[id] = tvSummary(id);
    count[tvs[id].verdict]++;
  }
  const notes = [];
  if (test.lagMax > 250) notes.push(`The server was busy: it answered up to ${test.lagMax} ms late. Something else on this computer was using it heavily.`);
  if (test.outsideChanges) notes.push(`The wall was changed ${test.outsideChanges}× from the panel or the remote during the test: results around those moments are not the test's.`);
  return {
    file: test.file,
    reason: test.reason,
    startedAt: test.startedAt,
    endedAt: test.endedAt,
    minutes: Math.round((test.endedAt - test.startedAt) / 6000) / 10,
    steps: test.steps.slice(0, test.stepIndex + 1).map(s => s.label),
    serverLagMs: test.lagMax,
    count,
    notes,
    tvs,
    events: test.events,
  };
}

function tvSummary(id) {
  const tv = test.tvs[id];
  if (!tv.seen) return { verdict: 'off', notes: ['Not connected during the test'] };
  const all = newAcc();
  const settle = [];
  const notSettled = [];
  for (const step of test.steps) {
    const acc = tv.steps[step.key];
    if (!acc) continue;
    for (const k of ['samples', 'online', 'measured', 'inSync', 'playing', 'droppedSum', 'lateReports']) all[k] += acc[k];
    for (const k of ['drifts', 'offsets', 'rtts']) all[k] = all[k].concat(acc[k]);
    if (acc.settleMs !== undefined) settle.push({ step: step.label, ms: acc.settleMs });
    if (acc.notSettled) notSettled.push(step.label);
  }
  const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
  const c = tv.counts;
  const r = {
    online: pct(all.online, all.samples),
    inSync: pct(all.inSync, all.measured),
    driftP95: percentile(all.drifts, 95),
    driftMax: percentile(all.drifts, 100),
    serverOffsetMs: percentile(all.offsets, 50),
    replyMs: percentile(all.rtts, 50),
    replyP95: percentile(all.rtts, 95),
    lost: tv.hasHealth ? pct(c.failed, c.ok + c.failed) : null,
    lateReports: all.lateReports,
    offline: tv.offline,
    offlineSeconds: Math.round(tv.offlineMs / 1000),
    restarts: tv.restarts,
    unexpectedRestarts: tv.unexpectedRestarts,
    settle,
    worstSettleMs: settle.length ? Math.max(...settle.map(s => s.ms)) : null,
    dropped: all.playing ? Math.round((10 * all.droppedSum) / all.playing) / 10 : 0,
    counts: c,
    heapMB: tv.heapFirst !== null ? [tv.heapFirst, tv.heapLast] : null,
    devices: tv.maxDevices,
    oldPage: tv.oldPage,
  };
  const problems = [];
  const checks = [];
  if (r.offline) problems.push(`Went offline ${r.offline}× (${seconds(r.offlineSeconds * 1000)} in all)`);
  if (r.unexpectedRestarts) problems.push(`TV page restarted by itself ${r.unexpectedRestarts}× (crash, power cut, or reloaded by hand)`);
  if (notSettled.length) problems.push(`Didn't get back in sync after: ${notSettled.join(', ')}`);
  if (r.inSync !== null && r.inSync < 75) problems.push(`In sync only ${r.inSync}% of the time`);
  else if (r.inSync !== null && r.inSync < 90) checks.push(`In sync ${r.inSync}% of the time`);
  if (r.lost !== null && r.lost >= 20) problems.push(`Lost ${r.lost}% of its messages to the server`);
  else if (r.lost !== null && r.lost >= 2) checks.push(`Lost ${r.lost}% of its messages to the server (weak Wi‑Fi)`);
  if (r.replyP95 > 150) checks.push(`Slow Wi‑Fi: replies take up to ${r.replyP95} ms`);
  if (r.lateReports && r.lateReports >= all.online / 100) checks.push(`Reports held up over ${REPORT_LATE / 1000} s: ${r.lateReports}×`);
  if (c.stalls) checks.push(`Video stalled ${c.stalls}× and was reloaded`);
  if (c.fallbacks) checks.push(`Next round not loaded in time ${c.fallbacks}× (looped the video instead)`);
  if (c.loadTimeouts) checks.push(`A video didn't start ${c.loadTimeouts}× and was loaded again`);
  if (c.mediaErrors) checks.push(`${c.mediaErrors} video errors`);
  if (c.lateStarts) checks.push(`Started a video late ${c.lateStarts}×`);
  if (r.worstSettleMs > 8000) checks.push(`Slow to follow a command: up to ${seconds(r.worstSettleMs)}`);
  if (r.dropped >= 5) checks.push(`Drops ${r.dropped}% of frames`);
  if (Math.abs(r.serverOffsetMs) > 150) checks.push(`Its clock may be off: the server sees it about ${r.serverOffsetMs} ms off`);
  if (r.devices > 1) checks.push(`Open on ${r.devices} devices at once`);
  if (r.heapMB && r.heapMB[1] - r.heapMB[0] > 150) checks.push(`Memory grew from ${r.heapMB[0]} to ${r.heapMB[1]} MB`);
  if (r.oldPage) checks.push('Older TV page: click Reload TVs before a test, for the full details');
  r.verdict = problems.length ? 'problem' : checks.length ? 'check' : 'ok';
  r.notes = [...problems, ...checks];
  return r;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
}

function seconds(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${Math.round(ms / 100) / 10} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

function fileStamp(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function testEvent(tv, msg, opts = {}) {
  if (!test || !test.running) return;
  const step = test.steps[test.stepIndex];
  const e = {
    type: 'event',
    t: Math.round(opts.at || Date.now()),
    step: step ? step.key : undefined,
    tv: tv ? String(tv) : undefined,
    msg,
    warn: opts.warn ? 1 : undefined,
    from: opts.fromTv ? 'tv' : undefined,
  };
  testLine(e);
  // The panel lists what matters: everything the server saw, and the TVs' warnings.
  if ((!opts.fromTv || opts.warn) && test.events.length < 500) test.events.push(e);
}

function testLine(obj) {
  test.lines.push(JSON.stringify(obj));
}

function flushTest() {
  if (!test || !test.lines.length) return;
  const data = test.lines.join('\n') + '\n';
  test.lines = [];
  try {
    fs.appendFileSync(path.join(LOGS_DIR, test.file), data);
  } catch (err) {
    console.error('Could not write the test log:', err.message);
  }
}

function testStatus() {
  if (!test) return null;
  const now = Date.now();
  let left = 0;
  if (test.running) {
    test.steps.forEach((s, i) => {
      if (i > test.stepIndex) left += s.ms;
      else if (i === test.stepIndex) left += Math.max(0, s.ms - (now - test.stepStartedAt));
    });
  }
  return {
    running: test.running,
    file: test.file,
    options: test.options,
    startedAt: test.startedAt,
    now,
    endsAt: now + left,
    step: test.stepIndex,
    steps: test.steps.map(s => s.label),
    summary: test.summary || null,
  };
}

function broadcastTest() {
  broadcast('test', testStatus(), c => c.role === 'control');
}

function listLogs(limit = 10) {
  let names;
  try {
    names = fs.readdirSync(LOGS_DIR);
  } catch {
    return [];
  }
  const logs = [];
  for (const name of names) {
    if (!/^test-[\w-]+\.jsonl$/.test(name)) continue;
    try {
      const st = fs.statSync(path.join(LOGS_DIR, name));
      logs.push({ name, size: st.size, at: st.mtimeMs });
    } catch {
      // Deleted meanwhile.
    }
  }
  return logs.sort((a, b) => b.at - a.at).slice(0, limit);
}

function serveLog(res, encodedName) {
  let name;
  try {
    name = path.basename(decodeURIComponent(encodedName));
  } catch {
    return sendJson(res, 400, { error: 'Bad file name' });
  }
  if (!/^test-[\w-]+\.jsonl$/.test(name)) return sendJson(res, 404, { error: 'Not found' });
  const file = path.join(LOGS_DIR, name);
  fs.stat(file, (err, st) => {
    if (err || !st.size) return sendJson(res, 404, { error: 'Log not found' });
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Length': st.size,
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    });
    // Up to its size now: a running test keeps adding to it.
    pipeline(fs.createReadStream(file, { start: 0, end: st.size - 1 }), res, () => {});
  });
}

// How late the server's timers run: a computer busy with something else answers the TVs late.
let lagTimer = null;
let lagMax = 0;
function watchLag(on) {
  clearInterval(lagTimer);
  lagMax = 0;
  if (!on) return;
  let last = Date.now();
  lagTimer = setInterval(() => {
    const now = Date.now();
    lagMax = Math.max(lagMax, now - last - 100);
    last = now;
  }, 100);
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
  if (role === 'control') send(res, 'test', testStatus());
  if (role === 'player') {
    console.log(`TV ${screen} connected from ${from}`);
    testEvent(screen, `Live connection opened (${from})`);
  }
  req.on('close', () => {
    clients.delete(client);
    if (role === 'player') {
      console.log(`TV ${screen} disconnected (${from})`);
      testEvent(screen, `Live connection closed (${from})`);
    }
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
  if (p === '/api/test' && req.method === 'GET') return sendJson(res, 200, { test: testStatus(), logs: listLogs() });
  if (p === '/api/test' && req.method === 'POST') {
    return readJson(req, res, body => {
      if (body.action === 'start') startTest(body);
      else if (body.action === 'stop') stopTest();
      else throw new Error('action must be "start" or "stop"');
      return { test: testStatus(), logs: listLogs() };
    });
  }
  if (p === '/api/logs') return sendJson(res, 200, { logs: listLogs(Infinity) }); // every log, for fetch-logs.sh
  if (p.startsWith('/logs/')) return serveLog(res, p.slice('/logs/'.length));
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
