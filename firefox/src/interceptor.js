/* MAIN-world interceptor — injected at document_start BEFORE arena.ai's
 * bundle loads. Hooks fetch() and XMLHttpRequest to observe every API
 * response (JSON and SSE streams) without disturbing the app's own reads,
 * then forwards captured payloads to the ISOLATED content script via
 * postMessage. This is the primary capture channel: network payloads carry
 * the full thinking/tool trace that the DOM may render collapsed or
 * truncated. */
(function () {
  "use strict";
  var NS = "__ARENA_EXPORTER_EVT__";

  function pingReady() {
    try {
      var target = "*";
      try { if (location.origin) target = location.origin; } catch (e0) { /* ignore */ }
      window.postMessage({ type: NS, evt: { kind: "interceptor_ready", url: location.href } }, target);
    } catch (e1) { /* never break the host page */ }
  }

  window.addEventListener("message", function (ev) {
    if (ev.source !== window || !ev.data || ev.data.type !== "__ARENA_EXPORTER_REBIND__") return;
    pingReady();
  });

  if (window.__arenaExporterInstalled) {
    pingReady();
    return;
  }
  window.__arenaExporterInstalled = true;

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
  var CAPTURE_URL_RE = /(\/realtime\/v[0-9]+\/sessions\/|\/in\/append|\/api\/chat\/|create-chat|create-evaluation|post-to-evaluation|workspace|\/api\/history|\/text\/(direct|side-by-side)|\/max(?:[/?#]|$)|\/agent\/)/i;
  var EVAL_EMIT_CHUNK = 8192;

  /* Third-party telemetry (Datadog RUM beacons and friends) was reaching the
   * archive. Nothing outside arena.ai / lmarena.ai (legacy host that 301s) is
   * ever interesting here. Code-preview hosts such as arena.site are not
   * hooked — the interceptor only observes same-site Arena API traffic. */
  function isArenaUrl(url) {
    try {
      return /^([a-z0-9-]+\.)*(arena\.ai|lmarena\.ai)$/i.test(new URL(String(url), location.href).hostname);
    } catch (e) {
      return false;
    }
  }

  function isCaptureUrl(url) {
    url = String(url || "");
    if (!isArenaUrl(url)) return false;
    return REALTIME_OUT_RE.test(url) || EVALUATION_STREAM_RE.test(url) || CAPTURE_URL_RE.test(url);
  }

  var requestSequence = 0;
  function contextFor(method) {
    return { requestId: "ae-" + Date.now().toString(36) + "-" + (++requestSequence) + "-" + Math.random().toString(36).slice(2, 8),
      method: String(method || "GET").toUpperCase(), pageUrl: location.href, capturedAt: new Date().toISOString() };
  }
  function safeText(value) {
    return typeof AE !== "undefined" && AE.scrubSecrets ? AE.scrubSecrets(String(value || "")) : String(value || "");
  }
  function emit(evt, context) {
    try {
      evt = Object.assign({ pageUrl: location.href }, context || {}, evt);
      if (typeof AE !== "undefined" && AE.scrubSecrets) evt = AE.scrubSecrets(evt);
      var target = "*";
      try { if (location.origin) target = location.origin; } catch (e) { /* ignore */ }
      window.postMessage({ type: NS, evt: evt }, target);
    } catch (e) { /* never break the host page */ }
  }

  /* ---------- stream consumption (SSE / NDJSON / raw sniffing) ---------- */

  function parseSSEFrame(url, frame, context) {
    var event = "message";
    var dataLines = [];
    var lines = frame.split(/\r\n|\r|\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf("event:") === 0) event = line.slice(6).trim();
      else if (line.indexOf("data:") === 0) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (!dataLines.length) return;
    var data = dataLines.join("\n");
    if (data === "[DONE]") { emit({ kind: "stream_done", url: url }, context); return; }
    try {
      emit({ kind: "sse", url: url, event: event, data: JSON.parse(data) }, context);
    } catch (e) {
      if (data.trim()) emit({ kind: "sse_raw", url: url, event: event, text: safeText(data).slice(0, 2000) }, context);
    }
  }

  function parseNDJSONLine(url, line, context) {
    if (!line) return;
    try {
      emit({ kind: "json", url: url, data: JSON.parse(line) }, context);
    } catch (e) {
      emit({ kind: "stream_chunk", url: url, text: safeText(line).slice(0, 2048) }, context);
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
    // The first read can contain only "da" from "data:" or part of a row id.
    return buf.length < 64 && !/[\r\n]/.test(buf) ? null : "raw";
  }

  function parseRSCLine(url, line, context) {
    if (!line) return;
    var ci = line.indexOf(":");
    var rowId = ci > 0 ? line.slice(0, ci) : null;
    var rest = ci > 0 ? line.slice(ci + 1) : line;
    var data = null;
    try { data = JSON.parse(rest); } catch (e) { /* keep null */ }
    emit({ kind: "rsc_row", url: url, rowId: rowId, data: data, text: safeText(line).slice(0, 4096) }, context);
  }

  /* Battle evaluation bodies are a JSON init record concatenated with
   * delimiter-free lane deltas (`}a0:"…"b0:"…"`). That is not NDJSON —
   * never JSON.parse line-by-line and never truncate to 2KB. */
  async function consumeEvalStream(url, res, context) {
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var carry = "";
    try { for (;;) {
      var r = await reader.read();
      if (r.done) break;
      carry += dec.decode(r.value, { stream: true });
      while (carry.length >= EVAL_EMIT_CHUNK) {
        emit({ kind: "stream_chunk", url: url, text: carry.slice(0, EVAL_EMIT_CHUNK) }, context);
        carry = carry.slice(EVAL_EMIT_CHUNK);
      }
    } } catch (err) {
      if (carry) emit({ kind: "stream_chunk", url: url, text: carry }, context);
      throw err;
    } finally { if (reader.releaseLock) reader.releaseLock(); }
    try { carry += dec.decode(); } catch (e) { /* ignore */ }
    if (carry) emit({ kind: "stream_chunk", url: url, text: carry }, context);
    emit({ kind: "stream_end", url: url }, context);
  }

  async function consumeStream(url, res, context, contentType) {
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = "";
    var mode = /text\/event-stream/i.test(contentType || "") ? "sse" : null;
    var pendingCR = false;
    function decodeChunk(bytes, done) {
      var text = bytes ? dec.decode(bytes, { stream: true }) : dec.decode();
      if (pendingCR) { text = "\r" + text; pendingCR = false; }
      if (!done && text.endsWith("\r")) { pendingCR = true; text = text.slice(0, -1); }
      return text.replace(/\r\n?/g, "\n");
    }
    try {
    for (;;) {
      var r = await reader.read();
      buf += decodeChunk(r.value, r.done);
      if (r.done) break;
      if (!mode) mode = sniffStreamMode(buf);
      if (mode === "sse") {
        var idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          parseSSEFrame(url, buf.slice(0, idx), context);
          buf = buf.slice(idx + 2);
        }
      } else if (mode === "ndjson") {
        var nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          var line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          parseNDJSONLine(url, line, context);
        }
      } else if (mode === "rsc") {
        var nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          var line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          parseRSCLine(url, line, context);
        }
      } else if (mode === "raw" && buf.length > 2048) {
        emit({ kind: "stream_chunk", url: url, text: safeText(buf.slice(0, 2048)) }, context);
        buf = buf.slice(2048);
      }
      if (buf.length > 4 * 1024 * 1024) {
        if (reader.cancel) reader.cancel().catch(function () {});
        throw new Error("Stream frame exceeded the 4 MiB capture limit");
      }
    }
    if (buf.trim()) {
      if (mode === "sse") parseSSEFrame(url, buf, context);
      else if (mode === "ndjson") parseNDJSONLine(url, buf.trim(), context);
      else if (mode === "rsc") parseRSCLine(url, buf.trim(), context);
      else emit({ kind: "stream_chunk", url: url, text: safeText(buf).slice(0, 2048) }, context);
    }
    emit({ kind: "stream_end", url: url }, context);
    } finally { if (reader.releaseLock) reader.releaseLock(); }
  }

  /* ---------- response dispatch ---------- */

  function emitSessionHint(url, context) {
    var m = REALTIME_OUT_RE.exec(url) || CHAT_ID_RE.exec(url);
    if (m) emit({ kind: "session_hint", sessionId: m[1], url: url }, context);
  }

  function handleResponse(url, res, context) {
    if (!isCaptureUrl(url)) return;
    var ct = "";
    try { ct = (res.headers.get("content-type") || "").toLowerCase(); } catch (e) {}
    var headers = typeof AE !== "undefined" && AE.safeTransportHeaders ? AE.safeTransportHeaders(res.headers) : {};
    emit({ kind: "endpoint", url: url, status: res.status, contentType: ct, headers: headers }, context);
    if (res.status >= 400) {
      res.clone().text().then(function (text) {
        emit({ kind: "request_error", url: url, status: res.status, error: safeText(text).slice(0, 4000) }, context);
      }).catch(function (err) { emit({ kind: "request_error", url: url, status: res.status, error: String(err.message || err) }, context); });
      return;
    }
    emitSessionHint(url, context);
    function streamError(err) { emit({ kind: "stream_error", url: url, error: String(err.message || err), aborted: err.name === "AbortError" }, context); }
    try {
      var isRealtimeOut = REALTIME_OUT_RE.test(url);
      var isEvaluationStream = EVALUATION_STREAM_RE.test(url);
      if (isEvaluationStream) {
        consumeEvalStream(url, res.clone(), context).catch(streamError);
      } else if (ct.indexOf("text/event-stream") !== -1 || ct.indexOf("text/x-component") !== -1 || isRealtimeOut) {
        consumeStream(url, res.clone(), context, ct).catch(streamError);
      } else if (ct.indexOf("text/html") !== -1 && typeof AE !== "undefined" && AE.parsePageData) {
        res.clone().text().then(function (text) {
          emit({ kind: "page_data", url: url, data: AE.parsePageData(text, url) }, context);
        }).catch(streamError);
      } else if (ct.indexOf("application/json") !== -1) {
        res.clone().text().then(function (text) {
          if (!text) return;
          try {
            emit({ kind: "json", url: url, data: JSON.parse(text) }, context);
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

  function emitRequestCapture(url, method, body, context) {
    emit({
      kind: "request",
      url: url,
      method: String(method || "GET").toUpperCase(),
      body: safeText(body).slice(0, 200000)
    }, context);
  }

  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = "";
    var method = "GET";
    try {
      url = typeof input === "string" ? input : (input && input.url) || "";
      method = (init && init.method) || (typeof input === "object" && input && input.method) || "GET";
    } catch (e) {}
    var context = contextFor(method);
    try {
      if (RELEVANT_REQ_RE.test(url) && isArenaUrl(url)) {
        var hasInitBody = !!(init && init.body != null);
        if (hasInitBody) {
          emitRequestCapture(url, method, bodyText(init.body), context);
        } else if (input && typeof input.clone === "function") {
          // A common pattern is fetch(new Request(url, {body: ...})). Reading a
          // clone keeps the page's original Request body untouched.
          try {
            input.clone().text().then(function (text) {
              emitRequestCapture(url, method, text, context);
            }).catch(function () {
              emitRequestCapture(url, method, "", context);
            });
          } catch (e) {
            emitRequestCapture(url, method, "", context);
          }
        } else {
          emitRequestCapture(url, method, "", context);
        }
      }
    } catch (e) { /* ignore */ }
    var p = origFetch.apply(this, arguments);
    p.then(function (res) {
      try { handleResponse(url, res, context); } catch (e) {}
    }, function (err) {
      if (isCaptureUrl(url)) emit({ kind: "request_error", url: url, error: String(err.message || err) }, context);
    });
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
    var context = contextFor(xhr.__aeMethod);
    try {
      if (RELEVANT_REQ_RE.test(xhr.__aeUrl || "") && isArenaUrl(xhr.__aeUrl || "")) {
        var xhrBody = null;
        if (typeof payload === "string") xhrBody = payload;
        else if (payload && typeof payload === "object") { try { xhrBody = JSON.stringify(payload); } catch (e) {} }
        emitRequestCapture(xhr.__aeUrl, xhr.__aeMethod || "POST", xhrBody, context);
      }
    } catch (e) { /* ignore */ }
    try {
      xhr.addEventListener("load", function () {
        try {
          var url = xhr.__aeUrl || "";
          if (!isCaptureUrl(url)) return;
          var ct = (xhr.getResponseHeader("content-type") || "").toLowerCase();
          var headers = {};
          ["x-session-settled", "x-stream-version", "x-arena-chat-id"].forEach(function (name) { var v = xhr.getResponseHeader(name); if (v) headers[name] = v; });
          emit({ kind: "endpoint", url: url, status: xhr.status, contentType: ct, headers: headers }, context);
          if (xhr.status >= 400) {
            emit({ kind: "request_error", url: url, status: xhr.status, error: safeText(xhr.responseText).slice(0, 4000) }, context);
            return;
          }
          if (ct.indexOf("application/json") !== -1 && xhr.responseText) {
            try {
              emit({ kind: "json", url: url, data: JSON.parse(xhr.responseText) }, context);
            } catch (e) { /* ignore */ }
          } else if (ct.indexOf("text/event-stream") !== -1 && xhr.responseText) {
            xhr.responseText.replace(/\r\n?/g, "\n").split(/\n\n/).forEach(function (frame) { parseSSEFrame(url, frame, context); });
            emit({ kind: "stream_end", url: url }, context);
          } else if (EVALUATION_STREAM_RE.test(url) && xhr.responseText) {
            emit({ kind: "stream_chunk", url: url, text: xhr.responseText }, context);
            emit({ kind: "stream_end", url: url }, context);
          }
        } catch (e) { /* ignore */ }
      });
      ["error", "abort"].forEach(function (name) {
        xhr.addEventListener(name, function () {
          if (isCaptureUrl(xhr.__aeUrl)) emit({ kind: "request_error", url: xhr.__aeUrl, error: "XHR " + name }, context);
        });
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
          emitRequestCapture(String(url), "BEACON", bodyText(data), contextFor("BEACON"));
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
      var context = contextFor("WS");
      try {
        ws.addEventListener("message", function (ev) {
          try {
            if (typeof ev.data === "string" && isCaptureUrl(url)) {
              emit({ kind: "ws", url: String(url), text: ev.data }, context);
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
