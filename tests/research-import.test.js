"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const calls = [];
const AEUI = {
  send: async message => {
    calls.push(message);
    return { ok: true, imported: message.items.length, skipped: [] };
  }
};
const context = vm.createContext({ AEUI, console, Promise, Array, String, Number, Error, Object });
vm.runInContext(fs.readFileSync(path.join(root, "src/research-import.js"), "utf8"), context);

const file = (relative, text, options = {}) => ({
  name: path.posix.basename(relative),
  webkitRelativePath: relative,
  size: options.size == null ? Buffer.byteLength(text) : options.size,
  lastModified: 1760000000000,
  text: async () => text
});

(async () => {
  const progress = [];
  const files = [
    file("arena-archive/agent/weather/conversation.json", '{"a":1}'),
    file("arena-archive/battle/text/round/conversation.json", '{"b":2}'),
    file("agent/loose/conversation.json", '{"c":3}'),
    file("arena-archive/agent/weather/notes.txt", "ignored")
  ];
  const first = await AEUI.importResearch(files, (done, total, skipped) => progress.push([done, total, skipped]));
  assert.equal(first.imported, 3);
  assert.equal(first.total, 3, "only conversation.json files are candidates");
  assert.equal(first.skipped.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "AE_RESEARCH_IMPORT");
  assert.equal(calls[0].items[0].rel, "agent/weather");
  assert.equal(calls[0].items[1].rel, "battle/text/round");
  assert.equal(calls[0].items[2].rel, "agent/loose", "a folder selected below arena-archive still keeps its mode root");
  assert.equal(progress.length, 1);

  calls.length = 0;
  progress.length = 0;
  const many = Array.from({ length: 7 }, (_, i) => file("arena-archive/agent/c" + i + "/conversation.json", '{"i":' + i + "}"));
  many.push(file("arena-archive/agent/huge/conversation.json", "x", { size: 5 * 1024 * 1024 }));
  const second = await AEUI.importResearch(many, (done, total, skipped) => progress.push([done, total, skipped]));
  assert.equal(second.imported, 7);
  assert.equal(second.total, 8);
  assert.equal(second.skipped.length, 1);
  assert.match(second.skipped[0].reason, /4 MiB/);
  assert.equal(calls.length, 2, "reads are sent in batches");
  assert.equal(calls[0].items.length, 6);
  assert.equal(calls[1].items.length, 1);
  assert.equal(progress.length, 2);

  AEUI.send = async () => ({ ok: false, error: "Storage is full." });
  await assert.rejects(() => AEUI.importResearch([file("arena-archive/agent/x/conversation.json", "{}")]), /Storage is full/);
  await assert.rejects(() => AEUI.importResearch([file("arena-archive/agent/x/notes.txt", "no")]), /whole arena-archive folder/);
  console.log("Research import passed: folder paths, batching, 4 MiB cap, progress, and failure propagation.");
})().catch(error => { console.error(error); process.exitCode = 1; });
