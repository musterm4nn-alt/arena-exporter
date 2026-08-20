/* Archive layout + markdown tests. Usage: node tests/archive.test.js */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ctx = { console };
vm.createContext(ctx);
for (const f of ["../src/lib/schema.js", "../src/archive-layout.js", "../src/markdown.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx);
}
const AE = ctx.AE;
let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.error("  ✗ " + name); }
}

const payload = {
  session: { conversation_key: "c:abc12345ffff", session_id: "abc12345ffff", title: "Liquid glass LLM dashboard" },
  export: { source: { mode: "battle", url: "https://arena.ai/c/abc" } },
  battles: [{
    subtype: "code",
    prompt: "create a dashboard",
    outcome: "pending",
    anonymous: true,
    contestants: [
      { lane: "A", response: "alpha", files: [{ path: "src/App.tsx", content: "export {}" }] },
      { lane: "B", response: "beta", files: [] }
    ]
  }],
  messages: []
};

AE.decorateArchivePaths(payload);
check("rel under battle/code", payload.archive.rel.indexOf("battle/code/") === 0);
check("slug contains short id", /--abc12345/.test(payload.archive.rel));
check("A dir", payload.battles[0].contestants[0].dir === "battle-01/A");
check("file archive path", payload.battles[0].contestants[0].files[0].archive_path === "battle-01/A/src/App.tsx");
check("locked rel reused", AE.archiveRelFor(payload, "battle/text/keep") === "battle/text/keep");

const files = AE.filesToWrite(payload);
check("writes conversation.json", files.some(f => f.path === "conversation.json"));
check("writes conversation.md", files.some(f => f.path === "conversation.md"));
check("writes response.md", files.some(f => f.path === "battle-01/A/response.md"));
check("writes generated file", files.some(f => f.path === "battle-01/A/src/App.tsx" && f.content.indexOf("export") !== -1));

const md = AE.renderMarkdown(payload);
check("markdown has prompt", md.indexOf("create a dashboard") !== -1);
check("markdown has lanes", md.indexOf("### A") !== -1 && md.indexOf("### B") !== -1);
check("markdown links file", md.indexOf("battle-01/A/src/App.tsx") !== -1);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
