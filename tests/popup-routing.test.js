/* Popup actions must always identify the active Arena conversation.
 * Usage: node tests/popup-routing.test.js */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const TAB = { id: 55, url: "https://arena.ai/c/active-tab-uuid" };
const sent = [];
const ids = [
  "version-badge", "status-dot", "context", "context-msg", "sink-status", "stats", "warnings", "warning-list",
  "actions", "progress", "progress-msg", "endpoints", "endpoint-list", "row-streamchunks",
  "stat-messages", "stat-thinking", "stat-tools", "stat-commands", "stat-actions", "stat-artifacts",
  "stat-endpoints", "stat-vote", "stat-streamchunks", "btn-sync", "btn-full", "btn-last", "btn-copy",
  "btn-clear", "btn-domdebug", "vote-a", "vote-b", "vote-tie", "vote-bad", "vote-clear"
];

function element(id) {
  const classes = new Set(id === "actions" || id === "stats" ? ["hidden"] : []);
  return {
    id, className: "", textContent: "", title: "", disabled: false, children: [], listeners: {},
    classList: {
      add: (...xs) => xs.forEach((x) => classes.add(x)),
      remove: (...xs) => xs.forEach((x) => classes.delete(x)),
      toggle: (x, force) => force === undefined ? (classes.has(x) ? classes.delete(x) : classes.add(x)) : (force ? classes.add(x) : classes.delete(x))
    },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    appendChild(child) { this.children.push(child); }
  };
}

const elements = Object.fromEntries(ids.map((id) => [id, element(id)]));
const state = {
  conversationKey: "c:active-tab-uuid", messageCount: 0, blockCounts: {}, endpointCount: 0,
  endpoints: [], warnings: [], streaming: false, streamChunkCount: 0, lastBattleVote: null, lastSync: null
};
const ctx = vm.createContext({
  console, setTimeout, clearTimeout, Promise, Date, JSON, Object, Array, String, Map, Blob, URL,
  document: {
    getElementById: (id) => elements[id] || (elements[id] = element(id)),
    createElement: (tag) => element(tag)
  },
  navigator: { clipboard: { writeText: async () => {} } },
  AE: {},
  chrome: {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: "test" }),
      sendMessage: (msg, cb) => {
        sent.push(msg);
        if (msg.type === "AE_GET_STATE") cb({ ok: true, state });
        else if (msg.type === "AE_SET_MANUAL_VOTE") cb({ ok: true, state });
        else if (msg.type === "AE_CLEAR") cb({ ok: true });
        else cb({ ok: false });
      }
    },
    tabs: {
      query: (_query, cb) => cb ? cb([TAB]) : Promise.resolve([TAB]),
      sendMessage: (_tabId, msg, cb) => cb(msg.type === "AE_PING" ? { ok: true } :
        { source: "dom", url: TAB.url, messages: [], battle: null })
    },
    downloads: { download: (_opts, cb) => cb(1) }
  }
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "popup.js"), "utf8"), ctx);

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function fire(id) {
  const handlers = elements[id].listeners.click || [];
  for (const fn of handlers) await fn({});
  await tick();
}
function last(type) { return sent.filter((m) => m.type === type).slice(-1)[0]; }
let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.error("  ✗ " + name); }
}

(async () => {
  await tick();
  check("initial state request is keyed to the active tab", last("AE_GET_STATE").sessionKey === "c:active-tab-uuid");

  await fire("btn-full");
  check("full-history export carries tab id and conversation key",
    last("AE_EXPORT").tabId === 55 && last("AE_EXPORT").sessionKey === "c:active-tab-uuid");
  await fire("btn-last");
  check("last-message export carries the conversation key", last("AE_EXPORT").sessionKey === "c:active-tab-uuid");
  await fire("btn-copy");
  check("copy JSON carries the conversation key", last("AE_EXPORT").sessionKey === "c:active-tab-uuid");
  await fire("vote-a");
  check("manual vote is applied to the active conversation", last("AE_SET_MANUAL_VOTE").sessionKey === "c:active-tab-uuid");
  await fire("btn-clear");
  check("capture reset is applied to the active conversation", last("AE_CLEAR").sessionKey === "c:active-tab-uuid");

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
