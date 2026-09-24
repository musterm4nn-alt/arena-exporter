"use strict";
const assert = require("node:assert/strict");
const { worker } = require("./worker-harness");

(async () => {
  const w = worker();
  await w.ready();
  const foreign = { id: 9, url: "https://example.com/not-arena" };
  const denied = await w.send({ type: "AE_EXPORT", mode: "full_history" }, foreign);
  assert.equal(denied.ok, false);
  assert.match(denied.error, /Arena Exporter/);
  const deniedSave = await w.send({ type: "AE_SAVE_TEXT", filename: "x.txt", text: "x" }, foreign);
  assert.equal(deniedSave.ok, false);
  const progress = await w.send({ type: "AE_HISTORY_PROGRESS", stage: "list" }, { id: 9, url: "https://arena.ai/c/auth" });
  assert.equal(progress.ok, true);
  await w.event({ kind: "json", url: "https://arena.ai/api/chat/auth", data: { role: "user", content: "still captured" } }, { id: 9, url: "https://arena.ai/c/auth" });
  console.log("Message authorization tests passed: extension-only RPCs reject foreign senders while Arena capture remains available.");
})().catch(error => { console.error(error); process.exitCode = 1; });
