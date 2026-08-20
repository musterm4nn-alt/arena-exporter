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
      session_id: key !== "default" ? stripKeyPrefix(key) : genId("sess"),
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
    battleVotes: [],
    stats: { events: 0, unknown: 0, streamChunks: 0, lastEventAt: 0 },
    streamBuilders: {},
    currentStreamKey: null,
    streamDirty: false,
    truncatedEval: false,
    storageError: false
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
  if (!Array.isArray(raw.battleVotes)) s.battleVotes = [];
  else s.battleVotes = raw.battleVotes;
  s.stats = Object.assign({ events: 0, unknown: 0, streamChunks: 0, lastEventAt: 0 }, raw.stats || {});
  s.streamBuilders = raw.streamBuilders && typeof raw.streamBuilders === "object" ? raw.streamBuilders : {};
  s.currentStreamKey = raw.currentStreamKey || null;
  s.streamDirty = false;
  s.truncatedEval = !!raw.truncatedEval;
  s.storageError = !!raw.storageError;
  (s.messages || []).forEach(function (m, index) {
    if (m && m.id != null && s.messageIndex[m.id] == null) s.messageIndex[m.id] = index;
    ((m && m.content) || []).forEach(function (b) { registerSeenOn(s, b); });
  });
  return s;
}

function conversationKeyFromUrl(url) {
  url = String(url || "");
  var m = /\/c\/([A-Za-z0-9_-]+)/.exec(url);
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
  if (!store.activeKey || !store.sessions[store.activeKey]) {
    var k = store.activeKey || "default";
    store.activeKey = k;
    if (!store.sessions[k]) store.sessions[k] = freshState(k);
  }
  return store.sessions[store.activeKey];
}

function migrateSession(fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey) return;
  var src = store.sessions[fromKey];
  if (!src) return;
  if (!store.sessions[toKey]) {
    store.sessions[toKey] = src;
    src.session.conversation_key = toKey;
    if (toKey.indexOf("s:") === 0 || toKey.indexOf("c:") === 0) {
      src.session.session_id = stripKeyPrefix(toKey);
    }
    seenByKey[toKey] = seenByKey[fromKey] || seenSetFor(src);
    delete seenByKey[fromKey];
    delete store.sessions[fromKey];
  } else {
    /* Real destination already exists — drop the placeholder bucket. */
    delete store.sessions[fromKey];
    delete seenByKey[fromKey];
  }
  Object.keys(store.tabKeys).forEach(function (tid) {
    if (store.tabKeys[tid] === fromKey) store.tabKeys[tid] = toKey;
  });
  if (store.activeKey === fromKey) store.activeKey = toKey;
}

function isPlaceholderKey(key) {
  return !key || key === "default" || String(key).indexOf("tab:") === 0;
}

function resolveSessionForEvent(evt, sender) {
  var tabId = sender && sender.tab && sender.tab.id != null ? sender.tab.id : null;
  var tabUrl = sender && sender.tab && sender.tab.url ? String(sender.tab.url) : "";
  var key = null;

  if (evt && evt.kind === "page_context" && evt.conversationKey) key = evt.conversationKey;
  if (!key && evt && evt.kind === "session_hint" && evt.sessionId) key = "s:" + evt.sessionId;
  /* Page URL (the tab, or page_context) — not API URLs on the event. */
  if (!key && evt && evt.kind === "page_context") key = conversationKeyFromUrl(evt.url || tabUrl);
  if (!key) key = conversationKeyFromUrl(tabUrl);
  if (!key && evt && evt.kind === "session_hint") key = conversationKeyFromUrl(evt.url || "");
  if (!key && tabId != null && store.tabKeys[tabId]) key = store.tabKeys[tabId];
  if (!key) key = store.activeKey || "default";

  var prev = (tabId != null && store.tabKeys[tabId]) || null;
  if (key && prev && key !== prev && isPlaceholderKey(prev)) migrateSession(prev, key);
  if (key && store.activeKey && key !== store.activeKey && isPlaceholderKey(store.activeKey) && tabId == null) {
    migrateSession(store.activeKey, key);
  }

  if (!store.sessions[key]) store.sessions[key] = freshState(key);
  store.activeKey = key;
  if (tabId != null) {
    store.tabKeys[tabId] = key;
    store.tabKeys[String(tabId)] = key;
  }
  var s = store.sessions[key];
  s.session.conversation_key = key;
  if (evt && evt.kind === "session_hint" && evt.sessionId) {
    s.session.session_id = evt.sessionId;
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
        activeKey: store.activeKey
      };
      var saveResult = chrome.storage.session.set({ [STATE_KEY]: payload });
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
    store.activeKey = packed.activeKey || null;
    var sessions = packed.sessions && typeof packed.sessions === "object" ? packed.sessions : {};
    Object.keys(sessions).forEach(function (k) {
      store.sessions[k] = hydrateSession(sessions[k], k);
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

function startStoreLoad() {
  try {
    var loadResult = chrome.storage.session.get([STATE_KEY, LEGACY_STATE_KEY]);
    if (loadResult && typeof loadResult.then === "function") {
      loadResult.then(finishStateLoad).catch(function () { finishStateLoad({}); });
    } else {
      finishStateLoad(loadResult || {});
    }
  } catch (e) {
    finishStateLoad({});
  }
}
