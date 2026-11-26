// TV Wall: which video of a TV's playlist plays at a given moment. Shared by the TV page,
// the control panel and the computer sound, so they all agree. Plain ES5 for older TV browsers.

(function (root) {
  'use strict';

  var MIN_ROUND = 5; // seconds: a shorter single video loops in place rather than reloading every round

  // The playlist's videos that can be played: present in the videos folder, each with its URL.
  // A playlist of several videos needs every length (measured by the server) to be scheduled;
  // until they're known, it plays its first video on a loop.
  function items(names, videos) {
    var byName = {};
    videos.forEach(function (v) { byName[v.name] = v; });
    var list = [];
    (names || []).forEach(function (name) {
      var v = byName[name];
      if (v) list.push({ video: name, url: '/videos/' + encodeURIComponent(name) + '?v=' + v.version, duration: v.duration || 0 });
    });
    if (list.length > 1 && list.some(function (item) { return !(item.duration > 0); })) list = list.slice(0, 1);
    return list;
  }

  // The item playing at `time` (ms, server clock) for a playlist started at `startAt`:
  // { video, url, startAt, loop }. Several videos play one after another, then start again.
  // A single video plays round after round in the same way, so each new round loads ahead and
  // starts on time: jumping back to the start instead takes some TVs half a second, which they
  // then catch up by playing faster. It loops in place (loop: true) with `loopInPlace`, for TVs
  // that hold one video at a time, or when it's very short or its length unknown.
  // `startAt` of the result is when that item (or round) began.
  function segmentAt(list, startAt, time, loopInPlace) {
    if (!list.length) return { video: null, url: null, startAt: startAt, loop: false, index: -1 };
    if (list.length === 1 && (loopInPlace || !(list[0].duration >= MIN_ROUND))) {
      return { video: list[0].video, url: list[0].url, startAt: startAt, loop: true, index: 0 };
    }
    var total = 0;
    for (var i = 0; i < list.length; i++) total += list[i].duration * 1000;
    var elapsed = Math.max(0, time - startAt);
    var t = startAt + Math.floor(elapsed / total) * total;
    for (var j = 0; j < list.length; j++) {
      var end = t + list[j].duration * 1000;
      if (time < end || j === list.length - 1) {
        return { video: list[j].video, url: list[j].url, startAt: t, loop: false, index: j };
      }
      t = end;
    }
  }

  root.tvwallSchedule = { items: items, segmentAt: segmentAt };
})(this);
