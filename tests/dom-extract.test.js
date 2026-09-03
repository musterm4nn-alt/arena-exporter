/* Regression test for DOM tool-detail capture — runs in plain Node (no deps).
 * Usage: node tests/dom-extract.test.js */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ctx = vm.createContext({ console, Promise, setTimeout, clearTimeout, JSON, Object, Array, String });
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "lib", "dom-extract.js"), "utf8"), ctx);
const AE = ctx.AE;

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.error("  ✗ " + name); }
}

const lines = [
  { className: "line diff add", innerText: "<main>" },
  { className: "line diff add", innerText: "  <h1>hello</h1>" },
  { className: "line diff add", innerText: "</main>" }
];
const code = { innerText: "<main>\n  <h1>hello</h1>\n</main>", textContent: "<main>\n  <h1>hello</h1>\n</main>" };
const target = {
  hidden: false,
  innerText: code.innerText,
  textContent: code.textContent,
  getAttribute: (name) => name === "aria-hidden" ? null : null,
  querySelectorAll: (selector) => selector === "pre code" ? [code]
    : selector === "pre code .line, pre .line" ? lines : []
};
const button = {
  getAttribute: (name) => name === "aria-controls" ? "detail-1" : null
};
ctx.document = { getElementById: (id) => id === "detail-1" ? target : null };

console.log("Expanded modern tool detail:");
const detail = AE.dom.captureModernToolDetail(button);
check("code body is captured", detail && detail.code === code.innerText);
check("line breaks and indentation survive", detail && detail.code.indexOf("\n  <h1>") !== -1);
check("diff line metadata is captured", detail && detail.diff && detail.diff.length === 3 && detail.diff[0].kind === "add");
check("detail source is explicit", detail && detail.source === "dom_expanded");

console.log("Collapsed modern tool detail:");
target.hidden = true;
check("collapsed body is not reported as content", AE.dom.captureModernToolDetail(button) === null);

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
