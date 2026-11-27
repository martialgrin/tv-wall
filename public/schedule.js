// TV Wall: which video a TV plays at a given moment. Shared by the TV page, the control panel, the
// computer sound and the server's crash test, so they all agree. Plain ES5 for older TV browsers.

(function (root) {
  'use strict';

  var MIN_ROUND = 5; // seconds: a shorter single video loops in place rather than reloading every round

  // The named videos present in the videos folder, each with its URL, length and size.
  function lookup(names, videos) {
    var byName = {};
    videos.forEach(function (v) { byName[v.name] = v; });
    var list = [];
    (names || []).forEach(function (name) {
      var v = byName[name];
      if (v) list.push({ video: name, url: '/videos/' + encodeURIComponent(name) + '?v=' + v.version, duration: v.duration || 0, size: v.size || 0 });
    });
    return list;
  }

  function allTimed(list) {
    return list.every(function (item) { return item.duration > 0; });
  }

  // The playlist's videos that can be played. A playlist of several videos needs every length
  // (measured by the server) to be scheduled; until they're known, it plays its first video on a loop.
  function items(names, videos) {
    var list = lookup(names, videos);
    if (list.length > 1 && !allTimed(list)) list = list.slice(0, 1);
    return list;
  }

  // The item playing at `time` (ms, server clock) for a playlist started at `startAt`:
  // { video, url, startAt, loop, index, duration }. Several videos play one after another, then start
  // again. A single video plays round after round in the same way, so each new round loads ahead and
  // starts on time: jumping back to the start instead takes some TVs half a second, which they then
  // catch up by playing faster. It loops in place (loop: true) with `loopInPlace`, for TVs that hold
  // one video at a time, or when it's very short or its length unknown.
  // `startAt` of the result is when that item (or round) began.
  function segmentAt(list, startAt, time, loopInPlace) {
    if (!list.length) return { video: null, url: null, startAt: startAt, loop: false, index: -1, duration: 0 };
    if (list.length === 1 && (loopInPlace || !(list[0].duration >= MIN_ROUND))) {
      return { video: list[0].video, url: list[0].url, startAt: startAt, loop: true, index: 0, duration: list[0].duration };
    }
    var total = 0;
    for (var i = 0; i < list.length; i++) total += list[i].duration * 1000;
    var elapsed = Math.max(0, time - startAt);
    var t = startAt + Math.floor(elapsed / total) * total;
    for (var j = 0; j < list.length; j++) {
      var end = t + list[j].duration * 1000;
      if (time < end || j === list.length - 1) {
        return { video: list[j].video, url: list[j].url, startAt: t, loop: false, index: j, duration: list[j].duration };
      }
      t = end;
    }
  }

  // What a TV plays, from the server's state (read it with `at`):
  // - Expo ("individual"): its own videos, one after another.
  // - Same video ("all"): the shared video.
  // - Show: the show's videos together with every other TV, one after another, once; then its own
  //   videos for the show's Expo minutes; and again.
  // A TV with "Keep its own videos" plays its own videos in every mode (the credits, for example).
  function plan(state, id) {
    var own = state.screens[id] || {};
    var mine = items(own.playlist || (own.video ? [own.video] : []), state.videos);
    if (own.keep || state.mode !== 'all' && state.mode !== 'show') return { list: mine, startAt: own.startAt };
    if (state.mode === 'all') return { list: items([state.all.video], state.videos), startAt: state.all.startAt };
    var show = state.show || {};
    var shared = lookup(show.videos, state.videos);
    var pass = 0;
    shared.forEach(function (item) { pass += item.duration * 1000; });
    // A show needs every video's length to keep the TVs together: until then, Expo.
    if (!shared.length || !allTimed(shared)) return { list: mine, startAt: show.startAt || own.startAt };
    return {
      list: mine, shared: shared, pass: pass, expo: Math.max(0, Number(show.expoMinutes) || 0) * 60000,
      startAt: show.startAt, expoFirst: Boolean(show.expoFirst),
    };
  }

  // The item a TV plays at `time` by its plan: as segmentAt, with `phase` ('videos' or 'expo') and
  // `phaseEnd` (when the show moves on) in the show. The show begins at startAt with its videos, or
  // with its Expo (expoFirst); until then, a TV waits for its first item, and shows what it showed.
  function at(p, time, loopInPlace) {
    if (!p.shared) return segmentAt(p.list, p.startAt, time, loopInPlace);
    var cycle = p.pass + p.expo;
    var t = Math.max(time, p.startAt);
    var origin = p.startAt - (p.expoFirst ? p.pass : 0); // when the first round of videos began, or would have
    var cycleStart = origin + Math.floor((t - origin) / cycle) * cycle;
    var seg;
    if (t < cycleStart + p.pass) {
      seg = segmentAt(p.shared, cycleStart, time, false);
      seg.phase = 'videos';
      seg.phaseEnd = cycleStart + p.pass;
    } else {
      // Expo: each TV's own videos from the moment the shared ones end, cut when the next pass begins.
      seg = segmentAt(p.list, cycleStart + p.pass, time, loopInPlace);
      seg.phase = 'expo';
      seg.phaseEnd = cycleStart + cycle;
    }
    return seg;
  }

  root.tvwallSchedule = { items: items, segmentAt: segmentAt, plan: plan, at: at };
})(this);
