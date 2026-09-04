/* Regression tests for the v1.15.0 fix batch:
 *   #1 stream-resume rebuild must preserve tool/artifact blocks
 *   #2 migrateSession merges a non-empty source bucket instead of dropping it
 *   #3 sticky session routing (tabKeys beat the tab URL for capture events)
 *   #4 incidental model hints never identify the Agent orchestrator (v1.17.0)
 *   #5 markdown "Models:" line reads contestants, not a nonexistent field
 * Usage: node tests/fixes.test.js */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { fakeStorageArea, fakeDownloads } = require("./fake-chrome");

const ROOT = path.join(__dirname, "..", "src");

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.error("  ✗ " + name); }
}

function makeWorker({ tabId, tabUrl }) {
  let messageListener = null;
  const archiveWrites = [];
  const ctx = vm.createContext({
    console,
    setTimeout, clearTimeout,
    JSON, Math, Date, Object, Array, String, Number, Set, Promise, RegExp,
    crypto: globalThis.crypto,
    TextEncoder, TextDecoder,
    importScripts: (...files) => {
      for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx);
    },
    chrome: {
      storage: { session: { get: async () => ({}), set: async () => {} }, local: fakeStorageArea() },
      downloads: fakeDownloads(archiveWrites),
      runtime: { onMessage: { addListener: (fn) => { messageListener = fn; } }, lastError: null }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), ctx);
  function send(msg, sender) {
    const from = sender || { tab: { id: tabId, url: tabUrl } };
    return new Promise((resolve) => {
      const ret = messageListener(msg, from, resolve);
      if (ret === undefined) resolve(null);
    });
  }
  function evalJs(code) { return vm.runInContext(code, ctx); }
  return { send, evalJs };
}

(async () => {
  /* ---------- #1 resume preserves tool blocks ---------- */
  console.log("#1 Mid-stream resume keeps tool calls and artifacts:");
  const w1 = makeWorker({ tabId: 1, tabUrl: "https://arena.ai/" });
  const rec = (body) => w1.send({ type: "AE_EVENT", evt: {
    kind: "sse", url: "https://arena.ai/ai-proxy/realtime/v1/sessions/s1/out",
    event: "message", data: { records: [{ seq_num: 1, timestamp: Date.now(), body: JSON.stringify({ data: body }) }] }
  } });
  await w1.send({ type: "AE_EVENT", evt: { kind: "session_hint", sessionId: "s1", url: "" } });
  await rec({ type: "start", messageId: "m-resume" });
  await rec({ type: "tool-input-start", toolCallId: "call_R", toolName: "write" });
  await rec({ type: "tool-input-available", toolCallId: "call_R", input: { file: "a.html" } });
  await rec({ type: "tool-output-available", toolCallId: "call_R", output: { ok: true } });
  await rec({ type: "finish" });
  // Simulate a service-worker restart mid-stream: builder gone, message kept.
  w1.evalJs("store.sessions[store.activeKey].currentStreamKey = null; store.sessions[store.activeKey].streamBuilders = {};");
  // Chunks arrive with NO start frame — must resume and reseed from content.
  // Sent as a /out records envelope, which is the only shape routed into
  // handleStreamChunk (bare events go through the generic normalizer).
  await rec({ type: "text-delta", id: "t1", delta: " resumed text" });
  const ex1 = await w1.send({ type: "AE_EXPORT", mode: "full_history", snapshot: null });
  const p1 = JSON.parse(ex1.json);
  const msg1 = p1.messages[p1.messages.length - 1];
  check("tool_call survives the resume rebuild", !!msg1.content.some((b) => b.type === "tool_call" && b.tool_name === "write"));
  check("tool arguments survive", JSON.stringify(msg1.content.find((b) => b.type === "tool_call").arguments).indexOf("a.html") !== -1);
  check("tool_result survives", msg1.content.some((b) => b.type === "tool_result" && b.status === "success"));
  check("post-resume text appended, not duplicated", msg1.content.filter((b) => b.type === "text" && b.text === " resumed text").length === 1);

  /* ---------- #2 migrateSession merges non-empty buckets ---------- */
  console.log("#2 Migration folds a non-empty placeholder bucket into the destination:");
  const w2 = makeWorker({ tabId: 2, tabUrl: "https://arena.ai/" });
  // Capture real data into the "default" bucket before any key is known.
  await w2.send({ type: "AE_EVENT", evt: { kind: "json", url: "https://arena.ai/api/agent/chat", data: { role: "user", content: "pre-hint prompt" } } });
  w2.evalJs("migrateSession(store.activeKey, 'c:newkey')");
  const merged = w2.evalJs("store.sessions['c:newkey']");
  check("destination exists after merge", !!merged);
  check("source tab bucket removed", w2.evalJs("!store.sessions['tab:2'] && canonicalSessionKey('tab:2') === 'c:newkey'"));
  check("messages survived the merge", merged.messages.some((m) => m.content.some((b) => b.text === "pre-hint prompt")));
  check("activeKey repointed", w2.evalJs("store.activeKey") === "c:newkey");

  /* ---------- #3 sticky routing ---------- */
  console.log("#3 Plain capture events follow the established tab mapping:");
  const w3 = makeWorker({ tabId: 3, tabUrl: "https://arena.ai/c/abc" });
  // Establish c:<id> for this tab…
  await w3.send({ type: "AE_EVENT", evt: { kind: "page_context", conversationKey: "c:abc", url: "https://arena.ai/c/abc", title: "t" } });
  // …then a hint points the same tab at the realtime session bucket.
  await w3.send({ type: "AE_EVENT", evt: { kind: "session_hint", sessionId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", url: "https://arena.ai/ai-proxy/realtime/v1/sessions/3f2504e0-4f89-11d3-9a0c-0305e82c3301/out" } });
  const sKey = "s:3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  // A plain capture event must land in the hinted bucket, not back in c:abc.
  await w3.send({ type: "AE_EVENT", evt: { kind: "json", url: "https://arena.ai/api/chat/x", data: { role: "user", content: "sticky routing probe" } } });
  check("hint resolves to the page conversation", w3.evalJs(`canonicalSessionKey(${JSON.stringify(sKey)})`) === "c:abc");
  check("capture is present under the page key used by the popup", w3.evalJs(`(store.sessions["c:abc"].messages||[]).some(m=>m.content.some(b=>b.text==="sticky routing probe"))`));

  /* ---------- #4 orchestrator model scan ---------- */
  console.log("#4 Model hints remain unverified:");
  const w4 = makeWorker({ tabId: 4, tabUrl: "https://arena.ai/" });
  await w4.send({ type: "AE_EVENT", evt: { kind: "session_hint", sessionId: "agent-scan", url: "" } });
  await w4.send({ type: "AE_EVENT", evt: { kind: "json", url: "https://arena.ai/api/chat/agent-scan/x", data: { role: "user", content: "hi" } } });
  // an assistant turn must exist for an agent-mode attribution sample
  await w4.send({ type: "AE_EVENT", evt: { kind: "json", url: "https://arena.ai/api/chat/agent-scan/x", data: { role: "assistant", content: "hello" } } });
  await w4.send({ type: "AE_EVENT", evt: { kind: "json", url: "https://arena.ai/api/chat/agent-scan/session", data: { model: "claude-opus-4-6-agent", sessionId: "agent-scan" } } });
  await w4.send({ type: "AE_EVENT", evt: { kind: "json", url: "https://arena.ai/api/chat/agent-scan/session", data: { config: { model_name: "claude-opus-4-6-agent" } } } });
  const ex4 = await w4.send({ type: "AE_EXPORT", mode: "full_history", snapshot: null });
  const p4 = JSON.parse(ex4.json);
  check("orchestrator_model remains unknown", p4.session.orchestrator_model === null);
  check("model_source is not_revealed", p4.session.orchestrator_model_source === "not_revealed");
  const sample4 = (p4.attribution_samples || []).find((s) => s.mode.indexOf("agent") === 0);
  check("attribution sample stays unlabeled", !!sample4 && sample4.model === null && sample4.model_source === "not_revealed");
  // Ambiguous evidence must NOT claim identity.
  await w4.send({ type: "AE_EVENT", evt: { kind: "json", url: "https://arena.ai/api/chat/agent-scan/other", data: { model: "gpt-5.2-agent" } } });
  const ex4b = await w4.send({ type: "AE_EXPORT", mode: "full_history", snapshot: null });
  const p4b = JSON.parse(ex4b.json);
  check("ambiguous hints stay candidates, not claims", p4b.session.orchestrator_model === null && Array.isArray(p4b.session.orchestrator_model_candidates));

  /* ---------- #5 markdown models line ---------- */
  console.log("#5 Markdown reader reflects anonymity via contestants:");
  const md = w1.evalJs(`AE.renderMarkdown({
    session: {}, export: {},
    battles: [{ index: 1, outcome: "pending", contestants: [
      { lane: "A", model: null, response: "x" },
      { lane: "B", model: null, response: "y" }
    ]}]
  })`);
  check("anonymous battle renders 'Models: pending'", /- Models: pending/.test(md));
  check("no phantom anonymous field needed", md.indexOf("(anonymous)") !== -1);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
