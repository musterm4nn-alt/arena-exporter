"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createIndexedDB } = require("./fake-indexeddb");
const { agentPayload } = require("./research-fixture");

const root = path.join(__dirname, "..");
const context = vm.createContext({
  console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView,
  crypto: globalThis.crypto, URL, Date, JSON, Number, String, Object, Array, Set,
  indexedDB: createIndexedDB(), structuredClone, queueMicrotask, Promise, setTimeout
});
for (const file of ["src/lib/research.js", "src/research-store.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
}
const AE = context.AE;
const store = AE.researchStore;

(async () => {
  const json = JSON.stringify(agentPayload(), null, 2);
  let status = await store.status();
  assert.equal(status.available, true);
  assert.equal(status.blocked, false);
  assert.equal(status.count, 0);

  const indexed = await store.indexJson(json, { updated_at: "2026-09-24T11:00:00.000Z", rel: "agent/weather--abc-123" });
  assert.equal(indexed.ok, true);
  assert.equal(indexed.key, "c:abc-123");
  assert.equal(indexed.payload_omitted, false);

  status = await store.status();
  assert.equal(status.count, 1);
  assert.ok(status.bytes > 0);
  assert.equal(status.last_indexed_at, indexed.record.indexed_at);

  const loaded = await store.get("c:abc-123");
  assert.equal(loaded.json, json);
  assert.equal(loaded.record.title, "Plan a weekend in Cottbus");
  assert.equal(await store.has("c:abc-123"), true);
  assert.equal(await store.has("c:missing"), false);

  const list = await store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].key, "c:abc-123");

  await store.indexJson(json, { updated_at: "2026-09-24T12:00:00.000Z", rel: "agent/weather--abc-123" });
  status = await store.status();
  assert.equal(status.count, 1, "re-indexing replaces instead of duplicating");

  const hash = await AE.research.archiveHash(json);
  const archiveIndex = {
    "c:abc-123": {
      title: "Plan a weekend in Cottbus",
      updated_at: "2026-09-24T12:00:00.000Z",
      destinations: {
        "downloads:Downloads/arena-archive": { updated_at: "2026-09-24T12:00:00.000Z", rel: "agent/weather--abc-123", hashes: { "conversation.json": hash } }
      }
    }
  };
  let report = await store.verify(archiveIndex);
  assert.equal(report.checked, 1);
  assert.equal(report.matched, 1);
  assert.equal(report.mismatched.length, 0);

  const wrong = JSON.parse(JSON.stringify(archiveIndex));
  wrong["c:abc-123"].destinations["downloads:Downloads/arena-archive"].hashes["conversation.json"] = "0".repeat(64);
  report = await store.verify(wrong);
  assert.equal(report.mismatched.length, 1);
  assert.equal(report.matched, 0);

  const missing = JSON.parse(JSON.stringify(archiveIndex));
  missing["c:other"] = { title: "Other", updated_at: "2026-09-22T00:00:00.000Z" };
  report = await store.verify(missing);
  assert.equal(report.missing.length, 1);
  assert.equal(report.missing[0].key, "c:other");

  report = await store.verify({});
  assert.equal(report.orphaned.length, 1);

  const stale = JSON.parse(JSON.stringify(archiveIndex));
  stale["c:abc-123"].updated_at = "2026-09-25T00:00:00.000Z";
  report = await store.verify(stale);
  assert.equal(report.stale.length, 1);

  const imported = await store.importItems([
    { path: "agent/b.json", text: JSON.stringify(Object.assign(agentPayload(), { session: { conversation_key: "c:imported-1", title: "Imported" } })) },
    { path: "agent/broken.json", text: "{not json" },
    { path: "agent/empty.json" }
  ]);
  assert.equal(imported.imported, 1);
  assert.equal(imported.skipped.length, 2);
  assert.equal((await store.status()).count, 2);

  const beforeRemove = (await store.status()).bytes;
  const removed = await store.remove(["c:imported-1"]);
  assert.equal(removed, 1);
  status = await store.status();
  assert.equal(status.count, 1);
  assert.ok(status.bytes > 0 && status.bytes < beforeRemove, "byte accounting follows removal");

  AE.archiveEncryption = { status: () => ({ enabled: true }) };
  const blocked = await store.status();
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.available, true);
  await assert.rejects(() => store.indexJson(json, {}), /archive encryption/i);
  await assert.rejects(() => store.importJson(json, {}), /archive encryption/i);
  await assert.rejects(() => store.list(), /archive encryption/i, "reads are blocked as well as writes");
  await assert.rejects(() => store.get("c:abc-123"), /archive encryption/i);
  await assert.rejects(() => store.verify({}), /archive encryption/i);
  assert.equal(await store.has("c:abc-123"), false, "existence checks do not expose a blocked library");
  delete AE.archiveEncryption;

  await store.clear();
  status = await store.status();
  assert.equal(status.count, 0);
  assert.equal(status.bytes, 0);
  assert.equal(await store.has("c:abc-123"), false);

  console.log("Research store passed: indexing, replacement, hashes, verification states, imports, removal, encryption gate, and clear.");
})().catch(error => { console.error(error); process.exitCode = 1; });
