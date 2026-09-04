"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), zlib = require("node:zlib");
const { worker } = require("./worker-harness");
const root = path.join(__dirname, "..");
const watchdog = setTimeout(() => { console.error("Packaging test stalled"); process.exit(1); }, 10000);

function zipEntries(file) {
  const bytes = fs.readFileSync(file), result = new Map();
  let offset = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(offset >= 0, "ZIP end record exists");
  const count = bytes.readUInt16LE(offset + 10);
  offset = bytes.readUInt32LE(offset + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
    const nameSize = bytes.readUInt16LE(offset + 28), extraSize = bytes.readUInt16LE(offset + 30), commentSize = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42), name = bytes.subarray(offset + 46, offset + 46 + nameSize).toString();
    const localName = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28);
    const body = bytes.subarray(local + 30 + localName + localExtra, local + 30 + localName + localExtra + compressed);
    const content = zlib.inflateRawSync(body);
    assert.equal(content.length, size);
    result.set(name, content);
    offset += 46 + nameSize + extraSize + commentSize;
  }
  return result;
}

(async () => {
  const chrome = require("../manifest.json");
  const firefox = require("../firefox/manifest.json");
  assert.equal(chrome.version, "1.17.1");
  assert.equal(firefox.version, chrome.version);
  assert.equal(chrome.background.service_worker, "src/background.js");
  assert.ok(!firefox.key);
  assert.ok(!firefox.optional_permissions);
  assert.ok(Array.isArray(firefox.background.scripts));
  assert.equal(firefox.background.scripts.at(-1), "src/background.js");

  const imported = [...fs.readFileSync(path.join(root, chrome.background.service_worker), "utf8").match(/importScripts\(([^]*?)\);/)[1].matchAll(/"([^"]+)"/g)].map(match => "src/" + match[1]);
  assert.deepEqual(firefox.background.scripts.slice(0, -1), imported);
  for (const script of firefox.background.scripts) assert.ok(fs.statSync(path.join(root, "firefox", script)).isFile(), script);
  for (const file of ["src/interceptor.js", "src/content.js", "src/lib/privacy.js", "src/lib/page-data.js", "icons/icon128.png"]) {
    assert.deepEqual(fs.readFileSync(path.join(root, file)), fs.readFileSync(path.join(root, "firefox", file)), file);
  }

  const version = chrome.version;
  for (const browser of ["chrome", "firefox"]) {
    const archive = zipEntries(path.join(root, "dist", `Arena-Agent-Exporter-${version}-${browser}.zip`));
    assert.equal(JSON.parse(archive.get("manifest.json")).version, version);
    assert.ok(archive.has("src/background.js"));
    assert.ok(archive.has("src/lib/privacy.js"));
    assert.ok(archive.has("docs/export-schema.md"));
  }

  // Load every Firefox background script in manifest order and exercise export.
  const firefoxWorker = worker({ firefox: true });
  await firefoxWorker.ready();
  assert.equal(firefoxWorker.context.AE.SCHEMA_VERSION, "2.1");
  const tab = { id: 17, url: "https://arena.ai/agent/firefox-package" };
  await firefoxWorker.event({ kind: "json", url: tab.url, data: { role: "user", content: "Packaged Firefox" } }, tab);
  const payload = await firefoxWorker.export(firefoxWorker.context.store.tabKeys[17]);
  assert.equal(payload.export.extension_version, version);
  assert.ok(JSON.stringify(payload).includes("Packaged Firefox"));

  console.log("Chrome and Firefox manifests, ZIP contents and Firefox background loading passed");
  clearTimeout(watchdog);
})().catch(error => { clearTimeout(watchdog); console.error(error); process.exitCode = 1; });
