#!/usr/bin/env node
// Dependency-free static checks for Arena Exporter source.
// Complements tools/check-project.mjs (manifests, assets, syntax): this gate
// enforces code-hygiene rules that `node --check` cannot see.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const failures = [];

// Generated mirrors are outputs, not hand-written source.
const GENERATED = new Set(["src/injected-main.js", "src/injected-content.js"]);

function sourceFiles(relative) {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) return sourceFiles(name);
    return entry.isFile() && /\.(?:js|mjs)$/.test(entry.name) ? [name] : [];
  });
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "\n")
    .replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");
}

const DOM_SINKS = /innerHTML|outerHTML|insertAdjacentHTML|document\.write\s*\(/;
// Reads of page HTML for redacted diagnostics only; writes to the extension
// UI are forbidden (popup/options controllers use textContent).
const DOM_SINK_ALLOWLIST = new Set(["src/lib/dom-extract.js"]);
// Modules converted to const/let (item 8): no new function-local var.
const MODERN_FILES = new Set([
  "src/lib/vote.js", "src/lib/format.js", "src/lib/schema.js",
  "src/lib/evaluation-stream.js", "src/lib/privacy.js", "src/lib/page-data.js",
  "src/streaming-export.js", "src/markdown.js", "src/attribution.js",
  "src/capture-health.js", "src/backup-store.js", "src/archive-folder.js",
  "src/export-download.js", "src/turn-sync.js", "src/request-capture.js",
  "src/ui-state.js", "src/ui-model.js", "src/status-led.js"
]);

for (const file of [...sourceFiles("src").filter(f => !GENERATED.has(f)), ...sourceFiles("tools")]) {
  const raw = fs.readFileSync(path.join(root, file), "utf8");
  const text = stripComments(raw);
  const inTools = file.startsWith("tools/");
  // Built from fragments so this file's own source does not trip its rules.
  const evalCall = new RegExp("\\be" + "val\\s*\\(");
  const workMarker = new RegExp("\\b(" + ["TO" + "DO", "FIX" + "ME", "X" + "XX", "HA" + "CK"].join("|") + ")\\b");
  if (evalCall.test(text)) failures.push(`${file}: dynamic code execution via eval is forbidden`);
  if (workMarker.test(text)) failures.push(`${file}: leftover work marker`);
  if (!inTools && /console\.(log|debug)\s*\(/.test(text)) failures.push(`${file}: console.log/debug is forbidden in extension source`);
  if (!inTools && !DOM_SINK_ALLOWLIST.has(file) && DOM_SINKS.test(text)) {
    failures.push(`${file}: raw HTML sink is forbidden outside src/lib/dom-extract.js`);
  }
  if (MODERN_FILES.has(file)) {
    for (const line of text.split("\n")) {
      // var AE lines and the cross-file autoArchiveEnabled flag predate the
      // const/let convention and stay on var for the global-object contract.
      if (/\bvar\b/.test(line) && !/var AE = AE \|\| \{\}/.test(line) && !/var autoArchiveEnabled/.test(line)) {
        failures.push(`${file}: var is forbidden in modernized modules (use const/let)`);
        break;
      }
    }
  }
}

if (failures.length) {
  console.error("Lint failed:\n- " + failures.join("\n- "));
  process.exit(1);
}
console.log(`Lint passed: no eval, work markers, debug logging, or raw HTML sinks in extension source.`);
