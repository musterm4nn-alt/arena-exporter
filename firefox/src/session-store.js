/* Multi-session capture store. Events are routed by conversation id
 * (page /c/<id> or realtime session UUID), not by a single process-wide
 * state object. Classic-script globals — loaded via importScripts. */

var STATE_KEY = "ae_store_v2";
var LEGACY_STATE_KEY = "ae_state_v1";
var DEDUPE_CAP = 20000;
var MAX_SESSIONS = 12;
var EVAL_TOTAL_CAP = 4 * 1024 * 1024; // raw battle stream bytes retained per session
var MAX_WARNINGS = 50;

var store = {
  sessions: {},
  tabKeys: {},
  tabPages: {},
  aliases: {},
  requestKeys: {},
  activeKey: null
};

var stateReady = false;
var pendingEvents = [];
var stateReadyResolve = null;
var stateReadyPromise = new Promise(function (resolve) { stateReadyResolve = resolve; });
var saveTimer = null;
var seenByKey = {};

function genId(prefix) {
  return prefix + "_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function stripKeyPrefix(key) {
  var k = String(key || "");
  if (k.indexOf("c:") === 0 || k.indexOf("s:") === 0) return k.slice(2);
  return k;
}

function freshState(key) {
  key = key || "default";
  return {
    session: {
      session_id: /^[cs]:/.test(key) ? stripKeyPrefix(key) : genId("sess"),
      conversation_key: key,
      started_at: new Date().toISOString(),
      url: "",
      title: ""
    },
    messages: [],
    messageIndex: {},
    endpoints: [],
    warnings: [],
    streamSamples: [],
    evaluationStreams: {},
    evaluationActive: {},
    evaluationSequence: {},
    capturedRequests: [],
    requestAttempts: [],
    evaluationRequests: {},
    transport: { event_counts: {}, headers: {}, completed_turns: [] },
    modelCatalog: null,
    transcriptMetadata: null,
    recordSequences: {},
    battleVotes: [],
    stats: { events: 0, unknown: 0, streamChunks: 0, lastEventAt: 0 },
    streamBuilders: {},
    currentStreamKey: null,
    streamDirty: false,
    truncatedEval: false,
    storageError: false,
    modelHints: {},
    labelsPending: false
  };
}

function hydrateSession(raw, key) {
  var s = freshState(key);
  if (!raw || typeof raw !== "object") return s;
  s.session = Object.assign(s.session, raw.session && typeof raw.session === "object" ? raw.session : {});
  s.session.conversation_key = key;
  if (!Array.isArray(raw.messages)) s.messages = [];
  else s.messages = raw.messages;
  s.messageIndex = raw.messageIndex && typeof raw.messageIndex === "object" ? raw.messageIndex : {};
  if (!Array.isArray(raw.endpoints)) s.endpoints = [];
  else s.endpoints = raw.endpoints;
  if (!Array.isArray(raw.warnings)) s.warnings = [];
  else s.warnings = raw.warnings;
  if (!Array.isArray(raw.streamSamples)) s.streamSamples = [];
  else s.streamSamples = raw.streamSamples;
  s.evaluationStreams = raw.evaluationStreams && typeof raw.evaluationStreams === "object" ? raw.evaluationStreams : {};
  s.evaluationActive = raw.evaluationActive && typeof raw.evaluationActive === "object" ? raw.evaluationActive : {};
  s.evaluationSequence = raw.evaluationSequence && typeof raw.evaluationSequence === "object" ? raw.evaluationSequence : {};
  if (!Array.isArray(raw.capturedRequests)) s.capturedRequests = [];
  else s.capturedRequests = raw.capturedRequests;
  s.requestAttempts = Array.isArray(raw.requestAttempts) ? raw.requestAttempts : [];
  s.evaluationRequests = raw.evaluationRequests || {};
  s.transport = Object.assign(s.transport, raw.transport || {});
  s.modelCatalog = raw.modelCatalog || null;
  s.transcriptMetadata = raw.transcriptMetadata || null;
  s.seenRecordIds = Array.isArray(raw.seenRecordIds) ? raw.seenRecordIds.slice(-2000) : [];
  s.recordSequences = raw.recordSequences || {};
  if (!Array.isArray(raw.battleVotes)) s.battleVotes = [];
  else s.battleVotes = raw.battleVotes;
  s.stats = Object.assign({ events: 0, unknown: 0, streamChunks: 0, lastEventAt: 0 }, raw.stats || {});
  s.streamBuilders = raw.streamBuilders && typeof raw.streamBuilders === "object" ? raw.streamBuilders : {};
  s.currentStreamKey = raw.currentStreamKey || null;
  s.streamDirty = false;
  s.truncatedEval = !!raw.truncatedEval;
  s.storageError = !!raw.storageError;
  s.modelHints = raw.modelHints && typeof raw.modelHints === "object" ? raw.modelHints : {};
  s.labelsPending = !!raw.labelsPending;
  (s.messages || []).forEach(function (m, index) {
    if (m && m.id != null && s.messageIndex[m.id] == null) s.messageIndex[m.id] = index;
    ((m && m.content) || []).forEach(function (b) { registerSeenOn(s, b); });
  });
  return s;
}

function conversationKeyFromUrl(url) {
  url = String(url || "");
  var m = /\/(?:c|agent)\/([A-Za-z0-9_-]+)/.exec(url);
  if (m) return "c:" + m[1];
  m = /\/realtime\/v[0-9]+\/sessions\/([0-9a-fA-F-]{8,})\//i.exec(url);
  if (m) return "s:" + m[1];
  m = /\/api\/chat\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/i.exec(url);
  if (m) return "s:" + m[1];
  return null;
}

function seenSetFor(s) {
  var k = (s && s.session && s.session.conversation_key) || store.activeKey || "default";
  if (!seenByKey[k]) seenByKey[k] = new Set();
  return seenByKey[k];
}

function blockHash(b) {
  if (!b || !b.type) return "unknown";
  if (b.call_id) return b.type + "|call|" + String(b.call_id);
  if (b.type === "thinking" || b.type === "text") {
    return b.type + "|t|" + String(b.text || "");
  }
  var core = b.command != null
    ? { command: b.command, exit_code: b.exit_code == null ? null : b.exit_code }
    : {
        t: b.type,
        id: b.id || null,
        n: b.tool_name || b.action || null,
        a: b.arguments,
        o: b.output,
        target: b.target || null,
        title: b.title || null
      };
  return b.type + "|" + String(JSON.stringify(core));
}

function registerSeenOn(s, b) {
  if (!b || !b.type) return;
  var set = seenSetFor(s);
  var h = blockHash(b);
  if (set.has(h)) {
    set.delete(h);
    set.add(h);
    return;
  }
  if (set.size >= DEDUPE_CAP) {
    var first = set.values().next().value;
    if (first != null) set.delete(first);
  }
  set.add(h);
}

function isDuplicateOn(s, b) {
  if (b.partial) return false;
  var h = blockHash(b);
  var set = seenSetFor(s);
  if (set.has(h)) return true;
  registerSeenOn(s, b);
  return false;
}

function ensureState() {
  store.activeKey = canonicalSessionKey(store.activeKey);
  if (!store.activeKey || !store.sessions[store.activeKey]) {
    var k = store.activeKey || "default";
    store.activeKey = k;
    if (!store.sessions[k]) store.sessions[k] = freshState(k);
  }
  return store.sessions[store.activeKey];
}

function canonicalSessionKey(key) {
  var visited = {};
  while (key && store.aliases[key] && !visited[key]) {
    visited[key] = true;
    key = store.aliases[key];
  }
  return key;
}

function migrateSession(fromKey, toKey) {
  fromKey = canonicalSessionKey(fromKey);
  toKey = canonicalSessionKey(toKey);
  if (!fromKey || !toKey || fromKey === toKey) return;
  var src = store.sessions[fromKey];
  if (src && !store.sessions[toKey]) {
    store.sessions[toKey] = src;
    src.session.conversation_key = toKey;
    if (toKey.indexOf("s:") === 0 || toKey.indexOf("c:") === 0) {
      src.session.session_id = stripKeyPrefix(toKey);
    }
    seenByKey[toKey] = seenByKey[fromKey] || seenSetFor(src);
    delete seenByKey[fromKey];
    delete store.sessions[fromKey];
  } else if (src) {
    /* Real destination already exists. The source bucket can still hold real
     * data (e.g. a "default"/placeholder bucket that captured events before
     * the conversation key was known), so fold it into the destination
     * instead of dropping it on the floor. */
    var dst = store.sessions[toKey];
    (src.messages || []).forEach(function (m) {
      var existingIndex = m && m.id != null ? dst.messageIndex[m.id] : null;
      if (existingIndex == null) {
        dst.messages.push(m);
        if (m && m.id != null) dst.messageIndex[m.id] = dst.messages.length - 1;
      } else {
        var old = dst.messages[existingIndex];
        // Aliases can both contain the same message; retain the fuller capture.
        var merged = Object.assign({}, old, m);
        merged.content = JSON.stringify(old.content || []).length > JSON.stringify(m.content || []).length
          ? old.content : m.content;
        dst.messages[existingIndex] = merged;
      }
      ((m && m.content) || []).forEach(function (b) { registerSeenOn(dst, b); });
    });
    (src.warnings || []).forEach(function (w) { addWarning(dst, w); });
    (src.battleVotes || []).forEach(function (v) { dst.battleVotes.push(v); });
    (src.capturedRequests || []).forEach(function (r) { dst.capturedRequests.push(r); });
    (src.requestAttempts || []).forEach(function (r) {
      if (!dst.requestAttempts.some(function (a) { return a.request_id === r.request_id; })) dst.requestAttempts.push(r);
    });
    (src.endpoints || []).forEach(function (e) { dst.endpoints.push(e); });
    dst.endpoints = dst.endpoints.slice(-200);
    dst.streamSamples = dst.streamSamples.concat(src.streamSamples || []).slice(0, 20);
    ["evaluationActive", "evaluationSequence", "evaluationRequests", "streamBuilders", "modelHints"].forEach(function (field) {
      dst[field] = Object.assign({}, src[field] || {}, dst[field] || {});
    });
    if (!dst.currentStreamKey) dst.currentStreamKey = src.currentStreamKey;
    dst.streamDirty = dst.streamDirty || src.streamDirty;
    if (!dst.modelCatalog) dst.modelCatalog = src.modelCatalog;
    if (!dst.transcriptMetadata) dst.transcriptMetadata = src.transcriptMetadata;
    dst.seenRecordIds = Array.from(new Set((dst.seenRecordIds || []).concat(src.seenRecordIds || []))).slice(-2000);
    Object.keys(src.recordSequences || {}).forEach(function (url) {
      dst.recordSequences[url] = Math.max(dst.recordSequences[url] == null ? -1 : dst.recordSequences[url], src.recordSequences[url]);
    });
    Object.keys((src.transport && src.transport.event_counts) || {}).forEach(function (kind) {
      dst.transport.event_counts[kind] = (dst.transport.event_counts[kind] || 0) + src.transport.event_counts[kind];
    });
    dst.transport.headers = Object.assign({}, (src.transport || {}).headers, dst.transport.headers);
    dst.transport.completed_turns = Array.from(new Set(dst.transport.completed_turns.concat((src.transport || {}).completed_turns || [])));
    Object.keys(src.evaluationStreams || {}).forEach(function (ek) {
      if (dst.evaluationStreams[ek] == null) {
        dst.evaluationStreams[ek] = src.evaluationStreams[ek];
        if (src.evaluationSequence && src.evaluationSequence[ek] != null && dst.evaluationSequence[ek] == null) {
          dst.evaluationSequence[ek] = src.evaluationSequence[ek];
        }
      }
    });
    if (src.stats) {
      dst.stats.events = (dst.stats.events || 0) + (src.stats.events || 0);
      dst.stats.unknown = (dst.stats.unknown || 0) + (src.stats.unknown || 0);
      dst.stats.streamChunks = (dst.stats.streamChunks || 0) + (src.stats.streamChunks || 0);
      dst.stats.lastEventAt = Math.max(dst.stats.lastEventAt || 0, src.stats.lastEventAt || 0);
    }
    if (src.truncatedEval) dst.truncatedEval = true;
    if (!dst.session.url && src.session.url) dst.session.url = src.session.url;
    if (!dst.session.title && src.session.title) dst.session.title = src.session.title;
    if (!dst.session.realtime_session_id) dst.session.realtime_session_id = src.session.realtime_session_id || null;
    if (/^[cs]:/.test(toKey)) dst.session.session_id = stripKeyPrefix(toKey);
    delete store.sessions[fromKey];
    delete seenByKey[fromKey];
  }
  store.aliases[fromKey] = toKey;
  Object.keys(store.requestKeys).forEach(function (id) {
    if (store.requestKeys[id] === fromKey) store.requestKeys[id] = toKey;
  });
  Object.keys(store.tabKeys).forEach(function (tid) {
    if (store.tabKeys[tid] === fromKey) store.tabKeys[tid] = toKey;
  });
  if (store.activeKey === fromKey) store.activeKey = toKey;
}

function isPlaceholderKey(key) {
  return !key || key === "default" || String(key).indexOf("tab:") === 0;
}

function resolveSessionForEvent(evt, sender) {
  evt = evt || {};
  if (evt.conversationKey && !/^[cs]:[A-Za-z0-9_-]{1,160}$/.test(evt.conversationKey)) delete evt.conversationKey;
  if (evt.requestId && (!/^[A-Za-z0-9:_-]{1,180}$/.test(evt.requestId) || /^(?:__proto__|constructor|prototype)$/.test(evt.requestId))) delete evt.requestId;
  var tabId = sender && sender.tab && sender.tab.id != null ? sender.tab.id : null;
  var tabUrl = sender && sender.tab && sender.tab.url ? String(sender.tab.url) : "";
  var pageUrl = evt.pageUrl || (evt.kind === "page_context" ? evt.url : tabUrl) || "";
  var pageKey = conversationKeyFromUrl(pageUrl);
  var prev = canonicalSessionKey(tabId != null ? store.tabKeys[tabId] : null);
  var placeholder = tabId != null ? "tab:" + tabId : "default";
  var key = evt.requestId ? canonicalSessionKey(store.requestKeys[evt.requestId]) : null;
  var hint = evt.kind === "session_hint" && evt.sessionId ? "s:" + evt.sessionId : null;
  if (evt.kind === "page_context") {
    if (!pageKey && !evt.conversationKey) delete store.aliases[placeholder];
    key = canonicalSessionKey(evt.conversationKey || pageKey) || placeholder;
    if (tabId != null) store.tabPages[tabId] = pageUrl;
    // A page id appearing after /out starts binds the two names for this chat.
    if (prev && prev !== key && !isPlaceholderKey(key) &&
        (isPlaceholderKey(prev) || (prev.indexOf("s:") === 0 &&
         !conversationKeyFromUrl((store.sessions[prev] || {}).session && store.sessions[prev].session.url)))) {
      migrateSession(prev, key);
    }
  }
  if (!key) key = canonicalSessionKey(pageKey) || prev || placeholder;
  if (hint) {
    if (isPlaceholderKey(key) || (!pageKey && /^s:/.test(key) && canonicalSessionKey(hint) !== key)) key = canonicalSessionKey(hint);
    else if (canonicalSessionKey(hint) !== key && !/^c:/.test(canonicalSessionKey(hint))) migrateSession(hint, key);
  }
  // A client-generated evaluation id binds request and response even if the
  // page navigates while fetch is pending. It is not a model identifier.
  if (evt.kind === "request" && /create-evaluation/i.test(evt.url || "")) {
    try {
      var request = JSON.parse(evt.body || "{}");
      if (typeof request.id === "string" && /^[A-Za-z0-9_-]+$/.test(request.id)) key = "c:" + request.id;
    } catch (e) { /* partial request */ }
  }
  if (evt.kind === "request" && /create-chat/i.test(evt.url || "")) {
    key = placeholder + ":" + (evt.requestId || genId("request"));
  }
  if (prev && key !== prev && isPlaceholderKey(prev) && !isPlaceholderKey(key)) migrateSession(prev, key);
  key = canonicalSessionKey(key);

  if (!store.sessions[key]) store.sessions[key] = freshState(key);
  store.activeKey = key;
  var currentPage = tabId != null ? store.tabPages[tabId] : null;
  if (tabId != null && (!evt.pageUrl || !currentPage || evt.pageUrl === currentPage || evt.kind === "page_context")) {
    store.tabKeys[tabId] = key;
  }
  if (evt.requestId) store.requestKeys[evt.requestId] = key;
  var s = store.sessions[key];
  if (!s.session.url && pageUrl) s.session.url = pageUrl;
  s.session.conversation_key = key;
  if (evt && evt.kind === "session_hint" && evt.sessionId) {
    s.session.realtime_session_id = evt.sessionId;
  }
  if (evt && evt.kind === "page_context") {
    if (evt.url) s.session.url = evt.url;
    if (evt.title) s.session.title = evt.title;
  }
  return s;
}

/* Warnings are persisted and copied into every export, and some sources (a
 * flapping stream, repeated save failures) can fire indefinitely. Dedupe and
 * cap so they stay a signal rather than a leak. */
function addWarning(s, text) {
  if (!s || !text) return;
  if (!Array.isArray(s.warnings)) s.warnings = [];
  if (s.warnings.indexOf(text) !== -1) return;
  s.warnings.push(text);
  if (s.warnings.length > MAX_WARNINGS) s.warnings.shift();
}

function lastActivity(s) {
  return (s && s.stats && s.stats.lastEventAt) || 0;
}

/* A single battle round can hold megabytes of raw stream. Keep the newest
 * rounds within a byte budget; never drop the round still being captured. */
function pruneEvaluationStreams(s) {
  if (!s || !s.evaluationStreams) return;
  var keys = Object.keys(s.evaluationStreams); // insertion order == round order
  var total = 0;
  for (var i = 0; i < keys.length; i++) total += (s.evaluationStreams[keys[i]] || "").length;
  var dropped = 0;
  while (total > EVAL_TOTAL_CAP && keys.length > 1) {
    var oldest = keys.shift();
    total -= (s.evaluationStreams[oldest] || "").length;
    delete s.evaluationStreams[oldest];
    dropped++;
  }
  if (dropped) {
    s.truncatedEval = true;
    addWarning(s, "Dropped " + dropped + " older battle round(s) from the capture buffer to stay within extension storage limits.");
  }
}

/* chrome.storage.session is a ~10MB budget for the whole extension, and
 * sessions accumulate for the life of the browser session. Unpruned, one busy
 * afternoon fills the quota and then *every* conversation silently stops
 * persisting. Evict least-recently-active first, never the active one. */
function pruneStore() {
  var requestIds = Object.keys(store.requestKeys);
  requestIds.slice(0, Math.max(0, requestIds.length - 2000)).forEach(function (id) { delete store.requestKeys[id]; });
  var keys = Object.keys(store.sessions);
  keys.forEach(function (k) { pruneEvaluationStreams(store.sessions[k]); });
  if (keys.length <= MAX_SESSIONS) return;
  var removable = keys.filter(function (k) { return k !== store.activeKey; })
    .sort(function (a, b) { return lastActivity(store.sessions[a]) - lastActivity(store.sessions[b]); });
  removable.slice(0, keys.length - MAX_SESSIONS).forEach(function (k) {
    delete store.sessions[k];
    delete seenByKey[k];
    Object.keys(store.tabKeys).forEach(function (tid) {
      if (store.tabKeys[tid] === k) delete store.tabKeys[tid];
    });
    Object.keys(store.aliases).forEach(function (alias) {
      if (canonicalSessionKey(alias) === k) delete store.aliases[alias];
    });
    Object.keys(store.requestKeys).forEach(function (id) {
      if (store.requestKeys[id] === k) delete store.requestKeys[id];
    });
  });
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(function () {
    saveTimer = null;
    try {
      /* Deltas only mark their message stale; make it whole before persisting
       * so an evicted service worker resumes with the text it had. */
      if (typeof flushAllStreamMessages === "function") flushAllStreamMessages();
      pruneStore();
      var payload = {
        sessions: store.sessions,
        tabKeys: store.tabKeys,
        tabPages: store.tabPages,
        aliases: store.aliases,
        requestKeys: store.requestKeys,
        activeKey: store.activeKey
      };
      var saveResult = captureStorageArea().set({ [STATE_KEY]: payload });
      if (saveResult && typeof saveResult.catch === "function") {
        saveResult.catch(function () {
          var s = ensureState();
          s.storageError = true;
          addWarning(s, "Session persistence failed (storage full or unavailable). Capture continues in memory only.");
        });
      }
    } catch (e) {
      var s = ensureState();
      s.storageError = true;
    }
  }, 500);
}

function finishStateLoad(r) {
  if (stateReady) return;
  r = r || {};
  if (r[STATE_KEY] && typeof r[STATE_KEY] === "object") {
    var packed = r[STATE_KEY];
    store.tabKeys = packed.tabKeys && typeof packed.tabKeys === "object" ? packed.tabKeys : {};
    store.tabPages = packed.tabPages || {};
    store.aliases = packed.aliases || {};
    store.requestKeys = packed.requestKeys || {};
    store.activeKey = packed.activeKey || null;
    var sessions = packed.sessions && typeof packed.sessions === "object" ? packed.sessions : {};
    Object.keys(sessions).forEach(function (k) {
      store.sessions[k] = hydrateSession(AE.scrubSecrets ? AE.scrubSecrets(sessions[k]) : sessions[k], k);
    });
  } else if (r[LEGACY_STATE_KEY] && typeof r[LEGACY_STATE_KEY] === "object") {
    store.sessions.default = hydrateSession(r[LEGACY_STATE_KEY], "default");
    store.activeKey = "default";
  }
  if (!store.activeKey || !store.sessions[store.activeKey]) {
    store.activeKey = store.activeKey || "default";
    if (!store.sessions[store.activeKey]) store.sessions[store.activeKey] = freshState(store.activeKey);
  }
  stateReady = true;
  var queued = pendingEvents;
  pendingEvents = [];
  queued.forEach(function (item) {
    handleEvent(item.evt, item.sender);
  });
  if (stateReadyResolve) {
    stateReadyResolve();
    stateReadyResolve = null;
  }
}

function clearActiveSession() {
  var k = store.activeKey || "default";
  store.sessions[k] = freshState(k);
  seenByKey[k] = new Set();
  scheduleSave();
}

function listSessionSummaries() {
  return Object.keys(store.sessions).map(function (k) {
    var s = store.sessions[k];
    return {
      key: k,
      sessionId: s.session.session_id,
      title: s.session.title || "",
      url: s.session.url,
      messageCount: (s.messages || []).length,
      battleVoteCount: Array.isArray(s.battleVotes) ? s.battleVotes.length : 0,
      lastEventAt: (s.stats && s.stats.lastEventAt) || 0,
      active: k === store.activeKey
    };
  }).sort(function (a, b) { return (b.lastEventAt || 0) - (a.lastEventAt || 0); });
}

/* In-memory capture is persisted in chrome.storage.session when present
 * (Chrome, Firefox 115+). If that area is missing, fall back to local for
 * this payload only — local survives browser restarts, unlike session. */
function captureStorageArea() {
  try {
    if (chrome.storage && chrome.storage.session && typeof chrome.storage.session.get === "function") {
      return chrome.storage.session;
    }
  } catch (e) { /* session area unavailable */ }
  return chrome.storage.local;
}

function startStoreLoad() {
  try {
    var loadResult = captureStorageArea().get([STATE_KEY, LEGACY_STATE_KEY]);
    if (loadResult && typeof loadResult.then === "function") {
      loadResult.then(finishStateLoad).catch(function () { finishStateLoad({}); });
    } else {
      finishStateLoad(loadResult || {});
    }
  } catch (e) {
    finishStateLoad({});
  }
}
