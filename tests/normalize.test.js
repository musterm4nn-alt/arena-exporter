/* Unit test for AE.normalizeCaptured — runs in plain Node (no deps).
 * Usage: node tests/normalize.test.js */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ctx = {};
vm.createContext(ctx);
for (const f of ["../src/lib/schema.js", "../src/lib/normalize.js", "../src/lib/dom-extract.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx);
}
const AE = ctx.AE;

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.error("  ✗ " + name); }
}
function blocksOf(data, opts) { return AE.normalizeCaptured(data, opts); }

console.log("OpenAI-style streaming chunk:");
{
  const b = blocksOf({
    choices: [{ delta: { reasoning_content: "Let me check the docs…", content: "Here is " } }]
  }, { streaming: true });
  check("thinking delta captured", b.some(x => x.type === "thinking" && x.text === "Let me check the docs…"));
  check("text delta captured", b.some(x => x.type === "text" && x.text === "Here is "));
  check("deltas marked partial", b.every(x => x.partial === true));
}

console.log("Anthropic-style content block events:");
{
  const b = blocksOf({ type: "thinking", thinking: "Analyzing request" });
  check("thinking block", b.some(x => x.type === "thinking" && x.text === "Analyzing request"));
  const tc = blocksOf({ type: "tool_use", id: "tu_1", name: "web_search", input: { query: "arena.ai" } });
  check("tool_use → tool_call", tc.some(x => x.type === "tool_call" && x.tool_name === "web_search" && x.call_id === "tu_1"));
  const tr = blocksOf({ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "result body" }] });
  check("tool_result linked + text flattened", tr.some(x => x.type === "tool_result" && x.call_id === "tu_1" && x.output === "result body"));
}

console.log("Command tools surface as command blocks:");
{
  const b = blocksOf({ tool_calls: [{ id: "c1", function: { name: "run_command", arguments: JSON.stringify({ command: "npm install" }) } }] });
  check("tool_call emitted", b.some(x => x.type === "tool_call" && x.tool_name === "run_command"));
  check("command emitted", b.some(x => x.type === "command" && x.command === "npm install"));
}

console.log("Plain command objects:");
{
  const b = blocksOf({ command: "ls -la", stdout: "file1", stderr: "", exit_code: 0 });
  const c = b.find(x => x.type === "command");
  check("command block complete", !!c && c.exit_code === 0 && c.stdout === "file1");
}

console.log("Role messages:");
{
  const b = blocksOf({ role: "user", content: "Build me a landing page" });
  check("user message", b.some(x => x.type === "text" && x.role === "user" && x.text === "Build me a landing page"));
  const arr = blocksOf({ role: "user", content: [{ type: "text", text: "part1" }, { type: "text", text: "part2" }] });
  check("array content flattened", arr.some(x => x.text === "part1\npart2"));
}

console.log("Action-flavored tools:");
{
  const b = blocksOf({ type: "tool_use", id: "t2", name: "create_file", input: { path: "index.html", content: "<html/>" } });
  check("action block emitted", b.some(x => x.type === "action" && x.action === "create_file" && x.target === "index.html"));
}

console.log("Noise resistance:");
{
  const b = blocksOf({ status: "ok", meta: { requestId: "abc" }, counts: [1, 2, 3] });
  check("irrelevant payload yields no blocks", b.length === 0);
  const deep = blocksOf({ a: { b: { c: { d: { thinking: "nested thought" } } } } });
  check("deep scan finds nested thinking", deep.some(x => x.type === "thinking"));
}

console.log("Workspace manifest artifacts:");
{
  const b = AE.extractWorkspaceArtifacts({
    manifest: { files: [
      { path: "src/app.js", size: 512, mimeType: "application/javascript" },
      { fileName: "notes.txt", size: 10 },
      { name: "logo.png", size: 2048, contentType: "image/png" },
      { name: "chat-room", type: "session" } // no size/mime → not file-ish
    ] }
  });
  check("path-based file detected", b.some(x => x.title === "src/app.js" && x.artifact_type === "application/javascript"));
  check("fileName-based file detected", b.some(x => x.title === "notes.txt"));
  check("name+mime file detected", b.some(x => x.title === "logo.png" && x.artifact_type === "image/png"));
  check("non-file object rejected", !b.some(x => x.title === "chat-room"));
}

console.log("UIMessage protocol (arena.ai realtime):");
{
  const user = AE.normalizeUIMessage({
    kind: "message",
    payload: { message: { id: "m1", role: "user", parts: [{ type: "text", text: "make something cool" }] }, chatId: "c1" }
  });
  check("user envelope detected", !!user && user.messageId === "m1" && user.role === "user");
  check("user text block", user.blocks.length === 1 && user.blocks[0].type === "text" && user.blocks[0].text === "make something cool");

  const asst = AE.normalizeUIMessage({
    kind: "message",
    payload: { message: { id: "m2", role: "assistant", parts: [
      { type: "step-start" },
      { type: "reasoning", text: "I will create an interactive page" },
      { type: "tool-write", state: "output-available", toolCallId: "tc1", input: { file: "cool.html", content: "<html/>" }, output: { ok: true } },
      { type: "text", text: "Made you something cool." }
    ] } }
  });
  check("assistant envelope detected", !!asst && asst.messageId === "m2" && asst.role === "assistant");
  check("reasoning part → thinking", asst.blocks.some(b => b.type === "thinking" && b.text === "I will create an interactive page"));
  check("tool part → call + result pair", asst.blocks.some(b => b.type === "tool_call" && b.tool_name === "write" && b.call_id === "tc1" && b.arguments.file === "cool.html") &&
                                           asst.blocks.some(b => b.type === "tool_result" && b.call_id === "tc1" && b.status === "success"));
  check("text part → final text", asst.blocks.some(b => b.type === "text" && b.text === "Made you something cool."));
  check("step-start skipped", !asst.blocks.some(b => b.type === "step-start"));

  const pending = AE.normalizeUIMessage({ payload: { message: { id: "m3", role: "assistant", parts: [{ type: "tool-read", state: "input-available", toolCallId: "tc2", input: { file: "a.txt" } }] } } });
  check("input-available → pending call", pending.blocks.some(b => b.type === "tool_call" && b.status === "pending"));

  check("non-UIMessage returns null", AE.normalizeUIMessage({ status: "ok" }) === null);
}

console.log("Battle vote normalization:");
{
  const norm = AE.dom.normalizeVoteChoice;
  check("A label", norm("A is better") === "A");
  check("B label", norm("B is better") === "B");
  check("both-good label", norm("Both are good") === "both_good");
  check("neither label", norm("Neither") === "neither_good");
  check("data-style both value", norm("both_good") === "both_good");
}

console.log("Battle (evaluation) stream parser:");
{
  const body = '{"id":"ev1","mode":"battle","userMessageId":"u1","modelAMessageId":"ma","modelBMessageId":"mb","userMessage":{"content":"say hi"}}' +
    'a0:"Hello "b0:"Hi "a0:"world"b0:"there"a2:[{"type":"heartbeat"}]ad:{"finishReason":"stop"}bd:{"finishReason":"stop"}';
  const r = AE.parseBattleStream(body);
  check("init parsed", !!r.init && r.init.id === "ev1" && r.init.mode === "battle");
  check("prompt extracted", r.prompt === "say hi");
  check("lane A text merged", r.lanes.a && r.lanes.a.text === "Hello world");
  check("lane B text merged", r.lanes.b && r.lanes.b.text === "Hi there");
  check("lanes finished", r.lanes.a.finished === true && r.lanes.b.finished === true);
  check("empty input safe", AE.parseBattleStream("").lanes && Object.keys(AE.parseBattleStream("").lanes).length === 0);
  const spaced = AE.parseBattleStream("\n  " + body);
  check("leading whitespace tolerated", spaced.init && spaced.init.id === "ev1" && spaced.lanes.a.text === "Hello world");
}

console.log("Battle web-search citations:");
{
  const body = '{"id":"ev2","mode":"battle","userMessage":{"content":"what is x"}}' +
    'a0:"X is "' +
    'ac:{"toolCallId":"citation-source","argsTextDelta":"{\\"source\\":{\\"url\\":\\"https://a.com/x\\",\\"id\\":\\"1\\"}}"}' +
    'ac:{"toolCallId":"citation-source","argsTextDelta":"{\\"source\\":{\\"url\\":\\"https://b.com/y\\",\\"title\\":\\"B\\"}}"}' +
    'b0:"y"ad:{"finishReason":"stop"}bd:{"finishReason":"stop"}';
  const r = AE.parseBattleStream(body);
  check("lane A citations extracted", r.lanes.a.citations.length === 2 && r.lanes.a.citations[0].url === "https://a.com/x");
  check("citation title captured", r.lanes.a.citations[1].title === "B");
  check("lane B no citations", r.lanes.b.citations.length === 0);
}

console.log("Battle code tools:");
{
  const body = '{"id":"ev3","mode":"battle","userMessage":{"content":"make a game"}}' +
    'b9:{"toolCallId":"t1","toolName":"write_file","args":{"file":"game.js"}}' +
    'ba:{"toolCallId":"t1","result":{"status":"success","message":"Created game.js."}}' +
    'b9:{"toolCallId":"t2","toolName":"web_search","args":{"query":"pi"}}' +
    'ba:{"toolCallId":"t2","result":{"status":"success","results":[{"url":"https://pi.com/","title":"Pi"}]}}' +
    'b0:"done"bd:{"finishReason":"stop"}';
  const r = AE.parseBattleStream(body);
  check("code flag from file tool", r.lanes.b.code === true);
  check("tool names captured", r.lanes.b.toolNames.includes("write_file") && r.lanes.b.toolNames.includes("web_search"));
  check("web_search results become sources", r.lanes.b.citations.some(c => c.url === "https://pi.com/"));
  check("lane A empty", !r.lanes.a || (r.lanes.a.tools || []).length === 0);
}

console.log("Placeholder model names:");
{
  check("Response A is placeholder", AE.isPlaceholderModel("Response A") === true);
  check("qwen is not placeholder", AE.isPlaceholderModel("qwen3.5-397b-a17b") === false);
}

console.log("Eval request summarization strips captcha:");
{
  const raw = JSON.stringify({
    id: "ev", mode: "battle", modality: "webdev",
    userMessage: { content: "hello" },
    recaptchaV3Token: "SECRET-TOKEN-VALUE"
  });
  const summed = AE.summarizeEvalRequest(raw);
  check("keeps prompt", summed.indexOf("hello") !== -1);
  check("drops recaptcha", summed.indexOf("SECRET-TOKEN-VALUE") === -1 && summed.indexOf("recaptcha") === -1);
  const scrubbed = AE.scrubSecrets({ recaptchaV3Token: "X", userMessage: { content: "z" } });
  check("scrub deletes recaptcha key", scrubbed.recaptchaV3Token == null && scrubbed.userMessage.content === "z");
}

console.log("CSS in file contents is not a battle row:");
{
  const body = 'a0:"hi"a9:{"toolCallId":"t","toolName":"create_file","args":{"path":"src/index.css","content":"body { background: red; border: 1px solid; }"}}ad:{"finishReason":"stop"}';
  const r = AE.parseBattleStream(body);
  check("lane A text intact", r.lanes.a.text === "hi");
  check("no bogus background lane codes", !r.lanes.a.tools.some(t => t.toolName === "red"));
  check("create_file recorded", r.lanes.a.files.some(f => f.path === "src/index.css"));
}

console.log("Init applied from request body onto heartbeat-prefixed stream:");
{
  const stream = fs.readFileSync(path.join(__dirname, "fixtures/eval-webdev.stream.txt"), "utf8");
  const init = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/eval-webdev-init.json"), "utf8"));
  const r = AE.applyBattleInit(AE.parseBattleStream(stream), init);
  check("live stream has both lanes", r.lanes.a && r.lanes.b && r.lanes.a.text.length > 100 && r.lanes.b.text.length > 100);
  check("live stream finished", r.lanes.a.finished && r.lanes.b.finished);
  check("prompt from request init", r.prompt.indexOf("liquid glass") !== -1);
  check("evaluation id from init", r.init && r.init.id === "01a01b66-19b7-73eb-9e12-d9627e3eee14");
  check("webdev modality", r.modality === "webdev");
  check("lane files from tools", (r.lanes.a.files || []).length + (r.lanes.b.files || []).length > 0);
  check("workspace template files", (r.workspaceFiles || []).some(f => f.path === "package.json"));
}

console.log("Ballot click path:");
{
  function el(tag, attrs, text, parent) {
    const n = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      textContent: text || "",
      parentElement: parent || null,
      className: attrs.class || "",
      id: attrs.id || "",
      value: "",
      getAttribute(k) { return attrs[k] != null ? attrs[k] : null; },
      hasAttribute(k) { return attrs[k] != null; }
    };
    return n;
  }
  const btnA = el("button", {}, "A is better");
  const btnB = el("button", {}, "B is better");
  const lane = el("span", {}, "A");
  const shortBtn = el("button", {}, "A");
  check("A is better button counts", AE.dom.voteFromPath([btnA]).choice === "A");
  check("B is better button counts", AE.dom.voteFromPath([btnB]).choice === "B");
  check("lane label span does not count", AE.dom.voteFromPath([lane]) == null);
  check("bare A button without ballot subtree does not count", AE.dom.voteFromPath([shortBtn]) == null);
  const both = el("button", {}, "Both are good");
  check("both are good button counts", AE.dom.voteFromPath([both]).choice === "both_good");
}

console.log("Attachment plumbing (ported):\n");
{
  const payload = { messages: [ { role: "assistant", content: [
    { type: "artifact", title: "cool file", content_or_url: "https://x/cool.html" },
    { type: "artifact", title: "inline", content_or_url: "<html><body>hi</body></html>" }
  ] } ] };
  const results = [ { url: "https://x/cool.html", ok: true, bytes: 10, contentType: "text/html" } ];
  const att = AE.decorateAttachments(payload, results, "att/");
  check("fetched attachment decorated", att.saved.length === 1 && payload.messages[0].content[0].attachment && payload.messages[0].content[0].attachment.path.indexOf("att/") === 0);
  check("provenance url kept", payload.messages[0].content[0].content_or_url === "https://x/cool.html");
  const inline = AE.decorateInlineArtifacts(payload, "att/");
  check("inline artifact saved as data url", inline.saved.length === 1 && inline.saved[0].dataUrl.indexOf("data:text/html") === 0);
  check("slug uniqueness", AE.attachmentSlug("a", {}) === "a" && (function(){ const u={}; const x=AE.attachmentSlug("a",u); const y=AE.attachmentSlug("a",u); return x!==y; })());
}

console.log("Debug-dump redaction keeps structure, drops content:");
{
  const secret = "The full text of my private conversation about salary negotiation";
  const extraction = {
    source: "dom",
    strategy: "arena",
    url: "https://arena.ai/c/abc",
    messages: [{
      id: "dom_msg_0",
      turn_index: 0,
      role: "user",
      content: [
        { type: "text", text: secret, format: "markdown", source: "dom" },
        { type: "tool_call", tool_name: "write_file", status: "success", summary: secret },
        { type: "artifact", artifact_type: "html", title: secret, content_or_url: secret }
      ]
    }]
  };
  const red = AE.dom.redact(extraction);
  const dumped = JSON.stringify(red);
  check("message prose removed", dumped.indexOf(secret) === -1);
  check("not even a prefix of the prose survives", dumped.indexOf(secret.slice(0, 12)) === -1);
  check("no long string survives", !Object.values(red.messages[0].content).some(b => Object.values(b).some(v => typeof v === "string" && v.length > 60)));
  check("block type preserved", red.messages[0].content[0].type === "text");
  check("role preserved", red.messages[0].role === "user");
  check("tool name preserved", red.messages[0].content[1].tool_name === "write_file");
  check("artifact type preserved", red.messages[0].content[2].artifact_type === "html");
  check("strategy preserved", red.strategy === "arena");
  check("length hint retained", /^\[text \d+ chars\]$/.test(red.messages[0].content[0].text));
  check("short structural strings untouched", red.messages[0].content[1].status === "success");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

