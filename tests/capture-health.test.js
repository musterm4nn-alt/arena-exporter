/* Capture-health canary + archive file-bytes helpers.
 * Usage: node tests/capture-health.test.js */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ctx = { console, URL, JSON, Object, Array, String, Uint8Array, TextDecoder, atob, decodeURIComponent };
vm.createContext(ctx);
for (const f of ["../src/lib/schema.js", "../src/archive-layout.js", "../src/capture-health.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx);
}
const AE = ctx.AE;

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.error("  ✗ " + name); }
}

const twoReplies = {
  url: "https://arena.ai/c/abc",
  messages: [],
  battle: {
    responses: ["Lane A reply that is not empty", "Lane B reply that is not empty"],
    lanes: [
      { response: "Lane A reply that is not empty" },
      { response: "Lane B reply that is not empty" }
    ]
  }
};

console.log("Stream-miss canary:");
{
  const miss = AE.captureHealth({
    interceptor: { evaluationStreamCount: 0, evaluationRequestCount: 0, endpoints: [], streaming: false },
    dom: twoReplies
  });
  check("DOM-two-replies + zero streams → critical", miss.critical === true &&
    miss.warnings[0] === AE.CAPTURE_HEALTH_MSG.BATTLE_NO_EVAL);

  const ok = AE.captureHealth({
    interceptor: {
      evaluationStreamCount: 1, hasUsableEvalBody: true,
      endpoints: ["https://arena.ai/nextjs-api/stream/create-evaluation"], streaming: false
    },
    dom: twoReplies
  });
  check("two replies + eval stream → clean", ok.critical === false &&
    !ok.warnings.some((w) => w === AE.CAPTURE_HEALTH_MSG.BATTLE_NO_EVAL));

  const home = AE.captureHealth({
    interceptor: { endpoints: [], streaming: false },
    dom: { url: "https://arena.ai/", messages: [], battle: { responses: [], lanes: [] } }
  });
  check("empty home → clean", home.critical === false && home.warnings.length === 0);

  const terms = AE.captureHealth({
    interceptor: { endpoints: [], streaming: false },
    dom: { termsDialog: true, messages: [], battle: twoReplies.battle }
  });
  check("terms dialog → no warning", terms.critical === false &&
    !terms.warnings.some((w) => w === AE.CAPTURE_HEALTH_MSG.BATTLE_NO_EVAL));

  const agentMiss = AE.captureHealth({
    interceptor: { agentRealtimeOutCount: 0, agentChatCount: 0, endpoints: [], streaming: false },
    dom: {
      url: "https://arena.ai/",
      messages: [{ role: "assistant", content: [{ type: "text", text: "Here is the report." }] }]
    },
    mode: "agent"
  });
  check("agent content + zero realtime → critical", agentMiss.critical === true &&
    agentMiss.warnings[0] === AE.CAPTURE_HEALTH_MSG.AGENT_NO_STREAM);

  const agentOk = AE.captureHealth({
    interceptor: {
      agentRealtimeOutCount: 1,
      endpoints: ["https://arena.ai/ai-proxy/realtime/v1/sessions/x/out"],
      streaming: false
    },
    dom: {
      url: "https://arena.ai/",
      messages: [{ role: "assistant", content: [{ type: "text", text: "Here is the report." }] }]
    }
  });
  check("agent content + realtime stream → clean", agentOk.critical === false);

  const live = AE.captureHealth({
    interceptor: {
      evaluationStreamCount: 0, endpoints: ["https://arena.ai/nextjs-api/stream/create-evaluation"],
      streaming: true
    },
    dom: twoReplies
  });
  check("live interceptor → no critical", live.critical === false);
}

console.log("File bytes + URL-only:");
{
  const payload = {
    session: { conversation_key: "c:filebytes", title: "files" },
    battles: [{
      subtype: "code",
      contestants: [
        { lane: "A", response: "a", files: [{ path: "src/App.tsx", content: "export {}" }] },
        { lane: "B", response: "b", files: [
          { path: "src/B.tsx", url: "https://preview.arena.site/B.tsx" },
          { path: "src/C.tsx", content_or_url: "https://cdn.arena.site/C.tsx" }
        ] }
      ]
    }],
    messages: []
  };
  AE.decorateArchivePaths(payload);
  const files = AE.filesToWrite(payload);
  check("filesToWrite includes string file content at contestant archive_path",
    files.some((f) => f.path === "battle-01/A/src/App.tsx" && f.content.indexOf("export") !== -1));
  check("URL-only contestant files are not written as bytes",
    !files.some((f) => /battle-01\/B\/src\/B\.tsx$/.test(f.path)));

  const urlOnly = AE.listUrlOnlyFiles(payload);
  check("two files URL-only listed", urlOnly.length === 2);
  const health = AE.captureHealth({
    interceptor: { evaluationStreamCount: 1, endpoints: ["https://arena.ai/x"], streaming: false },
    dom: twoReplies,
    urlOnlyFiles: urlOnly
  });
  check("two files URL-only → warning", health.warnings.some((w) => /2 files stored as URL only/.test(w)));
  check("URL-only warning is not a stream-miss critical", health.critical === false);

  const allBytes = {
    session: { conversation_key: "c:allbytes" },
    battles: [{ contestants: [
      { lane: "A", files: [{ path: "a.ts", content: "a" }] },
      { lane: "B", files: [{ path: "b.ts", content: "b" }] }
    ] }]
  };
  AE.decorateArchivePaths(allBytes);
  const none = AE.listUrlOnlyFiles(allBytes);
  const clean = AE.captureHealth({ urlOnlyFiles: none, dom: { messages: [] } });
  check("all have content → no file-bytes warning", none.length === 0 &&
    !clean.warnings.some((w) => /files stored as URL only/.test(w)));
}

console.log("decorate/fetch pipeline:");
{
  const payload = {
    session: { conversation_key: "c:fetch", session_id: "fetch" },
    export: { source: { url: "https://arena.ai/c/fetch", mode: "battle" } },
    battles: [{ contestants: [
      { lane: "A", files: [
        { path: "ok.txt", content_or_url: "https://arena.ai/files/ok.txt" },
        { path: "fail.txt", url: "https://arena.ai/files/fail.txt" },
        { path: "lmarena.bin", url: "https://lmarena.ai/files/x.bin" }
      ] },
      { lane: "B", files: [] }
    ] }],
    messages: []
  };
  AE.decorateArchivePaths(payload);
  const urls = AE.collectArtifactUrls(payload);
  check("collectArtifactUrls accepts lmarena.ai", urls.some((u) => /lmarena\.ai/.test(u)));
  check("collectArtifactUrls accepts arena.ai", urls.some((u) => /arena\.ai\/files\/ok/.test(u)));
  check("collectArtifactUrls rejects arena.site", !urls.some((u) => /arena\.site/.test(u)));

  const results = [
    { url: "https://arena.ai/files/ok.txt", ok: true, dataUrl: "data:text/plain,hello-bytes", bytes: 11, contentType: "text/plain" },
    { url: "https://arena.ai/files/fail.txt", ok: false, error: "HTTP 404" }
  ];
  const applied = AE.applyFetchedFiles(payload, results);
  check("successful data URL → file listed with bytes",
    payload.battles[0].contestants[0].files[0].content === "hello-bytes" && applied.applied === 1);
  check("failed fetch → json still has URL",
    payload.battles[0].contestants[0].files[1].url === "https://arena.ai/files/fail.txt" &&
    !payload.battles[0].contestants[0].files[1].content);
  const after = AE.filesToWrite(payload);
  check("fetched bytes land at contestant archive_path",
    after.some((f) => f.path === "battle-01/A/ok.txt" && f.content === "hello-bytes"));
  const stillUrl = AE.listUrlOnlyFiles(payload);
  check("failed fetch remains URL-only", stillUrl.some((f) => /fail\.txt/.test(f.path)));
}

console.log("Agent files dir:");
{
  const agent = {
    session: { conversation_key: "s:agent1", title: "agent chat" },
    battles: [],
    messages: [{
      role: "assistant",
      content: [{ type: "artifact", title: "report.md", content: "# hi", content_or_url: "# hi" }]
    }]
  };
  AE.decorateArchivePaths(agent);
  check("agent artifact archive_path under files/", agent.messages[0].content[0].archive_path === "files/report.md");
  const wr = AE.filesToWrite(agent);
  check("agent file bytes written to files/", wr.some((f) => f.path === "files/report.md" && f.content.indexOf("# hi") !== -1));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
