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
}

if (failures.length) {
  console.error("Lint failed:\n- " + failures.join("\n- "));
  process.exit(1);
}
console.log(`Lint passed: no eval, work markers, debug logging, or raw HTML sinks in extension source.`);
