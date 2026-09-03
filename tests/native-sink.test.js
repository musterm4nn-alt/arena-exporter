/* Native-messaging sink: hello/write, missing-host fallback, outgoing path safety.
 * Usage: node tests/native-sink.test.js */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { fakeStorageArea, fakeDownloads, decodeWrite } = require("./fake-chrome");

const ROOT = path.join(__dirname, "..", "src");

function fakeConnectNative(opts) {
  opts = opts || {};
  const runtime = opts.runtime;
  return function (name) {
    const listeners = { message: [], disconnect: [] };
    const port = {
      name,
      postMessage(msg) {
        (opts.posted || []).push(JSON.parse(JSON.stringify(msg)));
        if (opts.missing) return;
        setTimeout(function () {
          if (msg.op === "hello") {
            if (opts.helloFail) {
              listeners.message.forEach((fn) => fn({
                id: msg.id, op: "hello", ok: false, error: opts.helloFail
              }));
              return;
            }
            listeners.message.forEach((fn) => fn({
              id: msg.id, op: "hello", ok: true,
              app: "ArenaArchive", version: "0.1.0",
              root: opts.root === undefined ? "/tmp/arena-archive" : opts.root
            }));
          } else if (msg.op === "write") {
            (msg.files || []).forEach((f) => (opts.files || []).push(f));
            if (opts.writeFail) {
              listeners.message.forEach((fn) => fn({
                id: msg.id, op: "write", ok: false, error: opts.writeFail
              }));
              return;
            }
            listeners.message.forEach((fn) => fn({
              id: msg.id, op: "write", ok: true,
              written: (msg.files || []).length,
              root: opts.root || "/tmp/arena-archive"
            }));
          }
        }, 0);
      },
      disconnect() {},
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) }
    };
    if (opts.missing) {
      setTimeout(function () {
        if (runtime) runtime.lastError = { message: "Specified native messaging host not found." };
        listeners.disconnect.forEach((fn) => fn());
      }, 0);
    }
    return port;
  };
}

function loadSink(hostOpts) {
  const writes = [];
  const nativePosted = [];
  const nativeFiles = [];
  const runtime = { lastError: null, onMessage: { addListener: () => {} } };
  runtime.connectNative = fakeConnectNative(Object.assign({
    posted: nativePosted, files: nativeFiles, runtime: runtime
  }, hostOpts || {}));
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout,
    JSON, Math, Date, Object, Array, String, Number, Set, Promise,
    encodeURIComponent, decodeURIComponent, btoa, atob,
    crypto: globalThis.crypto, TextEncoder, TextDecoder,
    chrome: {
      runtime,
      storage: { local: fakeStorageArea() },
      downloads: fakeDownloads(writes)
    }
  });
  for (const f of ["lib/schema.js", "archive-layout.js", "markdown.js", "downloads-sink.js", "native-sink.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx);
  }
  return { ctx, AE: ctx.AE, writes, nativePosted, nativeFiles, runtime };
}

function loadSinkNoHost() {
  const writes = [];
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout,
    JSON, Math, Date, Object, Array, String, Number, Set, Promise,
    encodeURIComponent, decodeURIComponent, btoa, atob,
    crypto: globalThis.crypto, TextEncoder, TextDecoder,
    chrome: {
      runtime: { lastError: null, onMessage: { addListener: () => {} } },
      storage: { local: fakeStorageArea() },
      downloads: fakeDownloads(writes)
    }
  });
  for (const f of ["lib/schema.js", "archive-layout.js", "markdown.js", "downloads-sink.js", "native-sink.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx);
  }
  return { ctx, AE: ctx.AE, writes };
}

function payloadFor(key, title, turns, models) {
  return {
    session: { conversation_key: key, session_id: key, title },
    export: { source: { url: "https://arena.ai/c/" + key } },
    battles: Array.from({ length: turns }, (_, i) => ({
      subtype: "text", index: i + 1,
      contestants: [{ lane: "A", model: models[0] }, { lane: "B", model: models[1] }]
    }))
  };
}

function loadWorker(kind) {
  const archiveWrites = [];
  const nativePosted = [];
  const nativeFiles = [];
  let messageListener = null;
  const TABS = [
    { id: 9, url: "https://arena.ai/c/BBB" },
    { id: 7, url: "https://arena.ai/c/AAA" }
  ];
  const runtime = {
    lastError: null,
    onMessage: { addListener: (fn) => { messageListener = fn; } },
    getManifest: () => ({ version: "1.15.8" })
  };
  if (kind === "ok") {
    runtime.connectNative = fakeConnectNative({
      posted: nativePosted, files: nativeFiles, runtime, root: "/tmp/arena-archive"
    });
  } else if (kind === "missing-port") {
    runtime.connectNative = fakeConnectNative({
      posted: nativePosted, files: nativeFiles, runtime, missing: true
    });
  }
  /* kind === "missing" → no connectNative */
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout,
    JSON, Math, Date, Object, Array, String, Number, Set, Promise,
    encodeURIComponent, decodeURIComponent, btoa, atob,
    crypto: globalThis.crypto, TextEncoder, TextDecoder,
    importScripts: (...files) => {
      for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx);
    },
    chrome: {
      storage: { session: { get: async () => ({}), set: async () => {} }, local: fakeStorageArea() },
      downloads: fakeDownloads(archiveWrites),
      runtime,
      tabs: {
        query: (_q, cb) => cb(TABS),
        sendMessage: (tabId, msg, cb) => {
          cb({ source: "dom", url: (TABS.find((t) => t.id === tabId) || {}).url, messages: [] });
        }
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), ctx);
  function send(msg, sender) {
    return new Promise((resolve) => {
      const ret = messageListener(msg, sender || {}, resolve);
      if (ret === undefined) resolve(null);
    });
  }
  return { send, archiveWrites, nativePosted, nativeFiles };
}

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.error("  ✗ " + name); }
}

(async () => {
  console.log("Path safety of outgoing rels:");
  {
    const { AE } = loadSinkNoHost();
    check("posix nested path kept", AE.nativeSafeRel("battle/text/slug/conversation.json") === "battle/text/slug/conversation.json");
    check("dot-dot rejected", AE.nativeSafeRel("../evil.txt") === null);
    check("embedded dot-dot rejected", AE.nativeSafeRel("battle/foo/../../etc/passwd") === null);
    check("absolute rejected", AE.nativeSafeRel("/etc/passwd") === null);
    check("drive letter rejected", AE.nativeSafeRel("C:/windows/x") === null);
    check("NUL rejected", AE.nativeSafeRel("foo\0bar") === null);
    check("encode rejects traversal", AE.nativeEncodeFile("../evil.txt", "x", "utf8").ok === false);

    const posted = [];
    const session = {
      request(op, extra) {
        posted.push(extra);
        return Promise.resolve({ ok: true, written: (extra.files || []).length });
      }
    };
    await AE.writeNativeJobs(session, [
      { path: "ok.md", full: "battle/text/s/ok.md", content: "hi", encoding: "utf8" },
      { path: "evil", full: "../evil.txt", content: "nope", encoding: "utf8" },
      { path: "abs", full: "/tmp/x", content: "nope", encoding: "utf8" },
      { path: "nested", full: "agent/x/files/../../outside", content: "nope", encoding: "utf8" }
    ]);
    const rels = posted.flatMap((p) => (p.files || []).map((f) => f.rel));
    check("unsafe jobs never posted", rels.length === 1 && rels[0] === "battle/text/s/ok.md");
    check("no .. segment on the wire", rels.every((r) => r.split("/").indexOf("..") === -1));
  }

  console.log("Encoding: utf8 vs base64 for data-urls:");
  {
    const { AE } = loadSinkNoHost();
    const utf = AE.nativeEncodeFile("battle/text/s/conversation.json", '{"a":1}', "utf8");
    check("utf8 stays utf8", utf.ok && utf.file.encoding === "utf8" && utf.file.content === '{"a":1}');
    const b64 = AE.nativeEncodeFile("battle/text/s/A/index.html", "data:text/html;base64,PGh0bWw+", "dataurl");
    check("data-url becomes base64 payload", b64.ok && b64.file.encoding === "base64" && b64.file.content === "PGh0bWw+");
  }

  console.log("80-file batches:");
  {
    const { AE } = loadSinkNoHost();
    const posted = [];
    const session = {
      request(op, extra) {
        posted.push(extra.files.length);
        return Promise.resolve({ ok: true, written: extra.files.length });
      }
    };
    const jobs = Array.from({ length: 81 }, (_, i) => ({
      path: "f" + i + ".txt",
      full: "battle/text/x/f" + i + ".txt",
      content: "n" + i,
      encoding: "utf8"
    }));
    await AE.writeNativeJobs(session, jobs);
    check("81 files split 80+1", posted.length === 2 && posted[0] === 80 && posted[1] === 1);
  }

  console.log("hello ok + write ok:");
  {
    const { AE, writes, nativePosted, nativeFiles } = loadSink();
    const p = payloadFor("c:abc123", "Mirror chat", 1, ["grok-4.5", "kimi-k3"]);
    const res = await AE.writeArchiveNative(p, [
      { path: "conversation.json", encoding: "utf8", content: '{"a":1}' },
      { path: "battle-01/A/index.html", encoding: "dataurl", content: "data:text/html;base64,PGh0bWw+" }
    ]);
    check("native write reported ok", res.ok === true && res.sink === "native");
    check("downloads unused when native works", writes.length === 0);
    check("hello then write", nativePosted.some((m) => m.op === "hello") && nativePosted.some((m) => m.op === "write"));
    check("never sent getRoot/setRoot", nativePosted.every((m) => m.op === "hello" || m.op === "write"));
    check("utf8 conversation.json", nativeFiles.some((f) => /conversation\.json$/.test(f.rel) && f.encoding === "utf8"));
    check("html data-url as base64", nativeFiles.some((f) => /index\.html$/.test(f.rel) && f.encoding === "base64" && f.content === "PGh0bWw+"));
    check("rels are archive-layout POSIX, not Downloads/", nativeFiles.every((f) => f.rel.indexOf("arena-archive/") !== 0 && f.rel.indexOf("..") === -1));
    check("index mirrored at _index.json", nativeFiles.some((f) => f.rel === "_index.json"));
  }

  console.log("Missing host → fallback:");
  {
    const { AE, writes } = loadSinkNoHost();
    const p = payloadFor("c:miss", "Miss", 1, ["m1", "m2"]);
    const native = await AE.writeArchiveNative(p, [{ path: "conversation.json", content: "{}" }]);
    check("native reports fallback", native.fallback === true && native.error === "host-missing");
    check("hint tells user to open the app", /open arena archive and pick a folder/i.test(native.hint || ""));
    check("no downloads from native helper itself", writes.length === 0);

    const status = await AE.nativeStatus();
    check("status is missing", status.state === "missing");
  }

  console.log("no-root hello → fallback:");
  {
    const { AE } = loadSink({ root: null });
    const native = await AE.writeArchiveNative(payloadFor("c:noroot", "No", 1, ["a", "b"]), [
      { path: "conversation.json", content: "{}" }
    ]);
    check("no-root is fallback", native.fallback === true && native.error === "no-root");
    const status = await AE.nativeStatus();
    check("status is no-root", status.state === "no-root");
  }

  console.log("Turn-sync: missing host falls back to downloads:");
  {
    const { send, archiveWrites, nativeFiles } = loadWorker("missing");
    const tabA = { tab: { id: 7, url: "https://arena.ai/c/AAA" } };
    await send({ type: "AE_EVENT", evt: { kind: "page_context", url: tabA.tab.url, conversationKey: "c:AAA" } }, tabA);
    await send({ type: "AE_EVENT", evt: { kind: "json", url: "https://arena.ai/api/chat/x", data: { role: "user", content: "prompt in A" } } }, tabA);
    const sync = await send({ type: "AE_SYNC", tabId: 7, sessionKey: "c:AAA" });
    check("manual sync still succeeds", !!(sync && sync.ok));
    check("sink is downloads", sync.sync && sync.sync.sink === "downloads");
    check("chrome.downloads received files", archiveWrites.length > 0);
    check("native received nothing", nativeFiles.length === 0);
    check("downloads land under arena-archive", archiveWrites.every((w) => w.filename.indexOf("arena-archive/") === 0));
  }

  console.log("Turn-sync: working host writes via native:");
  {
    const { send, archiveWrites, nativeFiles, nativePosted } = loadWorker("ok");
    const tabA = { tab: { id: 7, url: "https://arena.ai/c/AAA" } };
    await send({ type: "AE_EVENT", evt: { kind: "page_context", url: tabA.tab.url, conversationKey: "c:AAA" } }, tabA);
    await send({ type: "AE_EVENT", evt: { kind: "json", url: "https://arena.ai/api/chat/x", data: { role: "user", content: "prompt in A" } } }, tabA);
    const sync = await send({ type: "AE_SYNC", tabId: 7, sessionKey: "c:AAA" });
    check("manual sync succeeds", !!(sync && sync.ok));
    check("sink is native", sync.sync && sync.sync.sink === "native");
    check("downloads unused", archiveWrites.length === 0);
    check("native got conversation.json", nativeFiles.some((f) => /conversation\.json$/.test(f.rel)));
    check("outgoing rels have no ..", nativeFiles.every((f) => f.rel.split("/").indexOf("..") === -1));
    check("ops are hello/write only", nativePosted.every((m) => m.op === "hello" || m.op === "write"));
  }

  console.log("Options status probe:");
  {
    const { send } = loadWorker("missing");
    const st = await send({ type: "AE_NATIVE_STATUS" });
    check("missing host status", st && st.state === "missing" && st.fallback === true);
  }
  {
    const { send } = loadWorker("ok");
    const st = await send({ type: "AE_NATIVE_STATUS" });
    check("detected host status", st && st.state === "ok");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
