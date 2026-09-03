/* Archive layout + markdown tests. Usage: node tests/archive.test.js */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ctx = { console, URL };
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
check("slug contains full conversation id", /--abc12345ffff$/.test(payload.archive.rel));
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

check("safeArchivePath rejects dot-dot", AE.safeArchivePath("../etc/passwd") === null);
check("safeArchivePath rejects nested traversal", AE.safeArchivePath("battle-01/A/../../evil") === null);
check("safeArchivePath keeps lane file", AE.safeArchivePath("battle-01/A/src/App.tsx") === "battle-01/A/src/App.tsx");

const collisionA = JSON.parse(JSON.stringify(payload));
collisionA.session.conversation_key = "c:01a05e6e-983b-77ee-85cf-0eb6404eb8ad";
collisionA.session.session_id = "01a05e6e-983b-77ee-85cf-0eb6404eb8ad";
const collisionB = JSON.parse(JSON.stringify(payload));
collisionB.session.conversation_key = "c:01a05e6e-d1f2-7e76-9f89-826894685faf";
collisionB.session.session_id = "01a05e6e-d1f2-7e76-9f89-826894685faf";
const collisionRelA = AE.archiveRelFor(collisionA, null);
const collisionRelB = AE.archiveRelFor(collisionB, null);
check("same-prefix UUIDs get different folders", collisionRelA !== collisionRelB);
check("first full UUID is retained", collisionRelA.endsWith("--01a05e6e-983b-77ee-85cf-0eb6404eb8ad"));
check("second full UUID is retained", collisionRelB.endsWith("--01a05e6e-d1f2-7e76-9f89-826894685faf"));


console.log("Image battle writes binaries + markdown:");
{
  const img = {
    session: { conversation_key: "c:abc-image", session_id: "abc-image", title: "a photo" },
    export: { source: { mode: "battle", url: "https://arena.ai/image" } },
    battles: [{
      subtype: "image",
      prompt: "a photo",
      outcome: "pending",
      anonymous: true,
      contestants: [
        { lane: "A", response: "", files: [{ path: "foo.png", downloadUrl: "https://cdn.arena.ai/foo.png", content: "data:image/png;base64,aaaa" }] },
        { lane: "B", response: "", files: [{ path: "bar.png", content: "data:image/png;base64,bbbb" }] }
      ]
    }],
    messages: []
  };
  AE.decorateArchivePaths(img);
  check("rel under battle/image", img.archive.rel.indexOf("battle/image/") === 0);
  const files = AE.filesToWrite(img);
  check("writes A png", files.some(f => f.path === "battle-01/A/foo.png" && f.encoding === "dataurl"));
  check("writes B png", files.some(f => f.path === "battle-01/B/bar.png"));
  const respA = files.find(f => f.path === "battle-01/A/response.md");
  check("empty response becomes image markdown", !!(respA && respA.content.indexOf("![A](foo.png)") !== -1));
  check("cdn image is fetchable", AE.isFetchableArchiveUrl("https://cdn.arena.ai/foo.png") === true);
  check("r2 image is fetchable", AE.isFetchableArchiveUrl("https://pub-abc.r2.dev/foo.png") === true);
}


console.log("History dump image harvest:");
{
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/history-backfill.js"), "utf8"), ctx);
  const r2 = "https://messages-prod.27c852f3500f38c1e7786e2c9ff9e48f.r2.cloudflarestorage.com/uuid/ts-uuid.jpeg?X-Amz-Expires=3600";
  const rec = {
    id: "019f6608-c475-7cbe-b110-2ef67cbe7ec2",
    title: "a model",
    messages: [
      { role: "user", content: "draw a model" },
      {
        role: "assistant",
        participantPosition: "A",
        content: [
          { type: "text", text: "here" },
          { type: "image_url", image_url: { url: r2 } }
        ],
        experimental_attachments: [
          { name: "uuid/ts-uuid.jpeg", url: r2, contentType: "image/jpeg" }
        ]
      },
      {
        role: "assistant",
        participantPosition: "B",
        files: [
          { path: "abc/def/out.png", downloadUrl: "https://pub-abc.r2.dev/out.png", content: null, contentType: "image/png" }
        ]
      }
    ]
  };
  const payload = AE.historyEvaluationToPayload(rec);
  check("subtype image from files", payload.battles[0].subtype === "image");
  const fa = payload.battles[0].contestants[0].files;
  check("A basename not nested", fa.length === 1 && fa[0].path === "ts-uuid.jpeg");
  check("A downloadUrl kept", fa[0].downloadUrl.indexOf("r2.cloudflarestorage.com") !== -1);
  const fb = payload.battles[0].contestants[1].files;
  check("B basename from nested path", fb[0].path === "out.png");
  const urls = AE.collectArtifactUrls(payload);
  check("collects both r2 urls", urls.length === 2);
  check("r2.cloudflarestorage fetchable", AE.isFetchableArchiveUrl(r2) === true);

  const nested = JSON.parse(JSON.stringify(payload));
  nested.battles[0].contestants[0].files[0] = {
    path: "uuid/ts-uuid.jpeg",
    downloadUrl: r2,
    content: "data:image/jpeg;base64,aaaa",
    contentType: "image/jpeg"
  };
  AE.decorateArchivePaths(nested);
  const files = AE.filesToWrite(nested);
  check("flatten nested jpeg to lane root", files.some(f => f.path === "battle-01/A/ts-uuid.jpeg" && f.encoding === "dataurl"));
}


console.log("status LED kind:");
{
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/status-led.js"), "utf8"), ctx);
  const kind = AE.statusLedKind;
  check("off-arena idle", kind({ onArena: false, summary: { nativeSink: { state: "ok" } } }) === "idle");
  check("arena + native ok", kind({ onArena: true, summary: { nativeSink: { state: "ok" } } }) === "ok");
  check("arena + fallback warn", kind({ onArena: true, summary: { nativeSink: { state: "missing" } } }) === "warn");
  check("streaming wins", kind({ onArena: true, summary: { nativeSink: { state: "ok" }, streaming: true } }) === "stream");
  check("write fail error", kind({ onArena: true, summary: { nativeSink: { state: "ok" }, lastSync: { ok: false } } }) === "error");
  check("capture health error", kind({ onArena: true, summary: { captureHealthCritical: true, nativeSink: { state: "ok" } } }) === "error");
}


console.log("completeness scoring:");
{
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/capture-health.js"), "utf8"), ctx);
  const emptyImg = {
    session: { conversation_key: "c:img-empty", title: "a photo" },
    battles: [{
      subtype: "text",
      prompt: "a photo",
      contestants: [
        { lane: "A", response: "", files: [{ path: "foo.jpeg", downloadUrl: "https://pub-abc.r2.dev/foo.jpeg", content: null, contentType: "image/jpeg" }] },
        { lane: "B", response: "", files: [{ path: "bar.png", downloadUrl: "https://pub-abc.r2.dev/bar.png", content: null }] }
      ]
    }],
    messages: []
  };
  check("honest subtype image", AE.firstBattleSubtype(emptyImg) === "image");
  const red = AE.scoreCompleteness(emptyImg);
  check("empty image is red", red.status === "red");
  check("empty image 0 bytes reason", red.reasons.some(r => /image \/ 0 bytes/.test(r)));
  check("not a skip-empty (has prompt+urls)", AE.shouldSkipEmptyArchive(emptyImg) === false);

  const filled = JSON.parse(JSON.stringify(emptyImg));
  filled.battles[0].contestants[0].files[0].content = "data:image/jpeg;base64,aaaa";
  filled.battles[0].contestants[1].files[0].content = "data:image/png;base64,bbbb";
  filled.battles[0].contestants[0].model = "qwen-image";
  filled.battles[0].contestants[1].model = "flux";
  const green = AE.scoreCompleteness(filled);
  check("image with bytes is green", green.status === "green");
  check("files counted", green.files.withBytes === 2);

  const shell = { session: {}, battles: [], messages: [] };
  check("totally empty skipped", AE.shouldSkipEmptyArchive(shell) === true);

  AE.decorateArchivePaths(emptyImg);
  check("new image chat folders under battle/image", emptyImg.archive.rel.indexOf("battle/image/") === 0);

  const agentUrl = {
    session: { conversation_key: "c:agent-1", title: "hello" },
    battles: [],
    messages: [
      { role: "user", text: "hello", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", text: "hi", content: [
        { type: "text", text: "hi" },
        { type: "artifact", title: "out.py", content_or_url: "https://arena.ai/api/chat/x/file" }
      ] }
    ]
  };
  const amber = AE.scoreCompleteness(agentUrl);
  check("agent url-only is amber", amber.status === "amber");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
