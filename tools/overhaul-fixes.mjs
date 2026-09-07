#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = rel => fs.readFileSync(path.join(root, rel), "utf8");
const write = (rel, content) => fs.writeFileSync(path.join(root, rel), content);
function replace(rel, from, to) {
  const current = read(rel);
  if (!current.includes(from)) throw new Error("Patch source not found in " + rel);
  write(rel, current.replace(from, to));
}
replace("src/lib/privacy.js", `  function scrubFragment(url) {
    var hash = String(url.hash || "");
    if (!hash || hash.indexOf("=") === -1) return;
    try {
      var params = new URLSearchParams(hash.slice(1));
      var changed = false;
      Array.from(params.keys()).forEach(function (key) {
        if (!secretName(key)) return;
        params.set(key, "[REDACTED]");
        changed = true;
      });
      if (changed) url.hash = "#" + params.toString();
    } catch (_) { /* preserve opaque fragments */ }
  }

  AE.scrubCredentialUrl = function (value) {
    var text = String(value || "");
    try {
      var url = new URL(text);
      if (url.username || url.password) {
        url.username = "";
        url.password = "";
      }
      Array.from(url.searchParams.keys()).forEach(function (key) {
        if (secretName(key)) url.searchParams.set(key, "[REDACTED]");
      });
      scrubFragment(url);
      return url.toString();
    } catch (_) {
      return text.replace(QUERY_SECRET, "$1[REDACTED]");
    }
  };`, `  function scrubFragment(url) {
    var hash = String(url.hash || "");
    if (!hash || hash.indexOf("=") === -1) return false;
    try {
      var params = new URLSearchParams(hash.slice(1));
      var changed = false;
      Array.from(params.keys()).forEach(function (key) {
        if (!secretName(key)) return;
        params.set(key, "[REDACTED]");
        changed = true;
      });
      if (changed) url.hash = "#" + params.toString();
      return changed;
    } catch (_) { return false; }
  }

  AE.scrubCredentialUrl = function (value) {
    var text = String(value || "");
    try {
      var url = new URL(text), changed = false;
      if (url.username || url.password) {
        url.username = "";
        url.password = "";
        changed = true;
      }
      Array.from(url.searchParams.keys()).forEach(function (key) {
        if (!secretName(key)) return;
        url.searchParams.set(key, "[REDACTED]");
        changed = true;
      });
      if (scrubFragment(url)) changed = true;
      // Exact preservation matters for raw stream grammars: harmless URLs must
      // remain byte-for-byte unchanged or a citation/tool frame can stop parsing.
      return changed ? url.toString() : text;
    } catch (_) {
      return text.replace(QUERY_SECRET, "$1[REDACTED]");
    }
  };`);
replace("tests/production-overhaul.test.js",
  `    assert.deepEqual(rounds.map(r => r.prompt), [mode + " prompt 1", mode + " prompt 2"]);`,
  `    assert.equal(JSON.stringify(rounds.map(r => r.prompt)), JSON.stringify([mode + " prompt 1", mode + " prompt 2"]));`);
console.log("Applied validation fixes.");
