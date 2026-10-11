"use strict";
const assert = require("node:assert/strict");
const { worker } = require("./worker-harness");
const { fakeStorageArea } = require("./fake-chrome");

async function run() {
  const local = fakeStorageArea(), session = fakeStorageArea();
  const tab = { id: 55, url: "https://arena.ai/c/durable-battle" };
  const url = "https://arena.ai/nextjs-api/stream/create-evaluation";
  const w = worker({ local, session });
  await w.ready();
  const req = "durable-request-1";
  await w.event({ kind: "page_context", url: tab.url, conversationKey: "c:durable-battle" }, tab);
  await w.event({
    kind: "request", url, pageUrl: tab.url, requestId: req,
    body: JSON.stringify({ id: "durable-battle", mode: "battle", userMessage: { content: "Test" },
      modelAMessageId: "msg-a", modelBMessageId: "msg-b" })
  }, tab);

  const tail = "LAST_TOOL_CALL_AFTER_96KB";
  const longAnswer = "A".repeat(220000) + tail;
  const raw = 'a0:"short"b0:' + JSON.stringify(longAnswer) + 'bd:{"finishReason":"stop"}';
  for (let start = 0; start < raw.length; start += 8192) {
    await w.event({ kind: "stream_chunk", url, pageUrl: tab.url, requestId: req,
      text: raw.slice(start, start + 8192) }, tab);
  }
  await w.context.AE.evalArchive.flush();
  const live = w.context.store.sessions["c:durable-battle"];
  const key = Object.keys(live.evaluationArchiveRefs)[0];
  assert.ok(key, "durable archive reference exists");
  assert.ok(live.evaluationArchiveRefs[key].chunks > 20, "all chunks indexed");
  assert.ok(live.evaluationStreams[key].length <= 96 * 1024, "hot session holds only a preview");
  assert.equal(live.truncatedEval, false, "safe preview truncation does not claim data loss");

  const export1 = await w.export("c:durable-battle");
  assert.ok(JSON.stringify(export1.battles).includes(tail), "full response survives the preview cap");
  await w.context.flushSave();

  // Closing/reopening the service worker must not destroy the chunk records.
  const reopened = worker({ local, session });
  await reopened.ready();
  const export2 = await reopened.export("c:durable-battle");
  assert.ok(JSON.stringify(export2.battles).includes(tail), "full response survives worker restart");

  // Visible later tool rows must enrich a partial network capture, not be
  // discarded just because the first tools arrived through the stream.
  const network = [
    { toolCallId: "n1", toolName: "create_file", args: { path: "a.ts", content: "first" } },
    { toolCallId: "n2", toolName: "edit_file", args: { path: "a.ts", patch: "first edit" } }
  ];
  const dom = [
    { toolCallId: null, toolName: "create_file", args: { path: "a.ts" }, source: "dom" },
    { toolCallId: null, toolName: "edit_file", args: { path: "a.ts" }, source: "dom" },
    { toolCallId: null, toolName: "edit_file", args: { path: "handoff.md", patch: "late edit" }, source: "dom" },
    { toolCallId: null, toolName: "create_file", args: { path: "tests/content.spec.mjs" }, source: "dom" }
  ];
  const merged = reopened.context.mergeLaneToolCalls(network, dom);
  assert.equal(merged.length, 4, "later DOM calls are retained");
  assert.equal(merged[0].toolCallId, "n1", "original network identity is preserved");
  assert.equal(merged[1].args.patch, "first edit", "network details override weaker DOM details");
  assert.equal(merged[3].args.path, "tests/content.spec.mjs", "last operation is kept");
  assert.equal(reopened.context.mergeLaneToolCalls(network, dom.slice(0, 1)).length, 2,
    "a smaller DOM snapshot cannot erase network calls");

  console.log("Durable battle capture, worker restart and DOM reconciliation passed");
}
run().catch(error => { console.error(error); process.exitCode = 1; });
