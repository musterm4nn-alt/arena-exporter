"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { worker } = require("./worker-harness");
const plain = value => JSON.parse(JSON.stringify(value));
const modelId = "12345678-1234-4123-8123-123456789012";
const evaluationId = "23456789-1234-4123-8123-123456789012";
const url = "https://arena.ai/nextjs-api/stream/create-evaluation";
const directTab = { id: 1, url: "https://arena.ai/text/direct" };
const watchdog = setTimeout(() => { console.error("Capture metadata test stalled"); process.exit(1); }, 10000);

(async () => {
  const w = worker(); await w.ready();
  const AE = w.context.AE;
  const jwt = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJzeW50aGV0aWMifQ.c3ludGhldGlj";
  const dirty = {
    recaptchaV3Token: "synthetic-captcha", session: { publicAccessToken: jwt, lastEventId: "167" },
    headers: [["public-access-token", jwt], ["trigger-control", "turn-complete"]],
    body: JSON.stringify({ authorization: "Bearer synthetic", content: "normal text" }),
    raw: "captchaToken=synthetic-raw-token", prose: "credential " + jwt, maxTokens: 500
  };
  const clean = plain(AE.scrubSecrets(dirty));
  assert.equal(clean.recaptchaV3Token, undefined);
  assert.equal(clean.session.publicAccessToken, undefined);
  assert.equal(clean.session.lastEventId, "167");
  assert.equal(clean.headers[0][1], "[REDACTED]");
  assert.equal(JSON.parse(clean.body).authorization, undefined);
  assert.equal(clean.maxTokens, 500);
  assert.ok(!JSON.stringify(clean).includes(jwt));
  assert.ok(!JSON.stringify(clean).includes("synthetic-raw-token"));

  // A nested tool parameter is a real model-shaped field, but is not the orchestrator.
  await w.event({ kind: "json", url: "https://arena.ai/api/chat/x", data: { type: "tool_result", output: { model: "gpt-4o" } } });
  const unknown = await w.export("tab:1");
  assert.equal(unknown.session.orchestrator_model, null);
  assert.equal(unknown.session.orchestrator_model_source, "not_revealed");
  assert.ok(unknown.meta.model_hints.names.includes("gpt-4o"));

  // SSR references are decoded as JSON, never evaluated as script.
  const catalogRows = [{ id: modelId, name: "max-router", publicName: "Max", displayName: "Max", provider: "router", userSelectable: false, rank: 1 }];
  const transcript = { messages: [
    { id: "user-page", role: "user", parts: [{ type: "text", text: "Page prompt" }] },
    { id: "assistant-page", role: "assistant", parts: [{ type: "text", text: "Page answer" }], metadata: { nodeId: "node-page", manifestNodeId: null, pending: false, requiresReview: true, feedback: { rating: "good" } } }
  ], pagination: { hasMore: true, cursor: "older-cursor", limit: 20 }, transcriptReadStrategy: "bounded", session: { publicAccessToken: jwt, lastEventId: "167" }, productMode: "chat", feedbackType: "check_in", customFeedbackArm: null };
  const flight = '0:["$","div",null,{"initialModels":"$1"}]\n1:' + JSON.stringify(catalogRows) + '\n2:' + JSON.stringify(transcript) + '\n';
  const html = "<script>self.__next_f.push([1," + JSON.stringify(flight.slice(0, 70)) + "]);</script><script>self.__next_f.push([1," + JSON.stringify(flight.slice(70)) + "]);</script>";
  const page = AE.parsePageData(html, directTab.url);
  assert.equal(page.catalog.models.length, 1);
  assert.equal(page.catalog.models[0].id, modelId);
  assert.equal(page.transcript.messages[1].metadata.nodeId, "node-page");

  const direct = worker(); await direct.ready();
  await direct.event({ kind: "page_context", url: directTab.url }, directTab);
  await direct.event({ kind: "page_data", pageUrl: directTab.url, url: directTab.url, data: { catalog: page.catalog } }, directTab);
  const request = { id: evaluationId, mode: "direct-battle", modelAId: modelId, userMessageId: "turn-a", modelAMessageId: "assistant-a", userMessage: { content: "Direct prompt" }, recaptchaV3Token: "synthetic-captcha" };
  const event = evt => direct.event({ pageUrl: directTab.url, url, method: "POST", ...evt }, directTab);
  await event({ kind: "request", requestId: "attempt-1", body: JSON.stringify(request) });
  await event({ kind: "endpoint", requestId: "attempt-1", status: 403, headers: { "x-stream-version": "v2", authorization: jwt } });
  await event({ kind: "request_error", requestId: "attempt-1", status: 403, error: '{"error":"recaptcha validation failed"}' });
  await event({ kind: "request", requestId: "attempt-2", body: JSON.stringify({ ...request, recaptchaV2Token: "synthetic-v2" }) });
  await event({ kind: "endpoint", requestId: "attempt-2", status: 400 });
  await event({ kind: "request_error", requestId: "attempt-2", status: 400, error: '{"message":"Selected model is not available for user selection"}' });
  const rejected = await direct.export("c:" + evaluationId);
  assert.equal(rejected.battles.length, 0);
  assert.equal(rejected.attribution_samples.length, 0);
  assert.equal(rejected.export.source.mode, "direct-battle");
  assert.equal(rejected.meta.request_attempts[0].outcome, "captcha_rejected");
  assert.equal(rejected.meta.request_attempts[1].outcome, "selection_rejected");
  assert.equal(rejected.meta.request_attempts[1].selection_rejected, true);
  assert.equal(rejected.meta.request_attempts[1].retry_of, "attempt-1");
  assert.equal(rejected.meta.request_attempts[1].requested_model_a_id, modelId);
  assert.ok(!JSON.stringify(rejected).includes("synthetic-captcha"));
  assert.ok(!JSON.stringify(rejected).includes("synthetic-v2"));
  assert.ok(!JSON.stringify(rejected).includes(jwt));

  await event({ kind: "request", requestId: "attempt-3", body: JSON.stringify(request) });
  await event({ kind: "endpoint", requestId: "attempt-3", status: 200 });
  await event({ kind: "stream_chunk", requestId: "attempt-3", text: 'a0:"Successful direct answer"ad:{"finishReason":"stop"}' });
  await event({ kind: "stream_end", requestId: "attempt-3" });
  const accepted = await direct.export("c:" + evaluationId);
  assert.equal(accepted.battles.length, 1);
  assert.equal(accepted.battles[0].contestants.length, 1);
  assert.equal(accepted.battles[0].request_id, "attempt-3");
  assert.equal(accepted.battles[0].outcome, "not_applicable");
  const lane = accepted.battles[0].contestants[0];
  assert.equal(lane.model, "Max");
  assert.equal(lane.model_source, "request_catalog");
  assert.equal(lane.requested_model_id, modelId);
  assert.equal(lane.catalog_model_id, modelId);
  assert.equal(lane.model_identity_verified, false);
  assert.equal(lane.catalog_user_selectable, false); // flag does not override observed server acceptance
  assert.equal(accepted.attribution_samples.length, 1);
  assert.equal(accepted.attribution_samples[0].mode, "direct-battle");
  assert.equal(accepted.meta.request_attempts[2].outcome, "completed");
  assert.ok(accepted.archive.rel.startsWith("direct/"));
  assert.equal(direct.context.AE.agentWorkspaceZipUrl(accepted), null);

  // Request/stream correlation survives interleaved responses on the same URL.
  await event({ kind: "request", requestId: "turn-4", body: JSON.stringify({ ...request, userMessageId: "turn-4", userMessage: { content: "Fourth prompt" } }) });
  await event({ kind: "request", requestId: "turn-5", body: JSON.stringify({ ...request, userMessageId: "turn-5", userMessage: { content: "Fifth prompt" } }) });
  await event({ kind: "stream_chunk", requestId: "turn-5", text: 'a0:"Fifth answer"ad:{"finishReason":"stop"}' });
  await event({ kind: "stream_chunk", requestId: "turn-4", text: 'a0:"Fourth answer"ad:{"finishReason":"stop"}' });
  const interleaved = await direct.export("c:" + evaluationId);
  assert.equal(interleaved.battles.find(round => round.request_id === "turn-4").prompt, "Fourth prompt");
  assert.equal(interleaved.battles.find(round => round.request_id === "turn-5").prompt, "Fifth prompt");

  // Standard Direct SSE and legacy unprefixed data streams also retain one lane.
  const frames = [
    { type: "start", messageId: "sdk-message" },
    { type: "reasoning-start", id: "reasoning-0" }, { type: "reasoning-delta", id: "reasoning-0", delta: "Thinking" },
    { type: "text-delta", id: "txt-0", delta: "Answer" }, { type: "finish", finishReason: "stop" }
  ].map(frame => "data: " + JSON.stringify(frame) + "\r\n\r\n").join("");
  const sdk = AE.parseEvaluationStream(frames, request);
  assert.equal(sdk.lanes.a.text, "Answer");
  assert.equal(sdk.lanes.a.reasoning, "Thinking");
  assert.equal(sdk.lanes.a.finished, true);
  assert.deepEqual(Object.keys(sdk.lanes), ["a"]);
  assert.equal(AE.parseEvaluationStream('0:"Old protocol"\nd:{"finishReason":"stop"}', request).lanes.a.text, "Old protocol");

  // Logical stream errors remain failures even when the HTTP connection closes cleanly.
  const errorFrames = 'data: {"type":"start","messageId":"error-message"}\n\ndata: {"type":"error","errorText":"Provider unavailable"}\n\ndata: [DONE]\n\n';
  await event({ kind: "request", requestId: "error-turn", body: JSON.stringify({ ...request, userMessageId: "error-turn" }) });
  await event({ kind: "endpoint", requestId: "error-turn", status: 200 });
  await event({ kind: "stream_chunk", requestId: "error-turn", text: errorFrames });
  await event({ kind: "stream_end", requestId: "error-turn" });
  const streamError = await direct.export("c:" + evaluationId);
  assert.equal(streamError.meta.request_attempts.find(attempt => attempt.request_id === "error-turn").outcome, "stream_error");
  assert.ok(!streamError.battles.some(round => round.request_id === "error-turn"));
  const partialError = AE.parseEvaluationStream('0:"Partial answer"\n3:"Provider unavailable"\nd:{"finishReason":"error"}', request);
  assert.equal(partialError.error, "Provider unavailable");
  assert.equal(partialError.lanes.a.text, "Partial answer");
  assert.equal(partialError.lanes.a.finished, false);

  const paired = worker(); await paired.ready();
  const pairedTab = { id: 4, url: "https://arena.ai/text/side-by-side" };
  const pairId = "paired-evaluation";
  await paired.event({ kind: "request", requestId: "paired-request", url, pageUrl: pairedTab.url,
    body: JSON.stringify({ ...request, id: pairId, mode: "side-by-side", modelBId: "second-model" }) }, pairedTab);
  await paired.event({ kind: "stream_chunk", requestId: "paired-request", url, pageUrl: pairedTab.url,
    text: 'a0:"First selected answer"b0:"Second selected answer"ad:{"finishReason":"stop"}bd:{"finishReason":"stop"}' }, pairedTab);
  const pair = await paired.export("c:" + pairId);
  assert.equal(pair.export.source.mode, "side-by-side");
  assert.equal(pair.battles[0].contestants.length, 2);
  assert.equal(pair.battles[0].outcome, "not_applicable");
  assert.equal(pair.battles[0].contestants[1].requested_model_id, "second-model");
  assert.ok(pair.archive.rel.startsWith("side-by-side/"));

  const reopened = worker(); await reopened.ready();
  const reopenedPair = await reopened.export("tab:1", { source: "dom", url: pairedTab.url, messages: [],
    battle: { models: ["First selection", "Second selection"], responses: ["First answer", "Second answer"], greenLanes: ["A"] } });
  assert.equal(reopenedPair.export.source.mode, "side-by-side");
  assert.equal(reopenedPair.battles[0].outcome, "not_applicable");
  assert.equal(reopenedPair.battles[0].winner, null);
  assert.ok(reopenedPair.battles[0].contestants.every(lane => lane.model_source === "page_selection" && !lane.model_identity_verified));

  const agent = worker(); await agent.ready();
  const agentTab = { id: 7, url: "https://arena.ai/agent/agent-page" };
  const streamUrl = "https://arena.ai/ai-proxy/realtime/v1/sessions/agent-transport/out";
  await agent.event({ kind: "page_context", url: agentTab.url, conversationKey: "c:agent-page" }, agentTab);
  const records = [
    { type: "start", messageId: "stream-message" },
    { type: "reasoning-start", id: "0" }, { type: "reasoning-delta", id: "0", delta: "Reason" },
    { type: "text-start", id: "txt-0" }, { type: "text-delta", id: "txt-0", delta: "Stream answer" },
    { type: "finish", messageMetadata: { nodeId: "stream-node", pending: false, requiresReview: true } }
  ].map((data, index) => ({ seq_num: index, body: JSON.stringify({ data, id: "record-" + index }) }));
  await agent.event({ kind: "sse", url: streamUrl, data: { records } }, agentTab);
  await agent.event({ kind: "sse", url: streamUrl, data: { records: [records[4], { headers: [["trigger-control", "turn-complete"], ["public-access-token", jwt]] }] } }, agentTab);
  const streamed = await agent.export("c:agent-page");
  assert.equal(streamed.messages[0].content.find(block => block.type === "text").text, "Stream answer");
  assert.equal(streamed.messages[0].metadata.nodeId, "stream-node");
  assert.equal(streamed.messages[0].finished, true);
  assert.equal(streamed.meta.transport.event_counts["text-delta"], 1);
  assert.equal(streamed.meta.transport.event_counts["turn-complete"], 1);
  assert.ok([...agent.timers.values()].some(timer => timer.ms === 750));
  assert.ok(!JSON.stringify(streamed).includes(jwt));

  // A replay longer than the recent-ID cache must not append any duplicate text.
  const longAgent = worker(); await longAgent.ready();
  const largeRecords = Array.from({ length: 2110 }, (_, seq_num) => ({ seq_num, body: JSON.stringify({ id: "long-" + seq_num,
    data: seq_num === 0 ? { type: "start", messageId: "long-message" }
      : seq_num === 2109 ? { type: "finish" } : { type: "text-delta", id: "long-part", delta: "x" } }) }));
  await longAgent.event({ kind: "sse", url: streamUrl, data: { records: largeRecords } }, agentTab);
  await longAgent.event({ kind: "sse", url: streamUrl, data: { records: largeRecords } }, agentTab);
  const longExport = await longAgent.export(longAgent.context.store.tabKeys[7]);
  assert.equal(longExport.messages[0].content[0].text.length, 2108);
  assert.equal(longExport.meta.transport.event_counts["text-delta"], 2108);

  const history = AE.historyAgentToPayload({ ...transcript, id: evaluationId });
  assert.equal(history.messages[1].metadata.nodeId, "node-page");
  assert.equal(history.meta.transcript.pagination.hasMore, true);
  assert.equal(history.meta.transcript.session.publicAccessToken, undefined);
  assert.equal(history.session.orchestrator_model_source, "not_revealed");
  assert.equal(AE.scoreCompleteness(history).status, "amber");
  const historyDirect = AE.historyEvaluationToPayload({ id: evaluationId, mode: "direct", messages: [
    { id: "u", role: "user", content: "Prompt" }, { id: "a", role: "assistant", content: "Reply", modelId }
  ] });
  assert.equal(historyDirect.messages[1].model, null);
  assert.equal(historyDirect.messages[1].model_id, modelId);
  const historyPair = AE.historyEvaluationToPayload({ id: evaluationId, mode: "side-by-side", messages: [
    { role: "user", content: "Paired prompt" }, { role: "assistant", content: "One" }, { role: "assistant", content: "Two" }
  ] });
  assert.equal(historyPair.battles[0].outcome, "not_applicable");

  // Optional gated inputs are preserved without making requests to gated catalogs.
  await agent.event({ kind: "request", requestId: "agent-create", url: "https://arena.ai/nextjs-api/stream/create-chat", body: JSON.stringify({ modelId, harnessId: "future-harness", recaptchaV3Token: "synthetic-hidden" }) }, { id: 8, url: "https://arena.ai/agent" });
  const optional = await agent.export(agent.context.store.tabKeys[8]);
  assert.equal(optional.meta.request_attempts[0].requested_agent_model_id, modelId);
  assert.equal(optional.meta.request_attempts[0].requested_harness_id, "future-harness");
  assert.equal(optional.session.orchestrator_model, null);
  assert.ok(!JSON.stringify(optional).includes("synthetic-hidden"));

  // Short private text is not a UI-label exception in a shareable debug dump.
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src/lib/dom-extract.js"), "utf8"), w.context);
  assert.ok(!JSON.stringify(AE.dom.redact({ text: "PIN: 123456", title: "Private", type: "text" })).includes("123456"));
  console.log("Credential filtering, catalogs, retries, Direct streams, completion and transcript metadata passed");
  clearTimeout(watchdog);
})().catch(error => { clearTimeout(watchdog); console.error(error); process.exitCode = 1; });
