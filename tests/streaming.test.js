"use strict";
const assert = require("node:assert/strict");
const { worker } = require("./worker-harness");

(async () => {
  const w = worker();
  await w.ready();
  const tab = { id: 88, url: "https://arena.ai/c/stream-fixture" };
  await w.event({ kind: "page_context", url: tab.url, conversationKey: "c:stream-fixture", title: "Stream fixture" }, tab);
  await w.event({ kind: "json", url: "https://arena.ai/api/chat/stream-fixture", data: { role: "user", content: "stream prompt" } }, tab);
  await w.event({ kind: "json", url: "https://arena.ai/api/chat/stream-fixture", data: { role: "assistant", content: "stream answer" } }, tab);
  const payload = await w.export("c:stream-fixture");
  const jsonl = w.context.AE.renderJsonl(payload);
  const records = jsonl.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(records[0].type, "arena.export.header");
  assert.ok(records.some(record => record.type === "message"));
  assert.equal(records.at(-1).type, "arena.export.footer");

  const chunks = [];
  const stats = await w.context.AE.streamExport(payload, "jsonl", async chunk => { await Promise.resolve(); chunks.push(chunk); });
  assert.equal(stats.chunks, records.length);
  assert.equal(chunks.join(""), jsonl);
  const markdownChunks = [];
  const markdownStats = await w.context.AE.streamExport(payload, "markdown", chunk => markdownChunks.push(chunk));
  assert.ok(markdownStats.chunks > 0);
  assert.equal(markdownChunks.join(""), w.context.AE.renderMarkdown(payload), "streamed Markdown must match compatibility rendering");
  const routed = await w.send({ type: "AE_EXPORT", sessionKey: "c:stream-fixture", mode: "full_history", format: "jsonl", save: false }, null);
  assert.equal(routed.ok, true);
  assert.equal(routed.filename.endsWith(".jsonl"), true);
  const routedRecords = routed.text.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(routedRecords[0].type, "arena.export.header");
  assert.ok(routedRecords.some(record => record.message?.content?.[0]?.text === "stream answer"));
  console.log("Streaming export tests passed: JSONL records, async chunking, routed export, and Markdown compatibility.");
})().catch(error => { console.error(error); process.exitCode = 1; });
