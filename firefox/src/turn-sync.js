/* Debounced turn-complete archive sync. Prefers the native host, then
 * chrome.downloads.
 *
 * Everything here is keyed by conversation. Two arena.ai tabs must not share a
 * debounce timer, and must never archive each other's DOM: the snapshot decides
 * models, vote, and response text, so the wrong tab silently writes wrong data. */

var TURN_SYNC_MS = 750;
/* Arena reveals model names after the vote, sometimes a beat after the click
 * lands. One snapshot ~1s later can miss the reveal and archive the battle
 * anonymous forever, since nothing else triggers a resync. Labels are the
 * scarcest thing in this dataset, so retry on a backoff until they resolve --
 * and the popup/options page also re-kicks pending labels on open (see the
 * AE_GET_STATE handler), covering sessions left idle longer than this ladder. */
var MODELS_PENDING_RETRY_MS = [3000, 8000, 20000, 45000, 90000];
var turnSyncTimers = {};
var pendingRetries = {};
var autoArchiveEnabled = true;


function tagDownloads(res) {
  if (res) res.sink = res.sink || "downloads";
  return res;
}

/* Native host first. Missing host / failed hello / no-root fall back to
 * chrome.downloads so load-unpacked Chrome and Firefox keep working. */
function writeArchiveBest(payload, files) {
  if (typeof AE.writeArchive !== "function") {
    return Promise.resolve({ ok: false, error: "archive sink missing" });
  }
  if (typeof AE.writeArchiveNative !== "function") {
    return AE.writeArchive(payload, files).then(tagDownloads);
  }
  return AE.writeArchiveNative(payload, files).then(function (res) {
    if (res && res.ok) return res;
    if (res && res.fallback) {
      return AE.writeArchive(payload, files).then(function (dl) {
        if (dl) {
          dl.sink = "downloads";
          dl.nativeError = res.error || null;
        }
        return dl;
      });
    }
    return res || { ok: false, error: "native write failed" };
  });
}

function scheduleTurnSync(reason, key, tabId) {
  key = canonicalSessionKey(key);
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
    return Promise.resolve({ snapshot: null, tabId: tabId != null ? tabId : null });
  }
  function wrap(id) {
    return snapshotFromTab(id).then(function (snap) { return { snapshot: snap, tabId: id }; });
  }
  if (tabId != null && store.tabKeys[tabId] === key) return wrap(tabId);
  return new Promise(function (resolve) {
    try {
      chrome.tabs.query({ url: ["https://arena.ai/*", "https://*.arena.ai/*", "https://lmarena.ai/*", "https://*.lmarena.ai/*"] }, function (tabs) {
        if (chrome.runtime && chrome.runtime.lastError) { resolve({ snapshot: null, tabId: null }); return; }
        var match = (tabs || []).filter(function (t) {
          return t && t.id != null &&
            (store.tabKeys[t.id] === key || conversationKeyFromUrl(t.url || "") === key);
        })[0];
        if (!match) { resolve({ snapshot: null, tabId: null }); return; }
        wrap(match.id).then(resolve);
      });
    } catch (e) {
      resolve({ snapshot: null, tabId: null });
    }
  });
}

function blobToDataUrl(blob) {
  return new Promise(function (resolve, reject) {
    if (typeof FileReader === "function") {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error("read error")); };
      try { fr.readAsDataURL(blob); } catch (e) { reject(e); }
      return;
    }
    blob.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf);
      var bin = "";
      var chunk = 0x8000;
      for (var i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      var mime = blob.type || "application/octet-stream";
      resolve("data:" + mime + ";base64," + btoa(bin));
    }, reject);
  });
}

function fetchOnePrivileged(url) {
  if (typeof AE !== "undefined" && AE.isFetchableArchiveUrl && !AE.isFetchableArchiveUrl(url)) {
    return Promise.resolve({ url: url, ok: false, error: "blocked origin" });
  }
  var arenaHost = false;
  try {
    arenaHost = /^([a-z0-9-]+\.)*(arena\.ai|lmarena\.ai)$/i.test(new URL(String(url), "https://arena.ai/").hostname);
  } catch (e) { arenaHost = false; }
  return fetch(url, { credentials: arenaHost ? "include" : "omit", cache: "no-store" })
    .then(function (resp) {
      if (!resp.ok) return { url: url, ok: false, error: "HTTP " + resp.status };
      var ct = "";
      try { ct = (resp.headers.get("content-type") || "").split(";")[0]; } catch (e) { /* ignore */ }
      return resp.blob().then(function (blob) {
        if (blob.size > 15 * 1024 * 1024) {
          return { url: url, ok: false, error: "too large (" + Math.round(blob.size / 1024) + " KB)" };
        }
        return blobToDataUrl(blob).then(function (dataUrl) {
          return { url: url, ok: true, dataUrl: dataUrl, bytes: blob.size, contentType: ct };
        });
      });
    })
    .catch(function (e) {
      return { url: url, ok: false, error: String((e && e.message) || e).slice(0, 120) };
    });
}

function fetchArchiveAttachments(tabId, urls) {
  if (tabId == null || !urls || !urls.length) return Promise.resolve([]);
  if (typeof chrome === "undefined" || !chrome.tabs || !chrome.tabs.sendMessage) return Promise.resolve([]);
  return new Promise(function (resolve) {
    try {
      chrome.tabs.sendMessage(tabId, { type: "AE_FETCH_ATTACHMENTS", urls: urls }, function (res) {
        void chrome.runtime.lastError;
        resolve((res && res.results) || []);
      });
    } catch (e) {
      resolve([]);
    }
  });
}

function fetchAttachmentsBest(tabId, urls) {
  urls = urls || [];
  if (!urls.length) return Promise.resolve([]);
  return fetchArchiveAttachments(tabId, urls).then(function (results) {
    var byUrl = {};
    (results || []).forEach(function (r) { if (r && r.url) byUrl[r.url] = r; });
    var missing = urls.filter(function (u) {
      var r = byUrl[u];
      return !r || !r.ok || !r.dataUrl;
    });
    if (!missing.length) return urls.map(function (u) { return byUrl[u]; });
    var chain = Promise.resolve();
    var extra = [];
    missing.forEach(function (u, i) {
      chain = chain.then(function () {
        return fetchOnePrivileged(u).then(function (r) { extra[i] = r; });
      });
    });
    return chain.then(function () {
      extra.forEach(function (r) { if (r && r.url) byUrl[r.url] = r; });
      return urls.map(function (u) { return byUrl[u] || { url: u, ok: false, error: "no result" }; });
    });
  });
}

AE.fetchAttachmentsBest = fetchAttachmentsBest;

AE.finalizeArchivePayload = function (payload, opts) {
  opts = opts || {};
  payload = payload || {};
  if (AE.applyHonestSubtype) AE.applyHonestSubtype(payload);
  var urls = AE.collectArtifactUrls ? AE.collectArtifactUrls(payload) : [];
  var after = (!urls.length)
    ? Promise.resolve(payload)
    : fetchAttachmentsBest(opts.tabId, urls).then(function (results) {
        if (AE.applyFetchedFiles) AE.applyFetchedFiles(payload, results);
        return payload;
      });
  return after.then(function () {
    if (AE.scrubSecrets) {
      var clean = AE.scrubSecrets(payload);
      Object.keys(payload).forEach(function (key) { delete payload[key]; });
      Object.assign(payload, clean);
    }
    if (AE.decorateArchivePaths) AE.decorateArchivePaths(payload, opts.existingRel || (payload.archive && payload.archive.rel) || null);
    if (AE.applyCompletenessMeta) AE.applyCompletenessMeta(payload);
    return payload;
  });
};

function enrichPayloadFiles(s, payload, snapshot, tabId) {
  var existingRel = (s && s.archiveRel) || (payload.archive && payload.archive.rel) || null;
  return AE.finalizeArchivePayload(payload, { tabId: tabId, existingRel: existingRel }).then(function () {
    var urlOnly = AE.listUrlOnlyFiles ? AE.listUrlOnlyFiles(payload) : [];
    if (typeof applyCaptureHealth === "function") {
      applyCaptureHealth(s, snapshot, { urlOnlyFiles: urlOnly, payload: payload });
    }
    if (payload.meta) {
      payload.meta.warnings = (s.warnings || []).slice().concat(payload.meta.warnings || []).filter(function (w, i, arr) {
        return w && arr.indexOf(w) === i;
      });
      if (AE.applyCompletenessMeta) AE.applyCompletenessMeta(payload);
    }
    return payload;
  });
}

/* True when a battle has been voted on but its models are still unnamed --
 * i.e. the reveal has not been scraped yet and the sample is unlabeled. */
function battleLabelsPending(payload) {
  var battles = (payload && payload.battles) || [];
  if (!battles.length) return false;
  var latest = battles[battles.length - 1];
  if (latest.mode && latest.mode !== "battle") return false;
  var voted = !!(latest.vote_choice || (latest.outcome && latest.outcome !== "pending"));
  if (!voted) return false;
  return (latest.contestants || []).some(function (c) { return !c || !c.model; });
}

function scheduleLabelRetry(key, tabId, reason) {
  var attempt = pendingRetries[key] || 0;
  if (attempt >= MODELS_PENDING_RETRY_MS.length) return;
  pendingRetries[key] = attempt + 1;
  setTimeout(function () {
    runTurnSync(reason + "_label_retry", key, tabId);
  }, MODELS_PENDING_RETRY_MS[attempt]);
}

function runTurnSync(reason, key, tabId) {
  var syncKey = canonicalSessionKey(key || store.activeKey) || "default";
  var s = store.sessions[syncKey];
  /* Manual sync must also repair chats reopened after their capture session was
   * evicted or the extension was reloaded. The page DOM is enough to rebuild a
   * useful export, but the old preflight rejected the empty session before it
   * ever requested that DOM snapshot. */
  if (!s && reason === "manual") {
    s = freshState(syncKey);
    store.sessions[syncKey] = s;
    if (tabId != null) {
      store.tabKeys[tabId] = syncKey;
      store.tabKeys[String(tabId)] = syncKey;
    }
  }
  if (!s) return Promise.resolve({ ok: false, error: "unknown session", reason: reason });
  return fetchArenaSnapshot(syncKey, tabId).then(function (got) {
    syncKey = canonicalSessionKey(syncKey);
    s = store.sessions[syncKey] || s;
    var snapshot = got && got.snapshot ? got.snapshot : null;
    if (snapshot && snapshot.url) {
      var snapshotKey = canonicalSessionKey(conversationKeyFromUrl(snapshot.url));
      if ((snapshotKey && snapshotKey !== syncKey) || (!snapshotKey && /^c:/.test(syncKey))) snapshot = null;
    }
    var snapTabId = got && got.tabId != null ? got.tabId : tabId;
    try {
      if (snapshot && snapshot.url) s.session.url = snapshot.url;
      if (snapshot && snapshot.title) s.session.title = snapshot.title;
      /* buildExport reads the active session. Point it at ours for the
       * synchronous build only — no awaits inside — then put it back, so a
       * background sync never redirects what the popup is looking at. */
      var prevActive = store.activeKey;
      var out;
      store.activeKey = syncKey;
      try {
        out = buildExport("full_history", snapshot);
        /* s.archiveRel is only a session-lifetime cache; AE.writeArchive
         * re-resolves against the persistent index, which is what pins the
         * folder across browser restarts. */
        if (AE.decorateArchivePaths) AE.decorateArchivePaths(out.payload, s.archiveRel);
      } finally {
        store.activeKey = prevActive;
      }
      if (!((out.payload.messages || []).length || (out.payload.battles || []).length || (out.payload.meta.request_attempts || []).length)) {
        s.lastSync = { at: new Date().toISOString(), ok: false, error: "nothing to sync", reason: reason };
        return s.lastSync;
      }
      return enrichPayloadFiles(s, out.payload, snapshot, snapTabId).then(function (payload) {
      var files = AE.filesToWrite ? AE.filesToWrite(payload) : [];
      if (typeof AE.writeArchive !== "function") {
        s.lastSync = { at: new Date().toISOString(), ok: false, error: "archive sink missing", reason: reason };
        return s.lastSync;
      }
      var labelsPending = battleLabelsPending(payload);
      s.labelsPending = labelsPending;
      return writeArchiveBest(payload, files).then(function (res) {
        var firstFailure = res && res.failed && res.failed.length ? res.failed[0].error : null;
        s.lastSync = {
          at: new Date().toISOString(),
          ok: !!(res && res.ok),
          error: (res && res.error) || firstFailure || null,
          rel: (res && res.rel) || null,
          written: (res && res.written) || [],
          skipped: (res && res.skipped) || 0,
          reason: reason,
          sink: (res && res.sink) || "downloads",
          labels_pending: labelsPending,
          completeness: payload.meta && payload.meta.completeness_detail
            ? payload.meta.completeness_detail.status
            : (payload.meta && payload.meta.completeness) || null
        };
        if (res && res.rel) s.archiveRel = res.rel;
        if (labelsPending) scheduleLabelRetry(syncKey, tabId, reason);
        else {
          delete pendingRetries[syncKey];
          s.labelsPending = false;
        }
        scheduleSave();
        return s.lastSync;
      });
      });
    } catch (e) {
      s.lastSync = { at: new Date().toISOString(), ok: false, error: String(e), reason: reason };
      return s.lastSync;
    }
  });
}
