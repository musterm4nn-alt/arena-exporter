"use strict";
const assert = require("node:assert/strict");
const { worker } = require("./worker-harness");
const tick = () => new Promise(resolve => setImmediate(resolve));
const watchdog = setTimeout(() => { console.error("Export download test stalled"); process.exit(1); }, 10000);

function fixture() {
  const blobs = new Map(), revoked = [], items = new Map(), listeners = new Set(), requests = [];
  let sequence = 0, callback, context;
  class ExportURL extends URL {}
  ExportURL.createObjectURL = blob => { const url = "blob:export-" + blobs.size; blobs.set(url, blob); return url; };
  ExportURL.revokeObjectURL = url => revoked.push(url);
  const downloads = {
    onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
    search: (query, cb) => cb(items.has(query.id) ? [items.get(query.id)] : []),
    download: (options, cb) => { requests.push(options); callback = cb; }
  };
  const w = worker({ downloads, URL: ExportURL });
  context = w.context;
  return { ...w, blobs, revoked, requests, listeners,
    start(state = "in_progress") { const id = ++sequence; items.set(id, { id, state }); callback(id); return id; },
    reject(message) { context.chrome.runtime.lastError = { message }; callback(); context.chrome.runtime.lastError = null; },
    finish(id, state = "complete", error) {
      items.set(id, { id, state, error });
      for (const listener of [...listeners]) listener({ id, state: { current: state }, ...(error ? { error: { current: error } } : {}) });
    }
  };
}

(async () => {
  const f = fixture(); await f.ready();
  const tab = { id: 1, url: "https://arena.ai/agent/download-test" };
  for (const [role, content] of [["user", "Old prompt"], ["assistant", "Old answer"], ["user", "Latest prompt"], ["assistant", "Latest answer — ✓"]]) {
    await f.event({ kind: "json", url: tab.url, data: { role, content } }, tab);
  }
  let settled = false;
  const pending = f.send({ type: "AE_EXPORT", mode: "last_message", sessionKey: "c:download-test", save: true }, null).then(value => { settled = true; return value; });
  await tick();
  assert.equal(f.requests.length, 1);
  const blobUrl = f.requests[0].url;
  const exported = JSON.parse(await f.blobs.get(blobUrl).text());
  assert.equal(exported.export.mode, "last_message");
  assert.deepEqual(exported.messages.map(m => m.content[0].text), ["Latest prompt", "Latest answer — ✓"]);
  const id = f.start();
  await tick();
  assert.ok(!f.revoked.includes(blobUrl), "Blob must remain readable after download starts");
  assert.equal(settled, false, "Do not claim Saved before completion");
  f.finish(id + 100); await tick();
  assert.equal(settled, false, "Ignore unrelated downloads");
  f.finish(id);
  assert.equal((await pending).ok, true);
  assert.deepEqual(f.revoked, [blobUrl]);

  const interrupted = fixture(); await interrupted.ready();
  const failure = interrupted.send({ type: "AE_SAVE_TEXT", filename: "failed.json", text: "{}" }, null);
  await tick(); const failedId = interrupted.start();
  interrupted.finish(failedId, "interrupted", "FILE_FAILED");
  const failed = await failure;
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "FILE_FAILED");
  assert.equal(interrupted.revoked.length, 1);

  const fast = fixture(); await fast.ready();
  const completedEarly = fast.send({ type: "AE_SAVE_TEXT", filename: "fast.json", text: "{}" }, null);
  await tick(); fast.start("complete");
  assert.equal((await completedEarly).ok, true, "Query handles completion before callback/listener");
  assert.equal(fast.revoked.length, 1);

  const cancel = fixture(); await cancel.ready();
  const cancelled = cancel.send({ type: "AE_SAVE_TEXT", filename: "cancel.json", text: "{}" }, null);
  await tick(); cancel.reject("Download canceled by the user");
  assert.equal((await cancelled).ok, false);
  assert.equal(cancel.requests.length, 1, "Cancelling Save As must not silently save elsewhere");
  assert.equal(cancel.revoked.length, 1);

  console.log("Last-message JSON, delayed Blob consumption, completion, interruption and cancellation passed");
  clearTimeout(watchdog);
})().catch(error => { clearTimeout(watchdog); console.error(error); process.exitCode = 1; });
