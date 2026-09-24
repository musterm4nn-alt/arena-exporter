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

  const ARENA_TAB_RE = /^https:\/\/([^/]+\.)?(arena\.ai|lmarena\.ai)\//i;
  let visualKind = "";
  let lastTitle = "";
  let bobTimer = null;
  let bobFrame = 0;
  const BOB_MS = 450;
  const PATHS = {
    idle: { 16: "icons/led/16-idle.png", 32: "icons/led/32-idle.png", 48: "icons/led/48-idle.png" },
    ok: { 16: "icons/led/16-ok.png", 32: "icons/led/32-ok.png", 48: "icons/led/48-ok.png" },
    stream: { 16: "icons/led/16-stream.png", 32: "icons/led/32-stream.png", 48: "icons/led/48-stream.png" },
    "stream-b": { 16: "icons/led/16-stream-b.png", 32: "icons/led/32-stream-b.png", 48: "icons/led/48-stream-b.png" },
    warn: { 16: "icons/led/16-idle.png", 32: "icons/led/32-idle.png", 48: "icons/led/48-idle.png" },
    error: { 16: "icons/led/16-error.png", 32: "icons/led/32-error.png", 48: "icons/led/48-error.png" }
  };
  const TITLES = {
    idle: "Arena Exporter — idle",
    ok: "Arena Exporter — archive connected",
    stream: "Arena Exporter — capturing",
    "stream-b": "Arena Exporter — capturing",
    warn: "Arena Exporter — archive app not connected",
    error: "Arena Exporter — capture or write error"
  };

  AE.statusLedKind = function (opts) {
    opts = opts || {};
    const summary = opts.summary || {};
    const onArena = !!opts.onArena;
    const native = summary.nativeSink || opts.native || null;
    const lastSync = summary.lastSync || null;
    if (lastSync && lastSync.ok === false) return "error";
    if (summary.captureHealthCritical) return "error";
    if (summary.streaming) return "stream";
    if (!onArena) return "idle";
    if (native && native.state === "ok") return "ok";
    return "warn";
  };

  function paint(kind) {
    let visual = kind === "stream" && bobFrame ? "stream-b" : kind;
    if (kind === "warn") visual = "idle";
    const title = TITLES[kind] || TITLES.idle;
    const paths = PATHS[visual] || PATHS.idle;
    if (visual === visualKind && title === lastTitle) return;
    visualKind = visual;
    lastTitle = title;
    try {
      if (chrome.action && chrome.action.setIcon) {
        const resolved = {};
        Object.keys(paths).forEach(function (size) { resolved[size] = chrome.runtime.getURL(paths[size]); });
        const iconRequest = chrome.action.setIcon({ path: resolved });
        if (iconRequest && iconRequest.catch) iconRequest.catch(function () {
          if (AE.recordIssue) AE.recordIssue("toolbar", "icon_failed");
        });
      }
    } catch (e) { /* ignore */ }
    try {
      if (chrome.action && chrome.action.setTitle) {
        const titleRequest = chrome.action.setTitle({ title: title });
        if (titleRequest && titleRequest.catch) titleRequest.catch(function () {});
      }
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
          const tab = (tabs && tabs[0]) || null;
          const url = (tab && tab.url) || "";
          resolve(ARENA_TAB_RE.test(url) ? tab : null);
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  let refreshing = false, streamExpiry = null;
  AE.refreshStatusLed = function () {
    if (refreshing) return;
    refreshing = true;
    const go = function () {
      activeArenaTab().then(function (tab) {
        const key=tab && canonicalSessionKey(conversationKeyFromUrl(tab.url)||store.tabKeys[tab.id]);
        const session=key && store.sessions[key];
        const summary=session?{streaming:sessionIsStreaming(session),lastSync:session.lastSync,nativeSink:AE.nativeLastStatus(),
          captureHealthCritical:(session.warnings||[]).some(function(w){return w===AE.CAPTURE_HEALTH_MSG.BATTLE_NO_EVAL||w===AE.CAPTURE_HEALTH_MSG.AGENT_NO_STREAM;})}:{};
        applyIcon(AE.statusLedKind({ summary: summary, onArena: !!tab }));
        clearTimeout(streamExpiry);
        if(summary.streaming)streamExpiry=setTimeout(function(){AE.refreshStatusLed();},2700);
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

  }

  if (typeof chrome !== "undefined" && chrome.runtime) {
    try {
      if (chrome.runtime.onInstalled) chrome.runtime.onInstalled.addListener(arm);
      if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(function () { AE.refreshStatusLed(); });
    } catch (e) { /* tests */ }
    setTimeout(arm, 0);
  }
})();
