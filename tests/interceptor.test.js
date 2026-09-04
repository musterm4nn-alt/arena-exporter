/* Interceptor stream tests: evaluation bodies must be forwarded raw, not
 * sniffed as NDJSON and truncated. Usage: node tests/interceptor.test.js */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.error("  ✗ " + name); }
}

function mockXHR() {
  function XMLHttpRequest() {}
  XMLHttpRequest.prototype.open = function () {};
  XMLHttpRequest.prototype.send = function () {};
  XMLHttpRequest.prototype.addEventListener = function () {};
  XMLHttpRequest.prototype.getResponseHeader = function () { return ""; };
  return XMLHttpRequest;
}

function readerFromString(text, chunkSize) {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  return {
    async read() {
      if (offset >= bytes.length) return { done: true, value: undefined };
      const end = Math.min(bytes.length, offset + chunkSize);
      const value = new Uint8Array(bytes.slice(offset, end));
      offset = end;
      return { done: false, value };
    }
  };
}

function installInterceptor(events) {
  const sandbox = {
    console,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    URL, // the interceptor resolves capture URLs against the page origin
    setTimeout, clearTimeout,
    location: { href: "https://arena.ai/c/test", origin: "https://arena.ai" },
    navigator: { sendBeacon: function () { return true; } }, // hooked by the interceptor
    XMLHttpRequest: mockXHR(),
    WebSocket: function () {},
    document: {},
    window: null
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.globalThis = sandbox;
  sandbox.window.postMessage = function (msg) { events.push(msg); };
  let pendingRes = null;
  sandbox.window.fetch = function () {
    return Promise.resolve(pendingRes);
  };
  sandbox.__setFetchResult = function (res) { pendingRes = res; };
  vm.createContext(sandbox);
  for (const file of ["lib/schema.js", "lib/privacy.js", "lib/page-data.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", file), "utf8"), sandbox);
  }
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "src", "interceptor.js"), "utf8"),
    sandbox
  );
  return sandbox;
}

function responseFor(url, body, contentType, options = {}) {
  const make = function () {
    return {
      status: options.status || 200,
      headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? contentType : (options.headers || {})[String(k).toLowerCase()] || "") },
      clone() { return make(); },
      text: async () => body,
      body: { getReader() { return readerFromString(body, options.chunkSize || 1024); } }
    };
  };
  return make();
}

(async () => {
  console.log("Evaluation stream is raw-chunked, not NDJSON:");
  const events = [];
  const sandbox = installInterceptor(events);
  const init = '{"id":"evBig","mode":"battle","modelAMessageId":"ma","modelBMessageId":"mb","userMessage":{"content":"pick"}}';
  const long = "x".repeat(70000);
  const body = init + 'a0:"' + long + '"b0:"y"ad:{"finishReason":"stop"}bd:{"finishReason":"stop"}';
  check("fixture larger than old 2KB and 64KB caps", body.length > 65536);

  sandbox.__setFetchResult(responseFor(
    "https://arena.ai/nextjs-api/stream/create-evaluation",
    body,
    "text/plain"
  ));
  await sandbox.window.fetch("https://arena.ai/nextjs-api/stream/create-evaluation", { method: "GET" });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 20));

  const chunks = events.filter((e) => e && e.evt && e.evt.kind === "stream_chunk").map((e) => e.evt.text);
  const jsonEv = events.filter((e) => e && e.evt && e.evt.kind === "json");
  const joined = chunks.join("");
  check("emitted stream_chunk(s)", chunks.length >= 1);
  check("no JSON parse of evaluation body", jsonEv.length === 0);
  check("joined chunks equal full body", joined === body);
  check("init record preserved", joined.indexOf('"id":"evBig"') === 0 || joined.indexOf('{"id":"evBig"') === 0);
  check("long lane text not truncated to 2048", joined.indexOf(long) !== -1 && joined.indexOf(long) + long.length > 2048);
  check("stream_end fired", events.some((e) => e && e.evt && e.evt.kind === "stream_end"));

  console.log("Non-arena JSON is not captured:");
  const events2 = [];
  const s2 = installInterceptor(events2);
  s2.__setFetchResult(responseFor("https://arena.ai/cdn/flags.json", "{\"ok\":true}", "application/json"));
  await s2.window.fetch("https://arena.ai/cdn/flags.json");
  await new Promise((r) => setTimeout(r, 20));
  check("noise URL produced no capture events", events2.filter((e) => e && e.evt && e.evt.kind !== "interceptor_ready").length === 0);

  console.log("Third-party telemetry is never captured:");
  const events3 = [];
  const s3 = installInterceptor(events3);
  // A real Datadog RUM beacon reached an archive because only the path was
  // checked. Its query string can contain capture keywords; the origin cannot.
  const ddUrl = "https://browser-intake-us3-datadoghq.com/api/v2/rum?ddsource=browser&view=workspace&x=/api/chat/1";
  s3.__setFetchResult(responseFor(ddUrl, "{\"ok\":true}", "application/json"));
  await s3.window.fetch(ddUrl, { method: "POST", body: "{\"telemetry\":1}" });
  s3.window.navigator.sendBeacon(ddUrl, "{\"telemetry\":1}");
  await new Promise((r) => setTimeout(r, 20));
  const captured3 = events3.filter((e) => e && e.evt && e.evt.kind !== "interceptor_ready");
  check("third-party origin produced no capture events", captured3.length === 0);
  const events4 = [];
  const s4 = installInterceptor(events4);
  s4.__setFetchResult(responseFor("https://arena.ai/api/chat/abc", "{\"ok\":true}", "application/json"));
  await s4.window.fetch("https://arena.ai/api/chat/abc");
  await new Promise((r) => setTimeout(r, 20));
  // `endpoint` is emitted immediately after the isCaptureUrl gate, so its
  // presence is exactly the signal that the origin check let the URL through.
  check("arena origin still captured", events4.some((e) => e && e.evt && e.evt.kind === "endpoint"));

  console.log("SSE handles one-byte reads, UTF-8 and all legal line endings:");
  for (const newline of ["\n", "\r\n", "\r"]) {
    const captured = [], stream = installInterceptor(captured);
    const payload = { records: [{ body: JSON.stringify({ data: { type: "text-delta", id: "txt-0", delta: "Grüße 🧪" }, id: "part-1" }) }] };
    const text = "data: " + JSON.stringify(payload) + newline + newline;
    const streamUrl = "https://arena.ai/ai-proxy/realtime/v1/sessions/12345678/out";
    stream.__setFetchResult(responseFor(streamUrl, text, "text/plain", { chunkSize: 1 }));
    const original = await stream.fetch(streamUrl);
    await new Promise(resolve => setImmediate(resolve));
    const frame = captured.find(message => message.evt && message.evt.kind === "sse");
    check("SSE survives " + JSON.stringify(newline) + " with a fragmented data prefix", !!frame && JSON.parse(frame.evt.data.records[0].body).data.delta === "Grüße 🧪");
    check("the page still receives the original response", await original.text() === text);
  }

  console.log("Failed selections and Request bodies are captured without producing output:");
  const rejectedEvents = [], rejected = installInterceptor(rejectedEvents);
  const evaluationUrl = "https://arena.ai/nextjs-api/stream/create-evaluation";
  const errorBody = JSON.stringify({ error: "Selected model is not available for user selection", publicAccessToken: "synthetic-private-token" });
  rejected.__setFetchResult(responseFor(evaluationUrl, errorBody, "application/json", {
    status: 400, headers: { "x-stream-version": "v2", "x-session-settled": "true", authorization: "synthetic-auth" }
  }));
  const request = { url: evaluationUrl, method: "POST", clone: () => ({ text: async () => JSON.stringify({ mode: "direct-battle", modelAId: "requested-id", recaptchaV2Token: "synthetic-captcha" }) }) };
  const pending = rejected.fetch(request);
  rejected.location.href = "https://arena.ai/c/navigated-away";
  await pending;
  await new Promise(resolve => setImmediate(resolve));
  const requestEvent = rejectedEvents.find(message => message.evt.kind === "request").evt;
  const errorEvent = rejectedEvents.find(message => message.evt.kind === "request_error").evt;
  const endpoint = rejectedEvents.find(message => message.evt.kind === "endpoint").evt;
  check("Request clones preserve mode and requested id", JSON.parse(requestEvent.body).mode === "direct-battle" && JSON.parse(requestEvent.body).modelAId === "requested-id");
  check("request and response retain the same identity and initiating page", requestEvent.requestId === errorEvent.requestId && errorEvent.pageUrl === "https://arena.ai/c/test");
  check("HTTP error is emitted as an outcome", errorEvent.status === 400 && /Selected model/.test(errorEvent.error));
  check("HTTP error is never consumed as an evaluation stream", !rejectedEvents.some(message => message.evt.kind === "stream_chunk"));
  check("only allowlisted response headers are retained", endpoint.headers["x-stream-version"] === "v2" && endpoint.headers["x-session-settled"] === "true" && !endpoint.headers.authorization);
  check("credentials are removed before bridging into the extension", !JSON.stringify(rejectedEvents).includes("synthetic-captcha") && !JSON.stringify(rejectedEvents).includes("synthetic-private-token") && !JSON.stringify(rejectedEvents).includes("synthetic-auth"));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
