/* Toolbar status icon: pixel archive box + inbound arrow.
 * Arrow color is the status:
 *   idle / warn  amber  — standby, or archive app not connected
 *   ok           green  — on arena + native archive connected
 *   stream       blue   — live capture; two-frame bob while streaming
 *   error        red    — capture-health failure or last archive write failed
 */
var AE = AE || {};

(function () {
  "use strict";

  var ARENA_TAB_RE = /^https:\/\/([^/]+\.)?(arena\.ai|lmarena\.ai)\//i;
  var visualKind = "";
  var lastTitle = "";
  var bobTimer = null;
  var bobFrame = 0;
  var BOB_MS = 450;
  var PATHS = {
    idle: { 16: "icons/led/16-idle.png", 32: "icons/led/32-idle.png", 48: "icons/led/48-idle.png" },
    ok: { 16: "icons/led/16-ok.png", 32: "icons/led/32-ok.png", 48: "icons/led/48-ok.png" },
    stream: { 16: "icons/led/16-stream.png", 32: "icons/led/32-stream.png", 48: "icons/led/48-stream.png" },
    "stream-b": { 16: "icons/led/16-stream-b.png", 32: "icons/led/32-stream-b.png", 48: "icons/led/48-stream-b.png" },
    warn: { 16: "icons/led/16-idle.png", 32: "icons/led/32-idle.png", 48: "icons/led/48-idle.png" },
    error: { 16: "icons/led/16-error.png", 32: "icons/led/32-error.png", 48: "icons/led/48-error.png" }
  };
  var TITLES = {
    idle: "Arena Exporter — idle",
    ok: "Arena Exporter — archive connected",
    stream: "Arena Exporter — capturing",
    "stream-b": "Arena Exporter — capturing",
    warn: "Arena Exporter — archive app not connected",
    error: "Arena Exporter — capture or write error"
  };

  AE.statusLedKind = function (opts) {
    opts = opts || {};
    var summary = opts.summary || {};
    var onArena = !!opts.onArena;
    var native = summary.nativeSink || opts.native || null;
    var lastSync = summary.lastSync || null;
    if (lastSync && lastSync.ok === false) return "error";
    if (summary.captureHealthCritical) return "error";
    if (summary.streaming) return "stream";
    if (!onArena) return "idle";
    if (native && native.state === "ok") return "ok";
    return "warn";
  };

  function paint(kind) {
    var visual = kind === "stream" && bobFrame ? "stream-b" : kind;
    if (kind === "warn") visual = "idle";
    var title = TITLES[kind] || TITLES.idle;
    var paths = PATHS[visual] || PATHS.idle;
    if (visual === visualKind && title === lastTitle) return;
    visualKind = visual;
    lastTitle = title;
    try {
      if (chrome.action && chrome.action.setIcon) chrome.action.setIcon({ path: paths });
    } catch (e) { /* ignore */ }
    try {
      if (chrome.action && chrome.action.setTitle) chrome.action.setTitle({ title: title });
    } catch (e2) { /* ignore */ }
  }

  function stopBob() {
    if (bobTimer) {
      try { clearInterval(bobTimer); } catch (e) { /* ignore */ }
      bobTimer = null;
    }
    bobFrame = 0;
  }

  function startBob() {
    if (bobTimer) return;
    bobTimer = setInterval(function () {
      bobFrame = bobFrame ? 0 : 1;
      paint("stream");
    }, BOB_MS);
  }

  function applyIcon(kind) {
    if (kind === "stream") startBob();
    else stopBob();
    paint(kind);
  }

  function activeArenaTab() {
    return new Promise(function (resolve) {
      try {
        chrome.tabs.query({ active: true, lastFocusedWindow: true }, function (tabs) {
          void chrome.runtime.lastError;
          var tab = (tabs && tabs[0]) || null;
          var url = (tab && tab.url) || "";
          resolve(ARENA_TAB_RE.test(url));
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  var refreshing = false;
  AE.refreshStatusLed = function () {
    if (refreshing) return;
    refreshing = true;
    var go = function () {
      var summary = (typeof getStateSummary === "function") ? getStateSummary() : {};
      activeArenaTab().then(function (onArena) {
        applyIcon(AE.statusLedKind({ summary: summary, onArena: onArena }));
        refreshing = false;
      });
    };
    if (typeof AE.nativeStatus === "function") {
      AE.nativeStatus().then(go, go);
    } else {
      go();
    }
  };

  function arm() {
    AE.refreshStatusLed();
    try {
      chrome.tabs.onActivated.addListener(function () { AE.refreshStatusLed(); });
      chrome.tabs.onUpdated.addListener(function (id, info) {
        if (info.status === "complete" || info.url) AE.refreshStatusLed();
      });
    } catch (e) { /* tests */ }
    try {
      setInterval(function () { AE.refreshStatusLed(); }, 4000);
    } catch (e2) { /* service workers may ignore intervals; events still update */ }
  }

  if (typeof chrome !== "undefined" && chrome.runtime) {
    try {
      if (chrome.runtime.onInstalled) chrome.runtime.onInstalled.addListener(arm);
      if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(function () { AE.refreshStatusLed(); });
    } catch (e) { /* tests */ }
    setTimeout(arm, 0);
  }
})();
