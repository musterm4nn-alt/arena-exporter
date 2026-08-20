/* Debounced turn-complete archive sync. Safe when the native host is absent. */

var TURN_SYNC_MS = 750;
var turnSyncTimer = null;
var autoArchiveEnabled = true;

function scheduleTurnSync(reason) {
  if (!autoArchiveEnabled) return;
  if (turnSyncTimer) clearTimeout(turnSyncTimer);
  turnSyncTimer = setTimeout(function () {
    turnSyncTimer = null;
    runTurnSync(reason || "turn");
  }, TURN_SYNC_MS);
}

function fetchArenaSnapshots() {
  return new Promise(function (resolve) {
    if (typeof chrome === "undefined" || !chrome.tabs || !chrome.tabs.query) {
      resolve(null);
      return;
    }
    try {
      chrome.tabs.query({ url: ["https://arena.ai/*", "https://*.arena.ai/*"] }, function (tabs) {
        if (chrome.runtime && chrome.runtime.lastError) { resolve(null); return; }
        if (!tabs || !tabs.length) { resolve(null); return; }
        var tab = tabs[0];
        chrome.tabs.sendMessage(tab.id, { type: "AE_DOM_SNAPSHOT" }, function (res) {
          void chrome.runtime.lastError;
          resolve(res || null);
        });
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function runTurnSync(reason) {
  var s = ensureState();
  if (!s.messages.length && !Object.keys(s.evaluationStreams || {}).length && !(s.battleVotes && s.battleVotes.length)) {
    return Promise.resolve({ ok: false, error: "nothing to sync", reason: reason });
  }
  return fetchArenaSnapshots().then(function (snapshot) {
  try {
    var out = buildExport("full_history", snapshot);
    if (AE.decorateArchivePaths) AE.decorateArchivePaths(out.payload, s.archiveRel);
    var files = AE.filesToWrite ? AE.filesToWrite(out.payload) : [];
    if (typeof syncArchive !== "function") {
      s.lastSync = { at: new Date().toISOString(), ok: false, error: "native client missing", reason: reason };
      return s.lastSync;
    }
    return syncArchive(out.payload, files).then(function (res) {
      s.lastSync = {
        at: new Date().toISOString(),
        ok: !!(res && res.ok),
        error: (res && (res.error || res.message)) || null,
        rel: (res && res.rel) || null,
        reason: reason
      };
      if (res && res.rel) s.archiveRel = res.rel;
      scheduleSave();
      return s.lastSync;
    });
  } catch (e) {
    s.lastSync = { at: new Date().toISOString(), ok: false, error: String(e), reason: reason };
    return s.lastSync;
  }
  });
}
