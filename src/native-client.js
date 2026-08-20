/* Native-messaging client for Arena Archive.app. No-ops when the host is missing. */

var NATIVE_HOST = "com.arenaexporter.host";
var nativePort = null;
var nativePending = {};
var nativeSeq = 1;
var lastNativeError = null;

function nativeAvailable() {
  return typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.connectNative === "function";
}

function nativeConnect() {
  if (nativePort) return nativePort;
  if (!nativeAvailable()) {
    lastNativeError = "nativeMessaging API unavailable";
    return null;
  }
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    lastNativeError = String(e);
    nativePort = null;
    return null;
  }
  nativePort.onMessage.addListener(function (msg) {
    var id = msg && msg.id;
    if (id && nativePending[id]) {
      nativePending[id](msg);
      delete nativePending[id];
    }
  });
  nativePort.onDisconnect.addListener(function () {
    lastNativeError = (chrome.runtime && chrome.runtime.lastError && chrome.runtime.lastError.message) || "native host disconnected";
    nativePort = null;
  });
  return nativePort;
}

function nativeSend(payload) {
  return new Promise(function (resolve) {
    var port = nativeConnect();
    if (!port) {
      resolve({ ok: false, error: lastNativeError || "Arena Archive host is not installed" });
      return;
    }
    var id = nativeSeq++;
    payload.id = id;
    nativePending[id] = resolve;
    try {
      port.postMessage(payload);
    } catch (e) {
      delete nativePending[id];
      resolve({ ok: false, error: String(e) });
    }
    setTimeout(function () {
      if (nativePending[id]) {
        delete nativePending[id];
        resolve({ ok: false, error: "native host timed out" });
      }
    }, 15000);
  });
}

function pingNative() {
  return nativeSend({ type: "ping" });
}

function syncArchive(payload, files) {
  var session = (payload && payload.session) || {};
  var battles = (payload && payload.battles) || [];
  var chat = {
    key: session.conversation_key || session.session_id,
    mode: battles.length ? "battle" : "agent",
    subtype: AE.firstBattleSubtype ? AE.firstBattleSubtype(payload) : null,
    title: session.title || (battles[0] && battles[0].prompt) || "",
    url: payload.export && payload.export.source && payload.export.source.url,
    models: [],
    models_pending: true
  };
  if (battles.length) {
    var latest = battles[battles.length - 1];
    chat.models = (latest.contestants || []).map(function (c) { return c.model; }).filter(Boolean);
    chat.models_pending = !chat.models.length;
  }
  var metaFiles = (files || []).filter(function (f) {
    return f.path === "conversation.json" || f.path === "conversation.md";
  }).map(function (f) {
    return { path: f.path, encoding: "utf8", content: f.content, sha256: null };
  });
  return nativeSend({ type: "sync_meta", chat: chat, files: metaFiles }).then(function (res) {
    if (!res || !res.ok) return res;
    var rest = (files || []).filter(function (f) {
      return f.path !== "conversation.json" && f.path !== "conversation.md" && typeof f.content === "string";
    });
    var chain = Promise.resolve(res);
    rest.forEach(function (f) {
      chain = chain.then(function (prev) {
        if (!prev || !prev.ok) return prev;
        return nativeSend({
          type: "write_chunk",
          key: chat.key,
          path: f.path,
          offset: 0,
          eof: true,
          data_utf8: f.content
        });
      });
    });
    return chain;
  });
}
