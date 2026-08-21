/* Turn-sync must archive each conversation using its OWN tab's DOM.
 * Regression: the snapshot used to come from tabs[0] of every arena.ai tab, so
 * a second tab's models/vote/responses could be written onto this chat.
 * Usage: node tests/turn-sync.test.js */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { fakeStorageArea, fakeDownloads } = require("./fake-chrome");
const archiveWrites = [];

const ROOT = path.join(__dirname, "..", "src");

/* ---- chrome / worker stubs ---- */
let messageListener = null;
const snapshotRequests = []; // tabIds that were asked for a DOM snapshot

/* Deliberately ordered so the WRONG tab is tabs[0]: the old
 * "grab tabs[0]" behaviour would pick tab 9 for a tab-7 conversation. */
const TABS = [
  { id: 9, url: "https://arena.ai/c/BBB" },
  { id: 7, url: "https://arena.ai/c/AAA" }
];

const ctx = vm.createContext({
  console,
  setTimeout, clearTimeout,
  JSON, Math, Date, Object, Array, String, Number, Set, Promise,
  crypto: globalThis.crypto,
  TextEncoder, TextDecoder,
  importScripts: (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx);
  },
  chrome: {
    storage: { session: { get: async () => ({}), set: async () => {} }, local: fakeStorageArea() },
    downloads: fakeDownloads(archiveWrites),
    runtime: {
      onMessage: { addListener: (fn) => { messageListener = fn; } },
      lastError: null
    },
    tabs: {
      query: (_q, cb) => cb(TABS),
      sendMessage: (tabId, msg, cb) => {
        if (msg && msg.type === "AE_DOM_SNAPSHOT") snapshotRequests.push(tabId);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.error("  ✗ " + name); }
}

(async () => {
  const tabA = { tab: { id: 7, url: "https://arena.ai/c/AAA" } };
  const tabB = { tab: { id: 9, url: "https://arena.ai/c/BBB" } };

  console.log("Two arena.ai tabs, two conversations:");
  await send({ type: "AE_EVENT", evt: { kind: "page_context", url: "https://arena.ai/c/AAA", conversationKey: "c:AAA" } }, tabA);
  await send({ type: "AE_EVENT", evt: { kind: "page_context", url: "https://arena.ai/c/BBB", conversationKey: "c:BBB" } }, tabB);

  // Give each session something to sync.
  await send({ type: "AE_EVENT", evt: { kind: "json", url: "https://arena.ai/api/chat/x", data: { role: "user", content: "prompt in A" } } }, tabA);
  await send({ type: "AE_EVENT", evt: { kind: "json", url: "https://arena.ai/api/chat/x", data: { role: "user", content: "prompt in B" } } }, tabB);

  const stateBefore = await send({ type: "AE_GET_STATE" });
  check("both sessions tracked", (stateBefore.sessions || []).length >= 2);

  console.log("Turn ends in tab 7 (conversation AAA):");
  snapshotRequests.length = 0;
  await send({ type: "AE_EVENT", evt: { kind: "stream_end", url: "https://arena.ai/api/chat/x" } }, tabA);
  await sleep(1100); // debounce is 750ms

  check("a snapshot was requested", snapshotRequests.length > 0);
  check("snapshot came from tab 7, not tab 9", snapshotRequests.every((id) => id === 7));

  console.log("Turn ends in tab 9 (conversation BBB):");
  snapshotRequests.length = 0;
  await send({ type: "AE_EVENT", evt: { kind: "stream_end", url: "https://arena.ai/api/chat/y" } }, tabB);
  await sleep(1100);

  check("snapshot came from tab 9, not tab 7", snapshotRequests.length > 0 && snapshotRequests.every((id) => id === 9));

  console.log("Simultaneous turns in both tabs are not collapsed:");
  snapshotRequests.length = 0;
  await send({ type: "AE_EVENT", evt: { kind: "stream_end", url: "https://arena.ai/api/chat/x" } }, tabA);
  await send({ type: "AE_EVENT", evt: { kind: "stream_end", url: "https://arena.ai/api/chat/y" } }, tabB);
  await sleep(1100);

  check("both conversations synced (per-key debounce)",
    snapshotRequests.includes(7) && snapshotRequests.includes(9));

  console.log("Manual Write to archive now is keyed by the popup's tab:");
  snapshotRequests.length = 0;
  await send({ type: "AE_SYNC", tabId: 7, sessionKey: "c:AAA" });
  check("manual sync snapshots tab 7, not tab 9",
    snapshotRequests.length === 1 && snapshotRequests[0] === 7);

  snapshotRequests.length = 0;
  await send({ type: "AE_SYNC", tabId: 9, sessionKey: "c:BBB" });
  check("manual sync snapshots tab 9 when asked",
    snapshotRequests.length === 1 && snapshotRequests[0] === 9);

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
