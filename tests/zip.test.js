"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const context = vm.createContext({ console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView, Date, JSON, Number, String, Object, Array, Set });
for (const file of ["src/lib/zip.js", "src/lib/bulk.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
}
const AE = context.AE;

function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50, "EOCD signature");
  const count = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  assert.equal(view.getUint16(eocd + 8, true), count);
  const files = [];
  let cursor = centralOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(cursor, true), 0x02014b50, "central directory signature");
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const size = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    assert.equal(view.getUint32(localOffset, true), 0x04034b50, "local header signature");
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataStart, dataStart + size);
    files.push({ name, flags, method, crc, size, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const date = new Date(Date.UTC(2026, 9, 21, 12, 0, 0));
const files = [
  { name: "agent/weather--abc/conversation.json", data: JSON.stringify({ hello: "world" }, null, 2) },
  { name: "agent/weather--abc/conversation.md", data: "# Weather\n\nSonnig über Cottbus." },
  { name: "manifest.json", data: "{}" }
];
const zip = AE.zip.build(files, { date: date });
assert.ok(zip instanceof Uint8Array);
const parsed = readZip(zip);
assert.equal(parsed.length, 3);
assert.equal(parsed[0].name, "agent/weather--abc/conversation.json");
assert.equal(parsed[1].name, "agent/weather--abc/conversation.md");
assert.equal(parsed[1].method, 0, "entries are stored, not deflated");
assert.equal(parsed[1].flags & 0x0800, 0x0800, "UTF-8 name flag");
assert.equal(new TextDecoder().decode(parsed[1].data), files[1].data);
assert.equal(parsed[2].crc >>> 0, AE.zip.crc32(new TextEncoder().encode("{}")));

const again = AE.zip.build(files, { date: date });
assert.equal(Buffer.compare(Buffer.from(zip), Buffer.from(again)), 0, "fixed dates make the ZIP deterministic");

const crc = AE.zip.crc32(new TextEncoder().encode("123456789"));
assert.equal(crc >>> 0, 0xcbf43926, "standard CRC-32 check value");

assert.throws(() => AE.zip.build([]), /nothing/i);
assert.throws(() => AE.zip.build([{ name: "../escape.txt", data: "x" }]), /unsafe/i);
assert.throws(() => AE.zip.build([{ name: "", data: "x" }]), /invalid/i);

assert.match(AE.bulk.folderName(new Date(2026, 9, 21, 8, 5, 9)), /^Arena Exporter export 2026-10-21 08\.05\.09$/);

const used = new Set();
assert.equal(AE.bulk.bundlePath({ rel: "agent/weather--abc", title: "Weather", key: "c:abc" }, used), "agent/weather--abc");
assert.equal(AE.bulk.bundlePath({ rel: "agent/weather--abc", title: "Weather", key: "c:abc" }, used), "agent/weather--abc-2");
assert.equal(AE.bulk.bundlePath({ rel: "../../etc/passwd", title: "Safe title", key: "c:def" }, used), "safe-title--def");
assert.equal(AE.bulk.bundlePath({ rel: null, title: "Über Cottbus", key: "c:ghi" }, used), "ber-cottbus--ghi");

const manifest = AE.bulk.manifest({
  created_at: "2026-10-21T10:00:00.000Z",
  extension_version: "3.0.0",
  conversations: [{
    key: "c:abc", title: "Weather", mode: "agent", updated_at: "2026-10-20T10:00:00.000Z", folder: "agent/weather--abc",
    files: [{ name: "conversation.json", bytes: 12, sha256: "aa" }, { name: "conversation.md", bytes: 34, sha256: "bb" }]
  }],
  omitted: [{ key: "c:old", title: "Old", reason: "no_local_payload" }]
});
assert.equal(manifest.format, "arena-exporter-bulk-export/1");
assert.equal(manifest.schema_version, "2.1");
assert.equal(manifest.conversation_count, 1);
assert.equal(manifest.file_count, 2);
assert.equal(manifest.omitted_count, 1);
assert.equal(manifest.conversations[0].files[1].sha256, "bb");

console.log("ZIP and bulk export passed: stored entries, UTF-8 names, CRC, determinism, safe paths, and manifest shape.");
