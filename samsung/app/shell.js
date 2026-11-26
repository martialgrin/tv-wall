// NOT USED: the wall now plays on Raspberry Pis (README, section 3). Kept for reference.
//
// TV Wall app for Samsung signage: the part installed on the display.
// It asks once which TV this is, then loads the player (public/samsung.js) from the TV Wall
// server. The player can then change on the Mac without signing and installing the app again.
// Plain ES5 for the display's browser engine.

(function () {
  'use strict';

  var DEFAULT_SERVER = '192.168.0.10:3000'; // set by samsung/build.sh
  var RETRY_DELAY = 5000;
  var KEY = { ENTER: 13, UP: 38, RIGHT: 39, DOWN: 40, RED: 403 };

  var setup = document.getElementById('setup');
  var numberEl = document.getElementById('screen-number');
  var serverInput = document.getElementById('server');
  var message = document.getElementById('message');

  var server = read('tvwall.server') || DEFAULT_SERVER;
  var screen = read('tvwall.screen');
  var inSetup = false;
  var typedAt = 0; // when the last digit was pressed, to allow two-digit numbers

  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function write(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* the setting lasts until the app restarts */ }
  }

  // The remote's number and colour keys only reach the app once registered.
  try {
    ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'ColorF0Red'].forEach(function (name) {
      tizen.tvinputdevice.registerKey(name);
    });
  } catch (e) { /* not on a Samsung display */ }

  function showSetup() {
    inSetup = true;
    numberEl.textContent = screen || '1';
    serverInput.value = server;
    setup.style.display = 'flex';
    message.textContent = '';
  }

  function start() {
    inSetup = false;
    setup.style.display = 'none';
    serverInput.blur();
    window.TVWALL = { server: 'http://' + server, screen: screen, shell: 1 };
    load();
  }

  function load() {
    message.textContent = 'TV ' + screen + ' · loading the player from ' + server + '…';
    var script = document.createElement('script');
    script.src = 'http://' + server + '/samsung.js?t=' + Date.now();
    script.onload = function () { message.textContent = ''; };
    script.onerror = function () {
      script.parentNode.removeChild(script);
      message.textContent = 'TV ' + screen + ' · can\'t reach the TV Wall server at ' + server +
        '. Retrying… (red A button: settings)';
      setTimeout(load, RETRY_DELAY);
    };
    document.body.appendChild(script);
  }

  function setNumber(n) {
    numberEl.textContent = String(Math.max(1, Math.min(99, n)));
  }

  document.addEventListener('keydown', function (e) {
    var key = e.keyCode;
    if (key === KEY.RED) {
      // Back to the settings, even while playing: reload the app and open them first.
      try { sessionStorage.setItem('tvwall.setup', '1'); } catch (x) { /* nothing */ }
      location.reload();
      return;
    }
    if (!inSetup) return;
    var editingServer = document.activeElement === serverInput;

    if (!editingServer && key >= 48 && key <= 57) {
      var digit = key - 48;
      var now = Date.now();
      // A second digit within 1.5 s makes a two-digit number (TV 10, 11, …).
      setNumber(now - typedAt < 1500 ? Number(numberEl.textContent) * 10 + digit : digit);
      typedAt = now;
    } else if (key === KEY.UP) {
      if (editingServer) serverInput.blur(); // back to the number
      else setNumber(Number(numberEl.textContent) + 1);
    } else if (key === KEY.DOWN && !editingServer) {
      setNumber(Number(numberEl.textContent) - 1);
    } else if (key === KEY.RIGHT && !editingServer) {
      numberEl.className = 'number';
      serverInput.focus();
    } else if (key === KEY.ENTER && !editingServer) {
      screen = numberEl.textContent;
      server = serverInput.value.replace(/^https?:\/\//, '').replace(/\/+$/, '').trim() || DEFAULT_SERVER;
      write('tvwall.screen', screen);
      write('tvwall.server', server);
      start();
    }
  });

  serverInput.addEventListener('blur', function () {
    numberEl.className = 'number focused';
  });

  var askedForSetup = false;
  try {
    askedForSetup = sessionStorage.getItem('tvwall.setup') === '1';
    sessionStorage.removeItem('tvwall.setup');
  } catch (e) { /* nothing */ }

  if (!screen || askedForSetup) showSetup();
  else start();
})();
