"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");
const root = path.join(__dirname, "..");

(async () => {
  const native = await import(pathToFileURL(path.join(root, "tools/native-host-manifest.mjs")));
  const manifest = require("../manifest.json");
  const chromeId = native.chromeExtensionId(manifest.key);
  assert.equal(chromeId, "mgididhejcijedockcbmbmhpcefpcnpe");
  const chrome = native.nativeHostManifest("chrome", { hostPath: "/tmp/host", publicKey: manifest.key, geckoId: "arena-agent-exporter@local" });
  assert.deepEqual(chrome.allowed_origins, [`chrome-extension://${chromeId}/`]);
  assert.equal(chrome.allowed_extensions, undefined);
  const firefox = native.nativeHostManifest("firefox", { hostPath: "/tmp/host", publicKey: manifest.key, geckoId: "arena-agent-exporter@local" });
  assert.deepEqual(firefox.allowed_extensions, ["arena-agent-exporter@local"]);
  assert.equal(firefox.allowed_origins, undefined);

  const release = spawnSync(process.execPath, [path.join(root, "tools/release-local.mjs"), "--dry-run"], { cwd: root, encoding: "utf8" });
  assert.equal(release.status, 0, release.stdout + release.stderr);
  assert.match(release.stdout, /Local release dry run/);
  const host = spawnSync(process.execPath, [path.join(root, "tools/install-native-host.mjs"), "--host", root + "/fake-host", "--browser", "all", "--dry-run"], { cwd: root, encoding: "utf8" });
  assert.equal(host.status, 0, host.stdout + host.stderr);
  assert.match(host.stdout, /\[dry-run\] chrome/);
  assert.match(host.stdout, /allowed_origins/);
  assert.match(host.stdout, /allowed_extensions/);
  assert.match(host.stdout, new RegExp(chromeId));
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "arena-release-test-"));
  fs.writeFileSync(path.join(output, "Arena-Agent-Exporter-2.1.0-chrome.zip"), "stale");
  const built = spawnSync(process.execPath, [path.join(root, "tools/release-local.mjs"), "--skip-tests", "--output", output], { cwd: root, encoding: "utf8" });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const releaseManifest = JSON.parse(fs.readFileSync(path.join(output, "release-manifest.json"), "utf8"));
  assert.deepEqual(releaseManifest.artifacts.map(item => item.name).sort(), ["Arena-Agent-Exporter-2.2.1-chrome.zip", "Arena-Agent-Exporter-2.2.1-firefox.zip"]);
  fs.rmSync(output, { recursive: true, force: true });
  console.log("Local release and native-host installer tool checks passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
