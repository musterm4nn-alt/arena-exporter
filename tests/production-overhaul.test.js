"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { worker } = require("./worker-harness");

const watchdog = setTimeout(() => { console.error("Production-overhaul regression stalled"); process.exit(1); }, 10000);

function loadPrivacy() {
  const context = vm.createContext({ URL, URLSearchParams });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/lib/privacy.js"), "utf8"), context);
  return context.AE;
}

function evalRounds(w, mode, count) {
  const s = w.context.freshState("c:" + mode + "-multi");
  s.modelCatalog = {
    source_url: "https://arena.ai/text/" + mode,
    captured_at: new Date().toISOString(),
    models: [
      { id: "catalog-a", publicName: "Public A", userSelectable: true },
      { id: "catalog-b", publicName: "Public B", userSelectable: true }
    ]
  };
  for (let i = 1; i <= count; i++) {
    const requestId = mode + "-request-" + i;
    const init = {
      id: mode + "-conversation",
      mode,
      userMessageId: "user-" + i,
      modelAMessageId: "a-" + i,
      modelBMessageId: "b-" + i,
      modelAId: "catalog-a",
      modelBId: "catalog-b",
      userMessage: { content: mode + " prompt " + i }
    };
    const key = "https://arena.ai/nextjs-api/stream/post-to-evaluation#request:" + requestId;
    s.capturedRequests.push({ method: "POST", url: "https://arena.ai/nextjs-api/stream/post-to-evaluation", request_id: requestId, turn_id: "user-" + i, body: JSON.stringify(init) });
    s.requestAttempts.push({ request_id: requestId, turn_id: "user-" + i, evaluation_id: init.id, status: 200, outcome: "completed", mode });
    s.evaluationStreams[key] = JSON.stringify(init) + 'a0:"A answer ' + i + '"' +
      (mode === "direct" ? "" : 'b0:"B answer ' + i + '"') +
      'ad:{"finishReason":"stop"}' + (mode === "direct" ? "" : 'bd:{"finishReason":"stop"}');
    s.evaluationRequests[key] = requestId;
  }
  return { state: s, rounds: w.context.buildBattles(s, null) };
}

(async () => {
  const w = worker();
  await w.ready();

  // Agent: two prompts and two assistant messages remain four messages.
  const tab = { id: 41, url: "https://arena.ai/agent/agent-multi" };
  await w.event({ kind: "page_context", url: tab.url, conversationKey: "c:agent-multi" }, tab);
  await w.event({ kind: "json", url: "https://arena.ai/api/chat/agent-multi", data: { role: "user", content: "agent prompt 1" } }, tab);
  await w.event({ kind: "json", url: "https://arena.ai/api/chat/agent-multi", data: { role: "assistant", content: "agent answer 1" } }, tab);
  await w.event({ kind: "json", url: "https://arena.ai/api/chat/agent-multi", data: { role: "user", content: "agent prompt 2" } }, tab);
  await w.event({ kind: "json", url: "https://arena.ai/api/chat/agent-multi", data: { role: "assistant", content: "agent answer 2" } }, tab);
  const agent = await w.export("c:agent-multi");
  assert.equal(agent.messages.filter(m => m.role === "user").length, 2);
  assert.equal(agent.messages.filter(m => m.role === "assistant").length, 2);

  for (const mode of ["battle", "direct", "side-by-side"]) {
    const { rounds } = evalRounds(w, mode, 2);
    assert.equal(rounds.length, 2, mode + " must remain multi-turn");
    assert.equal(JSON.stringify(rounds.map(r => r.prompt)), JSON.stringify([mode + " prompt 1", mode + " prompt 2"]));
    assert.equal(rounds[0].contestants.length, mode === "direct" ? 1 : 2);
    assert.equal(rounds[1].contestants.length, mode === "direct" ? 1 : 2);
    if (mode !== "battle") {
      assert.equal(rounds[0].outcome, "not_applicable");
      assert.equal(rounds[0].contestants[0].model_source, "request_catalog");
      assert.equal(rounds[0].contestants[0].model_identity_verified, false);
    }
  }

  // Failed retry attempt remains metadata; successful retry is distinct.
  const rs = w.context.freshState("c:retry");
  const base = { url: "https://arena.ai/nextjs-api/stream/post-to-evaluation", method: "POST" };
  const body = JSON.stringify({ id: "retry-eval", mode: "battle", userMessageId: "retry-turn" });
  w.context.captureRequestMetadata(rs, { ...base, kind: "request", requestId: "try-1", capturedAt: "2026-09-07T10:00:00Z", body });
  w.context.captureResponseMetadata(rs, { ...base, kind: "request_error", requestId: "try-1", status: 429, error: "captcha rejected" });
  w.context.captureRequestMetadata(rs, { ...base, kind: "request", requestId: "try-2", capturedAt: "2026-09-07T10:00:01Z", body });
  w.context.captureResponseMetadata(rs, { ...base, kind: "endpoint", requestId: "try-2", status: 200, headers: {} });
  w.context.captureResponseMetadata(rs, { ...base, kind: "stream_end", requestId: "try-2", status: 200, headers: {} });
  assert.equal(rs.requestAttempts.length, 2);
  assert.equal(rs.requestAttempts[0].outcome, "captcha_rejected");
  assert.equal(rs.requestAttempts[1].outcome, "completed");
  assert.equal(rs.requestAttempts[1].retry_of, "try-1");

  // Semantic replay dedupe is message-scoped: exact frame replay is removed,
  // but an identical artifact in a later turn is real data and must survive.
  w.context.store.activeKey = "c:semantic-dedupe";
  w.context.store.sessions["c:semantic-dedupe"] = w.context.freshState("c:semantic-dedupe");
  const s = w.context.store.sessions["c:semantic-dedupe"];
  const artifact = { type: "artifact", artifact_type: "text/plain", title: "same.txt", content_or_url: "same.txt", source: "network" };
  const first = w.context.addMessage("assistant", s);
  w.context.appendBlock(first, artifact);
  w.context.appendBlock(first, artifact);
  w.context.addMessage("user", s).content.push({ type: "text", text: "again" });
  const second = w.context.addMessage("assistant", s);
  w.context.appendBlock(second, artifact);
  assert.equal(first.content.filter(b => b.type === "artifact").length, 1);
  assert.equal(second.content.filter(b => b.type === "artifact").length, 1);

  // Agent identity is never inferred from incidental hints.
  const ms = w.context.freshState("c:model");
  ms.modelHints["123e4567-e89b-12d3-a456-426614174000"] = { count: 99 };
  ms.modelHints["plausible-model-name"] = { count: 10 };
  const identity = w.context.resolveOrchestratorModel(ms);
  assert.equal(identity.model, null);
  assert.equal(identity.source, "not_revealed");

  // Nested JSON, GitHub PATs, URL credentials and private keys are structurally removed.
  const AE = loadPrivacy();
  const privateKey = "-----BEGIN PRIVATE KEY-----\nABCDEF\n-----END PRIVATE KEY-----";
  const nested = JSON.stringify({
    url: "https://alice:password@example.com/callback?access_token=secret&ok=1#refresh_token=hidden",
    github_token: "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
    deep: JSON.stringify({ authorization: "Bearer eyJabcdefgh.abc.def", private: privateKey })
  });
  const clean = AE.scrubSecrets({ wrapper: nested, safe: "keep me" });
  const serialized = JSON.stringify(clean);
  assert.equal(clean.safe, "keep me");
  assert.ok(!serialized.includes("password@"));
  assert.ok(!serialized.includes("secret"));
  assert.ok(!serialized.includes("hidden"));
  assert.ok(!serialized.includes("github_pat_"));
  assert.ok(!serialized.includes("BEGIN PRIVATE KEY"));
  assert.ok(serialized.includes("keep me"));

  // Identity and schema compatibility remain explicit release invariants.
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
  assert.equal(manifest.browser_specific_settings.gecko.id, "arena-agent-exporter@local");
  assert.equal(w.context.AE.SCHEMA_VERSION, "2.1");
  assert.equal(manifest.key, "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArhQpGxV1Ter6QjTSEm27ZiKNjdxpTf4P0uHH20qxzVRHexkuXD3DDUqiqgVDOEfMVMrc9/CuU6YbsrsNvawFNIhZRXugBtsfvu673zyKJjkpZQYZR5v9hzCKxIMQBNJ2u+KE1M5V4zPe/tlq6NSLol1EU+LEeqN481kpcEGoLfvAygGVm33w8TGo99OHcRHdixTmmRzH/OHKZbdRzVydVzOYwQKUFrbspC563YRfyZ+FiNQFbsd6xTJHskrmpVPe+RiJLhBne9JY8CroYtQc0NwyKyHY2Cad/UVSADnDi0DZ3lWeoIriThMzCEcq9Ah3kHzrS+OWwkoHV5qIhWu08wIDAQAB");

  console.log("Production overhaul regressions passed: modes, retries, scoped dedupe, provenance, privacy and identity.");
  clearTimeout(watchdog);
})().catch(error => { clearTimeout(watchdog); console.error(error); process.exitCode = 1; });
