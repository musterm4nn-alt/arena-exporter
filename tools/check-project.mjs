#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const firefox = JSON.parse(fs.readFileSync(path.join(root, "firefox/manifest.json"), "utf8"));
const failures = [];
const requireFile = relative => { if (!fs.existsSync(path.join(root, relative))) failures.push(`missing ${relative}`); };
const assert = (condition, message) => { if (!condition) failures.push(message); };
const sourceFiles = relative => fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
  const name = path.posix.join(relative, entry.name);
  if (entry.isDirectory()) return sourceFiles(name);
  return entry.isFile() ? [name] : [];
});

assert(pkg.version === manifest.version, `package version ${pkg.version} != manifest version ${manifest.version}`);
assert(manifest.version === firefox.version, `manifest version ${manifest.version} != Firefox version ${firefox.version}`);
assert(manifest.manifest_version === 3, "Chrome manifest must remain Manifest V3");
assert(firefox.manifest_version === 3, "Firefox manifest must remain Manifest V3");
assert(manifest.background && manifest.background.service_worker === "src/background.js", "Chrome background service worker changed unexpectedly");
assert(Array.isArray(firefox.background && firefox.background.scripts) && firefox.background.scripts.at(-1) === "src/background.js", "Firefox ordered background scripts are incomplete");
[
  "src/background.js", "src/encrypted-archive.js", "src/streaming-export.js", "src/injected-main.js", "src/injected-content.js", "src/popup.html", "src/options.html",
  "src/fonts/DepartureMono-Regular.woff2", "docs/architecture.md", "docs/security.md", "SECURITY.md",
  "macos/ArenaArchive/Package.swift", "macos/ArenaArchive/Sources/NativeHostCore/NativeHostCore.swift",
  "macos/ArenaArchive/Sources/NativeHost/main.swift", "macos/ArenaArchive/Sources/ArenaArchiveApp/ArenaArchiveApp.swift", "macos/ArenaArchive/Resources/com.arenaarchive.host.chrome.json", "macos/ArenaArchive/Resources/com.arenaarchive.host.firefox.json", "tools/install-native-host.mjs", "tools/native-host-manifest.mjs",
  "schemas/export-2.1.schema.json", "schemas/streaming-2.1.schema.json", "tools/validate-schema.mjs", "tools/acceptance.mjs", "tools/decrypt-archive.mjs", "tools/release-local.mjs"
].forEach(requireFile);

for (const file of ["src/popup.html", "src/options.html"]) {
  const html = fs.readFileSync(path.join(root, file), "utf8");
  assert(!/<script[^>]+src=["']https?:\/\//i.test(html), `${file} loads a remote script`);
  assert(!/<link[^>]+href=["']https?:\/\//i.test(html), `${file} loads a remote stylesheet`);
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/gi)) {
    const ref = match[1];
    if (/^(?:https?:|data:|#|mailto:|javascript:)/i.test(ref)) continue;
    const local = ref.split(/[?#]/)[0];
    if (local && !fs.existsSync(path.resolve(path.dirname(path.join(root, file)), local))) failures.push(`${file} references missing ${ref}`);
  }
}
const css = fs.readFileSync(path.join(root, "src/popup.css"), "utf8");
assert(!/url\(["']?https?:\/\//i.test(css), "popup.css loads a remote asset");
assert(css.includes("prefers-reduced-motion"), "reduced-motion treatment is missing");
assert(css.includes(":focus-visible"), "keyboard focus treatment is missing");
const swiftPackage = fs.readFileSync(path.join(root, "macos/ArenaArchive/Package.swift"), "utf8");
assert(swiftPackage.includes('executableTarget(name: "ArenaArchiveHost"'), "Swift native-host target is missing");
assert(swiftPackage.includes('path: "Sources/NativeHost"'), "Swift native-host source path is not explicit");

for (const file of [...sourceFiles("src").filter(file => file.endsWith(".js")), ...sourceFiles("tools").filter(file => /\.(?:js|mjs)$/.test(file))]) {
  const check = spawnSync(process.execPath, ["--check", path.join(root, file)], { encoding: "utf8" });
  if (check.status !== 0) failures.push(`syntax error in ${file}: ${(check.stderr || "").trim()}`);
}

if (failures.length) {
  console.error("Project check failed:\n- " + failures.join("\n- "));
  process.exit(1);
}
console.log(`Project check passed for Arena Exporter ${pkg.version}: manifests, local assets, accessibility, and generated entry points.`);
