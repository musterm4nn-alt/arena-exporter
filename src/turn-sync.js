/* Debounced turn-complete archive sync. Safe when the native host is absent.
 *
 * Everything here is keyed by conversation. Two arena.ai tabs must not share a
 * debounce timer, and must never archive each other's DOM: the snapshot decides
 * models, vote, and response text, so the wrong tab silently writes wrong data. */

var TURN_SYNC_MS = 750;
var turnSyncTimers = {};
var autoArchiveEnabled = true;

function scheduleTurnSync(reason, key, tabId) {
  if (!autoArchiveEnabled) return;
  if (!key) return;
  if (turnSyncTimers[key]) clearTimeout(turnSyncTimers[key]);
  turnSyncTimers[key] = setTimeout(function () {
    delete turnSyncTimers[key];
    runTurnSync(reason || "turn", key, tabId);
  }, TURN_SYNC_MS);
}

function snapshotFromTab(tabId) {
  return new Promise(function (resolve) {
    try {
      chrome.tabs.sendMessage(tabId, { type: "AE_DOM_SNAPSHOT" }, function (res) {
        void chrome.runtime.lastError;
        resolve(res || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

/* Snapshot only the tab that owns `key`. `tabKeys` is the authoritative
 * mapping (it also covers s:<uuid> keys that no page URL resolves to); the
 * URL query is a fallback for syncs with no originating tab, e.g. the popup
 * button. No match means no snapshot — never "any arena tab". */
function fetchArenaSnapshot(key, tabId) {
  if (typeof chrome === "undefined" || !chrome.tabs || !chrome.tabs.query) {
    return Promise.resolve(null);
  }
  if (tabId != null && store.tabKeys[tabId] === key) return snapshotFromTab(tabId);
  return new Promise(function (resolve) {
    try {
      chrome.tabs.query({ url: ["https://arena.ai/*", "https://*.arena.ai/*"] }, function (tabs) {
        if (chrome.runtime && chrome.runtime.lastError) { resolve(null); return; }
        var match = (tabs || []).filter(function (t) {
          return t && t.id != null &&
            (store.tabKeys[t.id] === key || conversationKeyFromUrl(t.url || "") === key);
        })[0];
        resolve(match ? snapshotFromTab(match.id) : null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function runTurnSync(reason, key, tabId) {
  var syncKey = key || store.activeKey || "default";
  var s = store.sessions[syncKey];
  if (!s) return Promise.resolve({ ok: false, error: "unknown session", reason: reason });
  if (!s.messages.length && !Object.keys(s.evaluationStreams || {}).length && !(s.battleVotes && s.battleVotes.length)) {
    return Promise.resolve({ ok: false, error: "nothing to sync", reason: reason });
  }
  return fetchArenaSnapshot(syncKey, tabId).then(function (snapshot) {
    try {
      /* buildExport reads the active session. Point it at ours for the
       * synchronous build only — no awaits inside — then put it back, so a
       * background sync never redirects what the popup is looking at. */
      var prevActive = store.activeKey;
      var out;
      store.activeKey = syncKey;
      try {
        out = buildExport("full_history", snapshot);
        if (AE.decorateArchivePaths) AE.decorateArchivePaths(out.payload, s.archiveRel);
      } finally {
        store.activeKey = prevActive;
      }
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
