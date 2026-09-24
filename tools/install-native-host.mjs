#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromeExtensionId, nativeHostManifest } from "./native-host-manifest.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const valueAfter = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const has = flag => args.includes(flag);
const hostArg = valueAfter("--host");
const browserArg = valueAfter("--browser") || "all";
const force = has("--force");
const dryRun = has("--dry-run");
if (!hostArg || !["chrome", "firefox", "all"].includes(browserArg)) {
  console.error("Usage: node tools/install-native-host.mjs --host /absolute/path/to/ArenaArchiveHost [--browser chrome|firefox|all] [--force] [--dry-run]");
  process.exit(2);
}
const host = path.resolve(hostArg);
if (!dryRun && !fs.existsSync(host)) {
  console.error(`Native host executable not found: ${host}`);
  process.exit(1);
}
if (!dryRun && process.platform !== "darwin") {
  console.error("Native host installation is supported on macOS; use --dry-run for inspection on other platforms.");
  process.exit(1);
}

const extensionManifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const extensionId = chromeExtensionId(extensionManifest.key);
const geckoId = extensionManifest.browser_specific_settings?.gecko?.id;
if (!geckoId) throw new Error("Firefox extension ID is missing from manifest.json");
const home = os.homedir();
const destinations = {
  chrome: path.join(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.arenaarchive.host.json"),
  firefox: path.join(home, "Library/Application Support/Mozilla/NativeMessagingHosts/com.arenaarchive.host.json")
};
const browsers = browserArg === "all" ? ["chrome", "firefox"] : [browserArg];
for (const browser of browsers) {
  const destination = destinations[browser];
  const manifest = nativeHostManifest(browser, { hostPath: host, publicKey: extensionManifest.key, geckoId });
  const json = JSON.stringify(manifest, null, 2) + "\n";
  if (dryRun) {
    console.log(`[dry-run] ${browser}: ${destination}`);
    console.log(json);
    continue;
  }
  if (fs.existsSync(destination) && !force) {
    console.error(`Refusing to overwrite existing manifest: ${destination} (use --force)`);
    process.exitCode = 1;
    continue;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, json, { encoding: "utf8", mode: 0o600 });
  console.log(`Installed ${browser} native host manifest: ${destination}`);
}
console.log(`Extension ID allowlist: ${extensionId}`);
