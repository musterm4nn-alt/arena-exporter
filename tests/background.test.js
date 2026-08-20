/* Integration smoke test for the service worker: event ingestion →
 * session assembly → export building. Runs in plain Node with chrome stubs.
 * Usage: node tests/background.test.js */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "src");

/* ---- chrome / worker stubs ---- */
let messageListener = null;
const ctx = vm.createContext({
  console,
  setTimeout, clearTimeout,
  JSON, Math, Date, Object, Array, String, Number, Set, Promise,
  importScripts: (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx);
  },
  chrome: {
    storage: { session: { get: async () => ({}), set: async () => {} } },
    runtime: {
      onMessage: { addListener: (fn) => { messageListener = fn; } },
      lastError: null
    }
  }
});
vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), ctx);

function send(msg, sender) {
  return new Promise((resolve) => {
    const ret = messageListener(msg, sender || {}, resolve);
    if (ret === undefined) resolve(null); // sync sendResponse already called
  });
}

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.error("  ✗ " + name); }
}

(async () => {
  console.log("Session hint from realtime endpoint:");
  await send({ type: "AE_EVENT", evt: { kind: "session_hint", sessionId: "01a01965-4753-71e9-bd7d-7203b2bf4a1e", url: "https://arena.ai/ai-proxy/realtime/v1/sessions/01a01965-4753-71e9-bd7d-7203b2bf4a1e/out" } });

  console.log("Ingest a user prompt (JSON envelope):");
  await send({ type: "AE_EVENT", evt: { kind: "json", url: "https://arena.ai/api/agent/chat", data: { role: "user", content: "Research X and write a report" } } });

  console.log("Ingest streamed assistant turn (SSE deltas):");
  await send({ type: "AE_EVENT", evt: { kind: "sse", url: "https://arena.ai/api/agent/stream", event: "delta", data: { reasoning_content: "I should " } } });
  await send({ type: "AE_EVENT", evt: { kind: "sse", url: "https://arena.ai/api/agent/stream", event: "delta", data: { reasoning_content: "search first." } } });
  await send({ type: "AE_EVENT", evt: { kind: "sse", url: "https://arena.ai/api/agent/stream", event: "delta", data: { tool_calls: [{ id: "call_9", function: { name: "web_search", arguments: JSON.stringify({ query: "X overview" }) } }] } } });
  await send({ type: "AE_EVENT", evt: { kind: "sse", url: "https://arena.ai/api/agent/stream", event: "delta", data: { type: "tool_result", tool_use_id: "call_9", content: [{ type: "text", text: "search results…" }] } } });
  await send({ type: "AE_EVENT", evt: { kind: "sse", url: "https://arena.ai/api/agent/stream", event: "delta", data: { content: "Here is the report." } } });

  console.log("Request body capture (/in/append user prompt):");
  await send({ type: "AE_EVENT", evt: { kind: "request", url: "https://arena.ai/ai-proxy/realtime/v1/sessions/01a01965/in/append", method: "POST", body: JSON.stringify({ role: "user", content: "from request body" }) } });

  console.log("Second turn:");
  await send({ type: "AE_EVENT", evt: { kind: "json", url: "https://arena.ai/api/agent/chat", data: { role: "user", content: "Now save it" } } });
  await send({ type: "AE_EVENT", evt: { kind: "json", url: "https://arena.ai/api/agent/chat", data: { type: "tool_use", id: "call_10", name: "create_file", input: { path: "report.md", content: "# X" } } } });

  console.log("Workspace manifest → artifacts:");
  await send({ type: "AE_EVENT", evt: { kind: "json", url: "https://arena.ai/api/chat/01a01965/workspace/latest?includeManifest=true", data: { manifest: { files: [{ path: "report.md", size: 42, mimeType: "text/markdown" }, { path: "index.html", size: 120, mimeType: "text/html" }] } } } });

  console.log("WebSocket fallback + unknown stream chunk:");
  await send({ type: "AE_EVENT", evt: { kind: "ws", url: "wss://arena.ai/realtime", text: JSON.stringify({ role: "assistant", content: "via websocket" }) } });
  await send({ type: "AE_EVENT", evt: { kind: "stream_chunk", url: "https://arena.ai/ai-proxy/realtime/v1/sessions/01a01965/out", text: "\u0000\u0001binary-framed payload" } });
  await send({ type: "AE_EVENT", evt: { kind: "sse_raw", url: "https://arena.ai/ai-proxy/realtime/v1/sessions/01a01965/out", text: "data: not-json-here" } });

  console.log("UIMessage snapshot semantics (growing /out snapshots):");
  await send({ type: "AE_EVENT", evt: { kind: "request", url: "https://arena.ai/ai-proxy/realtime/v1/sessions/01a01965/in/append", method: "POST", body: JSON.stringify({ kind: "message", payload: { message: { id: "ui-user-1", role: "user", parts: [{ type: "text", text: "hello agent" }] } } }) } });
  await send({ type: "AE_EVENT", evt: { kind: "sse", url: "https://arena.ai/ai-proxy/realtime/v1/sessions/01a01965/out", event: "message", data: { kind: "message", payload: { message: { id: "ui-user-1", role: "user", parts: [{ type: "text", text: "hello agent" }] } } } } }); // echo
  await send({ type: "AE_EVENT", evt: { kind: "sse", url: "https://arena.ai/ai-proxy/realtime/v1/sessions/01a01965/out", event: "message", data: { kind: "message", payload: { message: { id: "ui-asst-1", role: "assistant", parts: [{ type: "reasoning", text: "thinking…" }] } } } } });
  await send({ type: "AE_EVENT", evt: { kind: "sse", url: "https://arena.ai/ai-proxy/realtime/v1/sessions/01a01965/out", event: "message", data: { kind: "message", payload: { message: { id: "ui-asst-1", role: "assistant", parts: [{ type: "reasoning", text: "thinking… done." }, { type: "text", text: "snapshot answer" }] } } } } }); // grown snapshot

  console.log("Realtime records envelope + data-stream chunks:");
  await send({ type: "AE_EVENT", evt: { kind: "request", url: "https://arena.ai/ai-proxy/realtime/v1/sessions/01a01965/in/append", method: "POST", body: JSON.stringify({ kind: "message", payload: { message: { id: "ui-user-2", role: "user", parts: [{ type: "text", text: "now stream one" }] } } }) } });
  const rec = (body) => ({ kind: "sse", url: "https://arena.ai/ai-proxy/realtime/v1/sessions/01a01965/out", event: "message", data: { records: [{ seq_num: 1, timestamp: Date.now(), body: JSON.stringify({ data: body, id: "x" }) }], tail: { seq_num: 2 } } });
  await send({ type: "AE_EVENT", evt: { kind: "sse", url: "https://arena.ai/ai-proxy/realtime/v1/sessions/01a01965/out", event: "message", data: { timestamp: Date.now(), tail: { seq_num: 1 } } } }); // keepalive
  await send({ type: "AE_EVENT", evt: { kind: "sse", url: "https://arena.ai/ai-proxy/realtime/v1/sessions/01a01965/out", event: "message", data: { records: [{ seq_num: 0, timestamp: Date.now(), headers: [["", "trim"]], body: "\u0000\u0000binary" }] } } }); // binary record
  await send({ type: "AE_EVENT", evt: rec({ type: "start", messageId: "rec-asst-1" }) });
  await send({ type: "AE_EVENT", evt: rec({ type: "start-step" }) });
  await send({ type: "AE_EVENT", evt: rec({ type: "reasoning-start", id: "rs_1" }) });
  await send({ type: "AE_EVENT", evt: rec({ type: "reasoning-delta", id: "rs_1", delta: "Let me " }) });
  await send({ type: "AE_EVENT", evt: rec({ type: "reasoning-delta", id: "rs_1", delta: "build it." }) });
  await send({ type: "AE_EVENT", evt: rec({ type: "reasoning-end", id: "rs_1" }) });
  await send({ type: "AE_EVENT", evt: rec({ type: "tool-input-start", toolCallId: "call_A", toolName: "write" }) });
  await send({ type: "AE_EVENT", evt: rec({ type: "tool-input-delta", toolCallId: "call_A", inputTextDelta: "{\"file\":" }) });
  await send({ type: "AE_EVENT", evt: rec({ type: "tool-input-delta", toolCallId: "call_A", inputTextDelta: "\"a.html\"}" }) });
  await send({ type: "AE_EVENT", evt: rec({ type: "tool-output-available", toolCallId: "call_A", output: { ok: true } }) });
  await send({ type: "AE_EVENT", evt: rec({ type: "text-start", id: "txt_1" }) });
  await send({ type: "AE_EVENT", evt: rec({ type: "text-delta", id: "txt_1", delta: "Done — " }) });
  await send({ type: "AE_EVENT", evt: rec({ type: "text-delta", id: "txt_1", delta: "streamed." }) });
  await send({ type: "AE_EVENT", evt: rec({ type: "finish-step" }) });
  await send({ type: "AE_EVENT", evt: rec({ type: "finish" }) });

  console.log("Battle (evaluation) stream capture:");
  await send({ type: "AE_EVENT", evt: { kind: "stream_chunk", url: "https://arena.ai/nextjs-api/stream/create-evaluation", text: '{"id":"evX","mode":"battle","modelAMessageId":"ma","modelBMessageId":"mb","userMessage":{"content":"pick a color"}}a0:"Red "b0:"Blue "ac:{"toolCallId":"citation-source","argsTextDelta":"{\\"source\\":{\\"url\\":\\"https://s.com/1\\"}}"}ad:{"finishReason":"stop"}bd:{"finishReason":"stop"}' } });

  console.log("Full-history export:");
  const full = await send({ type: "AE_EXPORT", mode: "full_history", snapshot: null });
  const fp = JSON.parse(full.json);
  check("schema_version present", fp.schema_version === "2.0");
  check("real session UUID recorded", fp.session.session_id === "01a01965-4753-71e9-bd7d-7203b2bf4a1e");
  check("filename carries session id prefix", /_01a01965_/.test(full.filename));
  check("filename pattern", /^arena_battle_full_history_[A-Za-z0-9]+_\d{8}-\d{6}\.json$/.test(full.filename));
  check("workspace files became artifacts", fp.messages.some(m => m.content.some(b => b.type === "artifact" && b.title === "report.md" && b.artifact_type === "text/markdown")));
  check("websocket assistant text captured", fp.messages.some(m => m.content.some(b => b.type === "text" && b.text === "via websocket")));
  check("raw stream chunk sampled in meta", fp.meta.stream_samples.some(s => s.sample.indexOf("binary-framed") !== -1));
  check("sse_raw frame sampled in meta", fp.meta.stream_samples.some(s => s.sample.indexOf("not-json-here") !== -1));
  check("user prompt recovered from request body", fp.messages.some(m => m.role === "user" && m.content.some(b => b.text === "from request body")));
  check("meta stats present", fp.meta.stats.events_seen > 0 && fp.meta.stats.unknown_events >= 1);
  const helloMsgs = fp.messages.filter(m => m.role === "user" && m.content.some(b => b.text === "hello agent"));
  check("UIMessage echo deduped by id", helloMsgs.length === 1);
  const snapMsgs = fp.messages.filter(m => m.content.some(b => b.type === "thinking" && b.text.indexOf("thinking") === 0));
  check("growing snapshot replaced, not duplicated", snapMsgs.length === 1);
  check("final snapshot content wins", snapMsgs[0].content.some(b => b.type === "thinking" && b.text === "thinking… done.") && snapMsgs[0].content.some(b => b.type === "text" && b.text === "snapshot answer"));
  const recMsgs = fp.messages.filter(m => m.content.some(b => b.type === "thinking" && b.text === "Let me build it."));
  check("records envelope assembled into one message", recMsgs.length === 1);
  const recMsg = recMsgs[0];
  check("reasoning deltas merged", recMsg.content.some(b => b.type === "thinking" && b.text === "Let me build it."));
  const recTool = recMsg.content.find(b => b.type === "tool_call" && b.call_id === "call_A");
  check("tool input deltas reassembled into args", !!recTool && recTool.tool_name === "write" && recTool.arguments && recTool.arguments.file === "a.html");
  check("tool output linked", recMsg.content.some(b => b.type === "tool_result" && b.call_id === "call_A" && b.status === "success"));
  check("text deltas merged", recMsg.content.some(b => b.type === "text" && b.text === "Done — streamed."));
  const firstAssistant = fp.messages[1];
  const thinking = firstAssistant.content.find(b => b.type === "thinking");
  check("thinking deltas merged", thinking && thinking.text === "I should search first.");
  check("tool_call captured", firstAssistant.content.some(b => b.type === "tool_call" && b.tool_name === "web_search"));
  check("tool_result linked to call_id", firstAssistant.content.some(b => b.type === "tool_result" && b.call_id === "call_9"));
  check("tool_call status updated by result", firstAssistant.content.find(b => b.type === "tool_call").status === "success");
  check("final text block present", firstAssistant.content.some(b => b.type === "text" && b.text === "Here is the report."));
  check("summary rollup", fp.summary.tools_used.includes("web_search"));
  check("action rollup from create_file", fp.summary.actions_performed >= 1);
  check("turn_count = user messages", fp.session.turn_count === 5);
  check("completeness full", fp.meta.completeness === "full");
  check("battle reconstructed from evaluation stream", fp.battles.length === 1);
  check("battle prompt", fp.battles[0].prompt === "pick a color");
  check("battle contestants A/B text", fp.battles[0].contestants[0].response === "Red " && fp.battles[0].contestants[1].response === "Blue ");
  check("battle anonymous without DOM names", fp.battles[0].anonymous === true && fp.battles[0].contestants.every(c => c.model === null));
  check("battle subtype web-search via citations", fp.battles[0].subtype === "web-search");
  check("battle sources captured", fp.battles[0].contestants[0].sources.length === 1 && fp.battles[0].contestants[0].sources[0].url === "https://s.com/1");
  check("export source mode = battle", fp.export.source.mode === "battle");
  check("attribution samples present", Array.isArray(fp.attribution_samples) && fp.attribution_samples.length >= 2);
  const laneA = fp.attribution_samples.find(x => x.lane === "A");
  const laneB = fp.attribution_samples.find(x => x.lane === "B");
  check("battle samples split by lane", !!laneA && !!laneB && laneA.sample_id !== laneB.sample_id);
  check("lane A sample has no opponent text", !JSON.stringify(laneA.blocks).includes("Blue "));
  check("samples omit vote/winner fields", fp.attribution_samples.every(x => x.vote == null && x.winner == null && x.outcome == null && x.vote_choice == null));
  check("unlabeled before reveal", laneA.model_labeled === false && laneA.model_source === "unknown");

  console.log("Battle attribution + winner from DOM snapshot:");
  const fullDom = await send({ type: "AE_EXPORT", mode: "full_history", snapshot: { source: "dom", messages: [], battle: { models: ["modelA-x", "modelB-y"], anonymous: false, winnerModel: "modelB-y" } } });
  const fd = JSON.parse(fullDom.json);
  check("contestants named from DOM", fd.battles[0].anonymous === false && fd.battles[0].contestants[0].model === "modelA-x" && fd.battles[0].contestants[1].model === "modelB-y");
  check("winner lane mapped from green highlight", fd.battles[0].winner === "B" && fd.battles[0].winner_model === "modelB-y");

  console.log("Pending default + manual override:");
  const tieSnap = { source: "dom", url: "https://arena.ai/c/tie", messages: [], battle: { models: ["mA", "mB"], anonymous: false, preVoteBallot: false, winnerModel: null } };
  const tieExp = await send({ type: "AE_EXPORT", mode: "full_history", snapshot: tieSnap });
  const tp = JSON.parse(tieExp.json);
  check("pending when ballot gone and no vote", tp.battles[0].outcome === "pending" && tp.battles[0].winner == null);
  await send({ type: "AE_SET_MANUAL_VOTE", choice: "A", url: "https://arena.ai/c/tie" });
  const manExp = await send({ type: "AE_EXPORT", mode: "full_history", snapshot: tieSnap });
  const mp = JSON.parse(manExp.json);
  check("manual override sets A", mp.battles[0].outcome === "a_wins" && mp.battles[0].winner === "A" && mp.battles[0].vote && mp.battles[0].vote.source === "manual");
  await send({ type: "AE_SET_MANUAL_VOTE", choice: "clear", url: "https://arena.ai/c/tie" });

  console.log("Captured ballot outcomes:");
  const namedBattleSnapshot = { source: "dom", url: "https://arena.ai/c/test", messages: [], battle: { models: ["modelA-x", "modelB-y"], anonymous: false } };
  await send({ type: "AE_EVENT", evt: { kind: "battle_vote", choice: "A is better", label: "A is better", source: "dom_click", url: namedBattleSnapshot.url, capturedAt: new Date().toISOString() } });
  let voteExport = JSON.parse((await send({ type: "AE_EXPORT", mode: "full_history", snapshot: namedBattleSnapshot })).json);
  check("A vote recorded", voteExport.battles[0].vote_choice === "A" && voteExport.battles[0].winner === "A" && voteExport.battles[0].winner_model === "modelA-x" && voteExport.battles[0].outcome === "a_wins");

  await send({ type: "AE_EVENT", evt: { kind: "battle_vote", choice: "B is better", label: "B is better", source: "dom_click", url: namedBattleSnapshot.url, capturedAt: new Date().toISOString() } });
  voteExport = JSON.parse((await send({ type: "AE_EXPORT", mode: "full_history", snapshot: namedBattleSnapshot })).json);
  check("B vote recorded", voteExport.battles[0].vote_choice === "B" && voteExport.battles[0].winner === "B" && voteExport.battles[0].winner_model === "modelB-y" && voteExport.battles[0].outcome === "b_wins");

  await send({ type: "AE_EVENT", evt: { kind: "battle_vote", choice: "Both are good", label: "Both are good", source: "dom_click", url: namedBattleSnapshot.url, capturedAt: new Date().toISOString() } });
  voteExport = JSON.parse((await send({ type: "AE_EXPORT", mode: "full_history", snapshot: namedBattleSnapshot })).json);
  check("both-good vote recorded", voteExport.battles[0].vote_choice === "both_good" && voteExport.battles[0].winner === "both" && voteExport.battles[0].winner_models.length === 2 && voteExport.battles[0].outcome === "both_good");

  await send({ type: "AE_EVENT", evt: { kind: "battle_vote", choice: "Neither", label: "Neither", source: "dom_click", url: namedBattleSnapshot.url, capturedAt: new Date().toISOString() } });
  voteExport = JSON.parse((await send({ type: "AE_EXPORT", mode: "full_history", snapshot: namedBattleSnapshot })).json);
  check("neither vote recorded", voteExport.battles[0].vote_choice === "neither_good" && voteExport.battles[0].winner === "neither" && voteExport.battles[0].winner_models.length === 0 && voteExport.battles[0].outcome === "both_bad");

  console.log("Last-message export:");
  const last = await send({ type: "AE_EXPORT", mode: "last_message", snapshot: null });
  const lp = JSON.parse(last.json);
  check("last_message = triggering user prompt + last assistant turn", lp.messages.length === 2 && lp.messages[0].role === "user" && lp.messages[1].role === "assistant");
  check("export.mode recorded", lp.export.mode === "last_message");

  console.log("DOM-only backfill:");
  await send({ type: "AE_CLEAR" });
  const dom = await send({ type: "AE_EXPORT", mode: "full_history", snapshot: { source: "dom", messages: [{ id: "dom_msg_0", role: "user", content: [{ type: "text", text: "hi" }] }] } });
  const dp = JSON.parse(dom.json);
  check("DOM messages used when network empty", dp.messages.length === 1 && dp.meta.capture_sources[0] === "dom");
  check("backfill warning recorded", dp.meta.warnings.length >= 1 && dp.meta.completeness === "partial");

  console.log("DOM backfills missed prefix around a network anchor:");
  await send({ type: "AE_CLEAR" });
  await send({ type: "AE_EVENT", evt: { kind: "json", url: "https://arena.ai/api/agent/chat", data: { role: "user", content: "known current prompt" } } });
  const mixed = await send({ type: "AE_EXPORT", mode: "full_history", snapshot: { source: "dom", messages: [
    { id: "dom_old", role: "user", content: [{ type: "text", text: "older prompt" }] },
    { id: "dom_known", role: "user", content: [{ type: "text", text: "known current prompt" }] }
  ] } });
  const mixedPayload = JSON.parse(mixed.json);
  check("older DOM message merged", mixedPayload.messages.length === 2 && mixedPayload.messages[0].content[0].text === "older prompt");
  check("mixed capture source recorded", mixedPayload.meta.capture_sources.includes("network") && mixedPayload.meta.capture_sources.includes("dom"));

  console.log("Multiple evaluation responses remain separate:");
  const evalUrl = "https://arena.ai/nextjs-api/stream/create-evaluation";
  const evalOne = '{"id":"ev-one","mode":"battle","userMessage":{"content":"first"}}a0:"one"b0:"uno"ad:{"finishReason":"stop"}bd:{"finishReason":"stop"}';
  const evalTwo = '{"id":"ev-two","mode":"battle","userMessage":{"content":"second"}}a0:"two"b0:"dos"ad:{"finishReason":"stop"}bd:{"finishReason":"stop"}';
  await send({ type: "AE_EVENT", evt: { kind: "stream_chunk", url: evalUrl, text: evalOne } });
  await send({ type: "AE_EVENT", evt: { kind: "stream_end", url: evalUrl } });
  await send({ type: "AE_EVENT", evt: { kind: "stream_chunk", url: evalUrl, text: evalTwo } });
  const segmented = JSON.parse((await send({ type: "AE_EXPORT", mode: "full_history", snapshot: { url: "https://arena.ai/c/multi", messages: [], battle: { models: ["new-A", "new-B"], anonymous: false } } })).json);
  check("two evaluation streams exported separately", segmented.battles.length === 2 && segmented.battles[0].evaluation_id === "ev-one" && segmented.battles[1].evaluation_id === "ev-two");
  check("latest-only model attribution avoids mislabeling old battle", segmented.battles[0].anonymous === true && segmented.battles[0].contestants.every(c => c.model === null) && segmented.battles[1].contestants[0].model === "new-A" && segmented.battles[1].contestants[1].model === "new-B");

  console.log("DOM-only battle (reloaded after vote, no stream):");
  await send({ type: "AE_CLEAR" });
  const domOnly = JSON.parse((await send({ type: "AE_EXPORT", mode: "full_history", snapshot: { url: "https://arena.ai/c/old", messages: [], battle: { models: ["old-A", "old-B"], anonymous: false, preVoteBallot: false, winnerModel: "old-B" } } })).json);
  check("dom-only battle built from headers", domOnly.battles.length === 1 && domOnly.battles[0].dom_only === true && domOnly.battles[0].contestants[0].model === "old-A");
  check("dom-only winner from green pane", domOnly.battles[0].winner === "B" && domOnly.battles[0].winner_model === "old-B" && domOnly.battles[0].winner_source === "dom_green");

  console.log("Empty UIMessage snapshot does not wipe existing content:");
  await send({ type: "AE_CLEAR" });
  await send({ type: "AE_EVENT", evt: { kind: "sse", url: "https://arena.ai/out", event: "message", data: { kind: "message", payload: { message: { id: "keep-1", role: "assistant", parts: [{ type: "text", text: "keep me" }] } } } } });
  await send({ type: "AE_EVENT", evt: { kind: "sse", url: "https://arena.ai/out", event: "message", data: { kind: "message", payload: { message: { id: "keep-1", role: "assistant", parts: [{ type: "step-start" }] } } } } });
  const kept = JSON.parse((await send({ type: "AE_EXPORT", mode: "full_history", snapshot: null })).json);
  check("empty snapshot left prior text", kept.messages.some(m => m.content.some(b => b.type === "text" && b.text === "keep me")));

  console.log("Session isolation across tabs:");
  await send({ type: "AE_CLEAR" });
  const tabA = { tab: { id: 11, url: "https://arena.ai/c/aaa" } };
  const tabB = { tab: { id: 22, url: "https://arena.ai/c/bbb" } };
  await send({ type: "AE_EVENT", evt: { kind: "page_context", url: "https://arena.ai/c/aaa", conversationKey: "c:aaa", title: "Chat A" } }, tabA);
  await send({ type: "AE_EVENT", evt: { kind: "json", url: "https://arena.ai/api/x", data: { role: "user", content: "prompt-aaa" } } }, tabA);
  await send({ type: "AE_EVENT", evt: { kind: "page_context", url: "https://arena.ai/c/bbb", conversationKey: "c:bbb", title: "Chat B" } }, tabB);
  await send({ type: "AE_EVENT", evt: { kind: "json", url: "https://arena.ai/api/y", data: { role: "user", content: "prompt-bbb" } } }, tabB);
  const expA = JSON.parse((await send({ type: "AE_EXPORT", sessionKey: "c:aaa", mode: "full_history", snapshot: null })).json);
  const expB = JSON.parse((await send({ type: "AE_EXPORT", sessionKey: "c:bbb", mode: "full_history", snapshot: null })).json);
  check("tab A only has its prompt", expA.messages.some(m => m.content.some(b => b.text === "prompt-aaa")) && !expA.messages.some(m => m.content.some(b => b.text === "prompt-bbb")));
  check("tab B only has its prompt", expB.messages.some(m => m.content.some(b => b.text === "prompt-bbb")) && !expB.messages.some(m => m.content.some(b => b.text === "prompt-aaa")));

  console.log("Labeled sample after model reveal does not leak vote:");
  await send({ type: "AE_CLEAR" });
  await send({ type: "AE_EVENT", evt: { kind: "stream_chunk", url: "https://arena.ai/nextjs-api/stream/create-evaluation", text: '{"id":"evL","mode":"battle","userMessage":{"content":"hi"}}a0:"left"b0:"right"ad:{"finishReason":"stop"}bd:{"finishReason":"stop"}' } });
  await send({ type: "AE_EVENT", evt: { kind: "battle_vote", choice: "A is better", label: "A is better", source: "dom_click", url: "https://arena.ai/c/lab", capturedAt: new Date().toISOString() } });
  const labeled = JSON.parse((await send({ type: "AE_EXPORT", mode: "full_history", snapshot: { source: "dom", url: "https://arena.ai/c/lab", messages: [], battle: { models: ["model-left", "model-right"], anonymous: false } } })).json);
  const labeledA = labeled.attribution_samples.find(x => x.lane === "A");
  check("reveal labels model on same sample id", labeledA && labeledA.model === "model-left" && labeledA.model_labeled === true && labeledA.model_source === "arena_reveal");
  check("labeled sample has no vote field", labeledA && labeledA.vote == null && JSON.stringify(labeledA).indexOf("a_wins") === -1);

  console.log("Live webdev dump replay:");
  await send({ type: "AE_CLEAR" });
  const initPath = path.join(__dirname, "fixtures/eval-webdev-init.json");
  const streamPath = path.join(__dirname, "fixtures/eval-webdev.stream.txt");
  const initJson = fs.readFileSync(initPath, "utf8");
  const liveStream = fs.readFileSync(streamPath, "utf8");
  await send({ type: "AE_EVENT", evt: { kind: "request", url: "https://arena.ai/nextjs-api/stream/create-evaluation", method: "POST", body: JSON.stringify(Object.assign(JSON.parse(initJson), { recaptchaV3Token: "SECRET-SHOULD-NOT-LEAK" })) } });
  await send({ type: "AE_EVENT", evt: { kind: "stream_chunk", url: "https://arena.ai/nextjs-api/stream/create-evaluation", text: liveStream } });
  await send({ type: "AE_EVENT", evt: { kind: "stream_end", url: "https://arena.ai/nextjs-api/stream/create-evaluation" } });
  const idleSnap = { source: "dom", url: "https://arena.ai/c/01a01b66-19b7-73eb-9e12-d9627e3eee14", messages: [], battle: { models: ["Response A", "Response B"], anonymous: false, ballotVisible: true, vote: { choice: "both_good", label: "A is better A is better", source: "dom_selection" }, preVoteBallot: true } };
  const livePre = JSON.parse((await send({ type: "AE_EXPORT", mode: "full_history", snapshot: idleSnap })).json);
  check("live prompt recovered", livePre.battles[0] && livePre.battles[0].prompt && livePre.battles[0].prompt.indexOf("liquid glass") !== -1);
  check("live eval id recovered", livePre.battles[0].evaluation_id === "01a01b66-19b7-73eb-9e12-d9627e3eee14");
  check("idle ballot does not become both_good", livePre.battles[0].outcome === "pending");
  check("placeholder names are anonymous", livePre.battles[0].anonymous === true && livePre.battles[0].contestants.every(c => c.model == null));
  check("live samples unlabeled", livePre.attribution_samples.every(s => s.lane && s.model_labeled === false));
  check("recaptcha not in export", JSON.stringify(livePre).indexOf("SECRET-SHOULD-NOT-LEAK") === -1 && JSON.stringify(livePre).toLowerCase().indexOf("recaptcha") === -1);
  check("no empty-conversation warning on battle export", !(livePre.meta.warnings || []).some(w => /No conversation data/.test(w)));
  check("live files captured", livePre.battles[0].contestants.some(c => (c.files || []).length > 0));
  const revealSnap = { source: "dom", url: "https://arena.ai/c/01a01b66-19b7-73eb-9e12-d9627e3eee14", messages: [], battle: { models: ["qwen3.5-397b-a17b", "claude-opus-4-8"], anonymous: false, ballotVisible: false } };
  await send({ type: "AE_EVENT", evt: { kind: "battle_vote", choice: "A is better", label: "A is better", source: "dom_click", url: revealSnap.url, capturedAt: new Date().toISOString() } });
  const livePost = JSON.parse((await send({ type: "AE_EXPORT", mode: "full_history", snapshot: revealSnap })).json);
  check("click records A win", livePost.battles[0].outcome === "a_wins" && livePost.battles[0].winner === "A");
  check("revealed models labeled", livePost.attribution_samples.find(s => s.lane === "A").model === "qwen3.5-397b-a17b" && livePost.attribution_samples.find(s => s.lane === "A").model_labeled === true);
  check("sample ids stable", livePre.attribution_samples[0].sample_id === livePost.attribution_samples[0].sample_id);
  check("raw eval stream omitted from export", Object.keys(livePre.meta.evaluation_streams || {}).length === 0);

  console.log("Battle rounds do not inherit each other's evaluation id:");
  await send({ type: "AE_CLEAR" });
  const roundUrl = "https://arena.ai/nextjs-api/stream/post-to-evaluation";
  // Round 1 arrives with no init record of its own.
  await send({ type: "AE_EVENT", evt: { kind: "stream_chunk", url: roundUrl, text: 'a0:"one"b0:"uno"ad:{"finishReason":"stop"}bd:{"finishReason":"stop"}' } });
  await send({ type: "AE_EVENT", evt: { kind: "stream_end", url: roundUrl } });
  // Round 2 carries its own init, and is the round the request log describes.
  await send({ type: "AE_EVENT", evt: { kind: "request", url: roundUrl, method: "POST", body: JSON.stringify({ id: "round-2", mode: "battle", modelAMessageId: "m-a2", userMessage: { content: "second" } }) } });
  await send({ type: "AE_EVENT", evt: { kind: "stream_chunk", url: roundUrl, text: '{"id":"round-2","mode":"battle","modelAMessageId":"m-a2","userMessage":{"content":"second"}}a0:"two"b0:"dos"ad:{"finishReason":"stop"}bd:{"finishReason":"stop"}' } });
  await send({ type: "AE_EVENT", evt: { kind: "stream_end", url: roundUrl } });
  const rounds = JSON.parse((await send({ type: "AE_EXPORT", mode: "full_history", snapshot: null })).json);
  check("both rounds exported", rounds.battles.length === 2);
  check("rounds kept their own lane text",
    rounds.battles[0].contestants[0].response === "one" && rounds.battles[1].contestants[0].response === "two");
  check("older round did not inherit newer evaluation_id", rounds.battles[0].evaluation_id === null);
  check("older round did not inherit newer message_id", rounds.battles[0].contestants[0].message_id == null);
  check("newest round still resolves its id from the request log", rounds.battles[1].evaluation_id === "round-2");

  console.log("Warnings are deduped and bounded:");
  await send({ type: "AE_CLEAR" });
  for (let i = 0; i < 5; i++) {
    await send({ type: "AE_EVENT", evt: { kind: "sse", url: "https://arena.ai/out", data: { records: [{ body: JSON.stringify({ type: "abort" }) }] } } });
  }
  const warned = JSON.parse((await send({ type: "AE_EXPORT", mode: "full_history", snapshot: null })).json);
  check("repeated abort recorded once", warned.meta.warnings.filter(w => /stream aborted/.test(w)).length === 1);

  console.log("Idle sessions are evicted before storage fills:");
  await send({ type: "AE_CLEAR" });
  for (let i = 0; i < 16; i++) {
    const sender = { tab: { id: 100 + i, url: "https://arena.ai/c/conv" + i } };
    await send({ type: "AE_EVENT", evt: { kind: "page_context", url: "https://arena.ai/c/conv" + i, conversationKey: "c:conv" + i } }, sender);
    await send({ type: "AE_EVENT", evt: { kind: "json", url: "https://arena.ai/api/z", data: { role: "user", content: "prompt " + i } } }, sender);
  }
  await new Promise((r) => setTimeout(r, 700)); // eviction runs on the save tick
  const after = await send({ type: "AE_GET_STATE" });
  check("session count capped", after.sessions.length <= 12);
  check("most recent conversation survived", after.sessions.some(x => x.key === "c:conv15"));
  check("oldest conversation evicted", !after.sessions.some(x => x.key === "c:conv0"));

  console.log("Multi-turn battle: reveal labels every turn, each turn keeps its prompt:");
  await send({ type: "AE_CLEAR" });
  const EV = "01a01ea6-134c-7d68-b1b4-fc5e8f62f970"; // one id for the whole conversation
  const createUrl = "https://arena.ai/nextjs-api/stream/create-evaluation";
  const postUrl = "https://arena.ai/nextjs-api/stream/post-to-evaluation/" + EV;
  const turns = [
    { url: createUrl, umid: "um-1", prompt: "mirror, mirror on the wall", a: "You are.", b: "technically a screen" },
    { url: postUrl, umid: "um-2", prompt: "what about snow-white?", a: "honesty clause", b: "storybook kind" },
    { url: postUrl, umid: "um-3", prompt: "apples?", a: "WAIT. WAIT.", b: "nuclear winter" },
    { url: postUrl, umid: "um-4", prompt: "fiiiiine", a: "Deal's a deal", b: "Discretion" }
  ];
  for (const t of turns) {
    await send({ type: "AE_EVENT", evt: { kind: "request", url: t.url, method: "POST", body: JSON.stringify({
      id: EV, mode: t.url === createUrl ? "battle" : null, modality: "chat",
      userMessageId: t.umid, modelAMessageId: t.umid + "-a", modelBMessageId: t.umid + "-b",
      userMessage: { content: t.prompt }
    }) } });
    await send({ type: "AE_EVENT", evt: { kind: "stream_chunk", url: t.url, text:
      'a2:[{"type":"heartbeat"}]a0:' + JSON.stringify(t.a) + 'b0:' + JSON.stringify(t.b) +
      'ad:{"finishReason":"stop"}bd:{"finishReason":"stop"}' } });
    await send({ type: "AE_EVENT", evt: { kind: "stream_end", url: t.url } });
  }
  const revealSnapshot = { source: "dom", url: "https://arena.ai/c/" + EV, messages: [],
    battle: { models: ["grok-4.5", "gemini-3.5-flash-lite"], anonymous: false, ballotVisible: false } };
  await send({ type: "AE_EVENT", evt: { kind: "battle_vote", choice: "A is better", label: "A is better", source: "dom_click", url: revealSnapshot.url, capturedAt: new Date().toISOString() } });
  const mt = JSON.parse((await send({ type: "AE_EXPORT", mode: "full_history", snapshot: revealSnapshot })).json);

  check("all four turns exported", mt.battles.length === 4);
  check("every turn kept its own prompt",
    mt.battles.map(b => b.prompt).join("|") === "mirror, mirror on the wall|what about snow-white?|apples?|fiiiiine");
  check("every turn labeled from the single reveal",
    mt.attribution_samples.length === 8 && mt.attribution_samples.every(x => x.model_labeled));
  check("lane A is grok across all turns",
    mt.attribution_samples.filter(x => x.lane === "A").every(x => x.model === "grok-4.5"));
  check("lane B is gemini across all turns",
    mt.attribution_samples.filter(x => x.lane === "B").every(x => x.model === "gemini-3.5-flash-lite"));
  check("propagated labels are marked as such",
    mt.attribution_samples.filter(x => x.model_source === "arena_reveal_propagated").length === 6 &&
    mt.attribution_samples.filter(x => x.model_source === "arena_reveal").length === 2);
  check("only the voted turn carries the outcome",
    mt.battles[3].outcome === "a_wins" && mt.battles.slice(0, 3).every(b => b.outcome === "pending"));
  check("export records the extension version",
    typeof mt.export.extension_version === "string" && mt.export.extension_version.length > 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

