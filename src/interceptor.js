/* MAIN-world interceptor — injected at document_start BEFORE arena.ai's
 * bundle loads. Hooks fetch() and XMLHttpRequest to observe every API
 * response (JSON and SSE streams) without disturbing the app's own reads,
 * then forwards captured payloads to the ISOLATED content script via
 * postMessage. This is the primary capture channel: network payloads carry
 * the full thinking/tool trace that the DOM may render collapsed or
 * truncated. */
(function () {
  "use strict";
  if (window.__arenaExporterInstalled) return;
  window.__arenaExporterInstalled = true;

  var NS = "__ARENA_EXPORTER_EVT__";

  /* Agent Mode recon findings:
   *  - /ai-proxy/realtime/v1/sessions/<uuid>/out  → long-lived agent event stream
   *  - /api/chat/<uuid>/...                       → chat-scoped REST endpoints
   * The /out stream framing is sniffed at runtime (SSE vs NDJSON vs raw). */
  var REALTIME_OUT_RE = /\/realtime\/v[0-9]+\/sessions\/([0-9a-fA-F-]{8,})\/out/i;
  var CHAT_ID_RE = /\/api\/chat\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/i;
  /* User prompts enter via .../sessions/<id>/in/append (POST body) — request
   * bodies on these endpoints are captured, not just responses. */
  var RELEVANT_REQ_RE = /(in\/append|create-chat|create-evaluation|post-to-evaluation|\/nextjs-api\/)/i;
  var EVALUATION_STREAM_RE = /(create-evaluation|post-to-evaluation)/i;
  /* Skip telemetry/assets. Only these URLs are forwarded to the SW. */
  var CAPTURE_URL_RE = /(\/realtime\/v[0-9]+\/sessions\/|\/in\/append|\/api\/chat\/|create-chat|create-evaluation|post-to-evaluation|workspace|\/api\/history)/i;
  var EVAL_EMIT_CHUNK = 8192;

  function isCaptureUrl(url) {
    url = String(url || "");
    return REALTIME_OUT_RE.test(url) || EVALUATION_STREAM_RE.test(url) || CAPTURE_URL_RE.test(url);
  }

  function emit(evt) {
    try {
      window.postMessage({ type: NS, evt: evt }, "*");
    } catch (e) { /* never break the host page */ }
  }

  /* ---------- stream consumption (SSE / NDJSON / raw sniffing) ---------- */

  function parseSSEFrame(url, frame) {
    var event = "message";
    var dataLines = [];
    var lines = frame.split("\n");
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf("event:") === 0) event = line.slice(6).trim();
      else if (line.indexOf("data:") === 0) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (!dataLines.length) return;
    var data = dataLines.join("\n");
    if (data === "[DONE]") { emit({ kind: "stream_done", url: url }); return; }
    try {
      emit({ kind: "sse", url: url, event: event, data: JSON.parse(data) });
    } catch (e) {
      if (data.trim()) emit({ kind: "sse_raw", url: url, event: event, text: data.slice(0, 2000) });
    }
  }

  function parseNDJSONLine(url, line) {
    if (!line) return;
    try {
      emit({ kind: "json", url: url, data: JSON.parse(line) });
    } catch (e) {
      emit({ kind: "stream_chunk", url: url, text: line.slice(0, 2048) });
    }
  }

  var SSE_FRAME_RE = /^\s*(event:|data:|id:|retry:|:)/;
  /* Next.js RSC / flight rows look like "<rowid>:<payload>" (e.g. the
   * evaluation battle stream emits "a2:[{\"type\":\"heartbeat\"}]"). */
  var RSC_LINE_RE = /^\s*[0-9a-zA-Z]+:/;

  function sniffStreamMode(buf) {
    if (SSE_FRAME_RE.test(buf)) return "sse";
    if (/^\s*[\{\[]/.test(buf)) return "ndjson";
    if (RSC_LINE_RE.test(buf)) return "rsc";
    return "raw";
  }

  function parseRSCLine(url, line) {
    if (!line) return;
    var ci = line.indexOf(":");
    var rowId = ci > 0 ? line.slice(0, ci) : null;
    var rest = ci > 0 ? line.slice(ci + 1) : line;
    var data = null;
    try { data = JSON.parse(rest); } catch (e) { /* keep null */ }
    emit({ kind: "rsc_row", url: url, rowId: rowId, data: data, text: line.slice(0, 4096) });
  }

  /* Battle evaluation bodies are a JSON init record concatenated with
   * delimiter-free lane deltas (`}a0:"…"b0:"…"`). That is not NDJSON —
   * never JSON.parse line-by-line and never truncate to 2KB. */
  async function consumeEvalStream(url, res) {
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var carry = "";
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      carry += dec.decode(r.value, { stream: true });
      while (carry.length >= EVAL_EMIT_CHUNK) {
        emit({ kind: "stream_chunk", url: url, text: carry.slice(0, EVAL_EMIT_CHUNK) });
        carry = carry.slice(EVAL_EMIT_CHUNK);
      }
    }
    try { carry += dec.decode(); } catch (e) { /* ignore */ }
    if (carry) emit({ kind: "stream_chunk", url: url, text: carry });
    emit({ kind: "stream_end", url: url });
  }

  async function consumeStream(url, res) {
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = "";
    var mode = null;
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      if (!mode) mode = sniffStreamMode(buf);
      if (mode === "sse") {
        var idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          parseSSEFrame(url, buf.slice(0, idx));
          buf = buf.slice(idx + 2);
        }
      } else if (mode === "ndjson") {
        var nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          var line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          parseNDJSONLine(url, line);
        }
      } else if (mode === "rsc") {
        var nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          var line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          parseRSCLine(url, line);
        }
      } else if (buf.length > 2048) {
        emit({ kind: "stream_chunk", url: url, text: buf.slice(0, 2048) });
        buf = buf.slice(2048);
      }
      if (buf.length > 65536) buf = buf.slice(-65536);
    }
    if (buf.trim()) {
      if (mode === "sse") parseSSEFrame(url, buf);
      else if (mode === "ndjson") parseNDJSONLine(url, buf.trim());
      else if (mode === "rsc") parseRSCLine(url, buf.trim());
      else emit({ kind: "stream_chunk", url: url, text: buf.slice(0, 2048) });
    }
    emit({ kind: "stream_end", url: url });
  }

  /* ---------- response dispatch ---------- */

  function emitSessionHint(url) {
    var m = REALTIME_OUT_RE.exec(url) || CHAT_ID_RE.exec(url);
    if (m) emit({ kind: "session_hint", sessionId: m[1], url: url });
  }

  function handleResponse(url, res) {
    if (!isCaptureUrl(url)) return;
    var ct = "";
    try { ct = (res.headers.get("content-type") || "").toLowerCase(); } catch (e) {}
    emit({ kind: "endpoint", url: url, status: res.status, contentType: ct });
    emitSessionHint(url);
    try {
      var isRealtimeOut = REALTIME_OUT_RE.test(url);
      var isEvaluationStream = EVALUATION_STREAM_RE.test(url);
      if (isEvaluationStream) {
        consumeEvalStream(url, res.clone()).catch(function () {});
      } else if (ct.indexOf("text/event-stream") !== -1 || isRealtimeOut) {
        consumeStream(url, res.clone()).catch(function () {});
      } else if (ct.indexOf("application/json") !== -1) {
        res.clone().text().then(function (text) {
          if (!text) return;
          try {
            emit({ kind: "json", url: url, data: JSON.parse(text) });
          } catch (e) { /* non-JSON despite content-type */ }
        }).catch(function () {});
      }
    } catch (e) { /* ignore */ }
  }

  /* ---------- fetch hook ---------- */

  function bodyText(body) {
    if (body == null) return "";
    if (typeof body === "string") return body;
    try {
      if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return body.toString();
    } catch (e) { /* ignore */ }
    if (body && typeof body === "object") {
      try { return JSON.stringify(body); } catch (e) { /* FormData/stream — no sync representation */ }
    }
    return "";
  }

  function emitRequestCapture(url, method, body) {
    emit({
      kind: "request",
      url: url,
      method: String(method || "GET").toUpperCase(),
      body: String(body || "").slice(0, 200000)
    });
  }

  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = "";
    var method = "GET";
    try {
      url = typeof input === "string" ? input : (input && input.url) || "";
      method = (init && init.method) || (typeof input === "object" && input && input.method) || "GET";
    } catch (e) {}
    try {
      if (RELEVANT_REQ_RE.test(url)) {
        var hasInitBody = !!(init && init.body != null);
        if (hasInitBody) {
          emitRequestCapture(url, method, bodyText(init.body));
        } else if (input && typeof input.clone === "function") {
          // A common pattern is fetch(new Request(url, {body: ...})). Reading a
          // clone keeps the page's original Request body untouched.
          try {
            input.clone().text().then(function (text) {
              emitRequestCapture(url, method, text);
            }).catch(function () {
              emitRequestCapture(url, method, "");
            });
          } catch (e) {
            emitRequestCapture(url, method, "");
          }
        } else {
          emitRequestCapture(url, method, "");
        }
      }
    } catch (e) { /* ignore */ }
    var p = origFetch.apply(this, arguments);
    p.then(function (res) {
      try { handleResponse(url, res); } catch (e) {}
    }).catch(function () {});
    return p;
  };

  /* ---------- XHR hook ---------- */

  var XP = XMLHttpRequest.prototype;
  var origOpen = XP.open;
  var origSend = XP.send;

  XP.open = function (method, url) {
    try { this.__aeUrl = String(url); this.__aeMethod = String(method); } catch (e) {}
    return origOpen.apply(this, arguments);
  };

  XP.send = function (payload) {
    var xhr = this;
    try {
      if (RELEVANT_REQ_RE.test(xhr.__aeUrl || "")) {
        var xhrBody = null;
        if (typeof payload === "string") xhrBody = payload;
        else if (payload && typeof payload === "object") { try { xhrBody = JSON.stringify(payload); } catch (e) {} }
        emit({ kind: "request", url: xhr.__aeUrl, method: xhr.__aeMethod || "POST", body: (xhrBody || "").slice(0, 200000) });
      }
    } catch (e) { /* ignore */ }
    try {
      xhr.addEventListener("load", function () {
        try {
          var url = xhr.__aeUrl || "";
          if (!isCaptureUrl(url)) return;
          var ct = (xhr.getResponseHeader("content-type") || "").toLowerCase();
          emit({ kind: "endpoint", url: url, status: xhr.status, contentType: ct });
          if (ct.indexOf("application/json") !== -1 && xhr.responseText) {
            try {
              emit({ kind: "json", url: url, data: JSON.parse(xhr.responseText) });
            } catch (e) { /* ignore */ }
          } else if (ct.indexOf("text/event-stream") !== -1 && xhr.responseText) {
            xhr.responseText.split(/\n\n/).forEach(function (frame) { parseSSEFrame(url, frame); });
            emit({ kind: "stream_end", url: url });
          } else if (EVALUATION_STREAM_RE.test(url) && xhr.responseText) {
            emit({ kind: "stream_chunk", url: url, text: xhr.responseText });
            emit({ kind: "stream_end", url: url });
          }
        } catch (e) { /* ignore */ }
      });
    } catch (e) { /* ignore */ }
    return origSend.apply(this, arguments);
  };

  /* ---------- sendBeacon hook (some vote/telemetry calls use beacons) ---- */

  if (navigator.sendBeacon) {
    var origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      try {
        if (isCaptureUrl(url)) {
          emit({ kind: "request", url: String(url), method: "BEACON", body: bodyText(data).slice(0, 200000) });
        }
      } catch (e) { /* ignore */ }
      return origBeacon(url, data);
    };
  }

  /* ---------- WebSocket hook (insurance: if realtime ever moves to WS) ---- */

  var OrigWS = window.WebSocket;
  if (OrigWS) {
    function HookedWS(url, protocols) {
      var ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
      try {
        ws.addEventListener("message", function (ev) {
          try {
            if (typeof ev.data === "string" && isCaptureUrl(url)) {
              emit({ kind: "ws", url: String(url), text: ev.data });
            }
          } catch (e) { /* ignore */ }
        });
      } catch (e) { /* ignore */ }
      return ws;
    }
    HookedWS.prototype = OrigWS.prototype;
    HookedWS.CONNECTING = OrigWS.CONNECTING;
    HookedWS.OPEN = OrigWS.OPEN;
    HookedWS.CLOSING = OrigWS.CLOSING;
    HookedWS.CLOSED = OrigWS.CLOSED;
    window.WebSocket = HookedWS;
  }

  emit({ kind: "interceptor_ready", url: location.href });
})();

