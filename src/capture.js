/* Network capture and turn assembly. */
const STREAMING_WINDOW_MS = 2500;
const AGENT_URL_RE = /(ai-proxy|\/api\/chat\/|stream\/create-chat|stream\/create-evaluation|stream\/post-to-evaluation|\/nextjs-api\/|\/api\/history|workspace)/i;
const NOISE_URL_RE = /(recaptcha|unpkg|iconify|\.riv|\.wasm|surveys|\/rpc\/flags|posthog|analytics|github)/i;
const WORKSPACE_URL_RE = /workspace\/latest/i;
const EVAL_URL_RE = /(create-evaluation|post-to-evaluation)/i;
const EVAL_STREAM_CAP = 2 * 1024 * 1024;

function addMessage(role, session) {
  const s = session || ensureState();
  const msg = { id: genId("msg"), turn_index: s.messages.length, role: role, timestamp: new Date().toISOString(), content: [] };
  s.messages.push(msg);
  return msg;
}

function currentAssistantMessage() {
  const s = ensureState();
  const last = s.messages[s.messages.length - 1];
  if (last && last.role === "assistant") return last;
  return addMessage("assistant");
}

function semanticBlockFingerprint(block) {
  if (!block || typeof block !== "object") return "";
  const value = {
    type: block.type || null,
    call_id: block.call_id || null,
    id: block.id || null,
    tool_name: block.tool_name || null,
    action: block.action || null,
    command: block.command == null ? null : block.command,
    arguments: block.arguments == null ? null : block.arguments,
    output: block.output == null ? null : block.output,
    status: block.status || null,
    target: block.target || null,
    title: block.title || null,
    artifact_type: block.artifact_type || null,
    content_or_url: block.content_or_url || null,
    attachment: block.attachment || null
  };
  try { return JSON.stringify(value); } catch (_) { return String(block.type || "unknown"); }
}

function hasSemanticReplayInMessage(msg, block) {
  const wanted = semanticBlockFingerprint(block);
  return (msg && Array.isArray(msg.content) ? msg.content : []).some(function (existing) {
    return semanticBlockFingerprint(existing) === wanted;
  });
}

function appendBlock(msg, b) {
  const s = ensureState();
  const clean = Object.assign({}, b);
  delete clean.partial;

  /* Transport record IDs/sequences handle true frame replays earlier in the
   * pipeline. Semantic blocks are only deduplicated inside one message: an
   * identical artifact or action in a later turn is legitimate conversation
   * data and must not disappear because the session shares a dedupe set. */
  if (!b.partial && b.type !== "thinking" && b.type !== "text" && hasSemanticReplayInMessage(msg, clean)) return;

  const last = msg.content[msg.content.length - 1];
  if (b.partial && last && last.type === clean.type && (clean.type === "thinking" || clean.type === "text")) {
    last.text = (last.text || "") + (clean.text || "");
    return;
  }

  if (clean.type === "tool_result" && clean.call_id) {
    for (let i = msg.content.length - 1; i >= 0; i--) {
      const prev = msg.content[i];
      if (prev.type === "tool_call" && prev.call_id === clean.call_id) {
        prev.status = clean.status === "error" ? "error" : "success";
        break;
      }
    }
  }

  msg.content.push(clean);
}

function appendBlocks(blocks) {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b || !b.type) continue;

    if (b.type === "text" && (b.role === "user" || b.role === "system")) {
      const msg = addMessage(b.role);
      const clean = Object.assign({}, b);
      delete clean.role;
      delete clean.partial;
      msg.content.push(clean);
      continue;
    }

    appendBlock(currentAssistantMessage(), b);
  }
}

function recordEndpoint(evt, s) {
  const url = String(evt.url || "");
  if (!url || url.indexOf("data:") === 0) return;
  const short = url.length > 300 ? url.slice(0, 300) : url;
  let existing = null;
  for (let i = 0; i < s.endpoints.length; i++) {
    if (s.endpoints[i].url === short) { existing = s.endpoints[i]; break; }
  }
  if (existing) {
    existing.count++;
    existing.status = evt.status == null ? existing.status : evt.status;
    existing.headers = Object.assign({}, existing.headers || {}, AE.safeTransportHeaders(evt.headers));
  } else {
    const tier = AGENT_URL_RE.test(url) ? "agent" : NOISE_URL_RE.test(url) ? "noise" : "other";
    s.endpoints.push({ url: short, status: evt.status || null, contentType: evt.contentType || "", headers: AE.safeTransportHeaders(evt.headers), count: 1, tier: tier });
    if (s.endpoints.length > 200) s.endpoints.shift();
  }
  if (!s.session.url && /^https:\/\/([^/]+\.)?(arena\.ai|lmarena\.ai)/.test(url)) s.session.url = url;
}

function evaluationBaseKey(url) {
  return String(url || "").slice(0, 200);
}

function beginEvaluationCapture(s, url, text, requestId) {
  if (!s.evaluationStreams || typeof s.evaluationStreams !== "object") s.evaluationStreams = {};
  if (!s.evaluationActive || typeof s.evaluationActive !== "object") s.evaluationActive = {};
  if (!s.evaluationSequence || typeof s.evaluationSequence !== "object") s.evaluationSequence = {};
  const base = evaluationBaseKey(url);
  if (requestId) {
    const requestKey = base + "#request:" + requestId;
    if (s.evaluationStreams[requestKey] == null) s.evaluationStreams[requestKey] = "";
    s.evaluationRequests[requestKey] = requestId;
    return requestKey;
  }
  let key = s.evaluationActive[base];
  if (key && text && /^\s*\{/.test(text) && /\"mode\"\s*:\s*\"battle\"/.test(text) &&
      /[ab]d\s*:\s*\{/.test(s.evaluationStreams[key] || "")) {
    delete s.evaluationActive[base];
    key = null;
  }
  if (!key) {
    let next = (s.evaluationSequence[base] || 0) + 1;
    s.evaluationSequence[base] = next;
    key = base;
    if (s.evaluationStreams[key] != null) key = base + "#" + next;
    while (s.evaluationStreams[key] != null) {
      next++;
      s.evaluationSequence[base] = next;
      key = base + "#" + next;
    }
    s.evaluationActive[base] = key;
    s.evaluationStreams[key] = "";
  }
  return key;
}

function finishEvaluationCapture(s, url) {
  const base = evaluationBaseKey(url);
  if (s.evaluationActive) delete s.evaluationActive[base];
}

function sampleStream(s, url, text, opts) {
  url = String(url || "");
  text = String(text || "");
  text = AE.scrubSecrets(text);
  opts = opts || {};
  if (EVAL_URL_RE.test(url) && opts.evaluation !== false) {
    const key = beginEvaluationCapture(s, url, text, opts.requestId);
    const cur = s.evaluationStreams[key] || "";
    if (cur.length >= EVAL_STREAM_CAP) {
      s.truncatedEval = true;
    } else {
      const next = AE.scrubSecrets(cur + text);
      if (next.length > EVAL_STREAM_CAP) {
        s.evaluationStreams[key] = next.slice(0, EVAL_STREAM_CAP);
        s.truncatedEval = true;
        addWarning(s, "Evaluation stream truncated at " + EVAL_STREAM_CAP + " bytes.");
      } else {
        s.evaluationStreams[key] = next;
      }
    }
  }
  if (s.streamSamples.length >= 20) return;
  s.streamSamples.push({ url: url.slice(0, 200), sample: text.slice(0, 300) });
}

const CAPTURED_REQ_CAP = 160;
function recordRequest(s, evt) {
  const url = String(evt.url || "");
  if (!url) return;
  captureRequestMetadata(s, evt);
  let body = String(evt.body || "");
  if (EVAL_URL_RE.test(url) && AE.summarizeEvalRequest) body = AE.summarizeEvalRequest(body);
  else if (AE.scrubSecrets) body = AE.scrubSecrets(body);
  if (typeof body !== "string") {
    try { body = JSON.stringify(body); } catch (e) { body = String(evt.body || ""); }
  }
  const bodyCap = EVAL_URL_RE.test(url) ? 24000 : 8000;
  /* Every turn of a multi-turn battle POSTs to the same post-to-evaluation URL,
   * so deduping on method+url alone kept only the final turn and threw away the
   * prompts for every earlier round. Evaluation requests are keyed by the turn's
   * userMessageId so each round survives. */
  let turnId = null;
  if (EVAL_URL_RE.test(url)) {
    const tm = /"userMessageId"\s*:\s*"([^"]+)"/.exec(body);
    turnId = tm ? tm[1] : null;
  }
  const entry = { method: evt.method || "?", url: url.slice(0, 250), body: body.slice(0, bodyCap) };
  if (evt.requestId) entry.request_id = evt.requestId;
  if (turnId) entry.turn_id = turnId;
  for (let i = 0; i < s.capturedRequests.length; i++) {
    const prevReq = s.capturedRequests[i];
    if (entry.request_id || prevReq.request_id) {
      if (entry.request_id && entry.request_id === prevReq.request_id) { s.capturedRequests[i] = entry; return; }
      continue;
    }
    if (prevReq.method !== entry.method || prevReq.url !== entry.url) continue;
    if ((prevReq.turn_id || null) !== (entry.turn_id || null)) continue;
    s.capturedRequests[i] = entry;
    return;
  }
  s.capturedRequests.push(entry);
  if (s.capturedRequests.length > CAPTURED_REQ_CAP) s.capturedRequests.shift();
}

function applyUIMessage(um) {
  const s = ensureState();
  const blocks = um.blocks.map(function (b) {
    const c = Object.assign({}, b);
    if (!c.source) c.source = "network";
    delete c.partial;
    return c;
  });

  if (um.messageId != null && s.messageIndex[um.messageId] != null) {
    if (!blocks.length) return true;
    s.messages[s.messageIndex[um.messageId]].content = blocks;
    return true;
  }
  if (!blocks.length) return true;

  const role = um.role === "user" || um.role === "system" ? um.role : "assistant";
  const msg = addMessage(role);
  msg.content = blocks;
  if (um.messageId != null) {
    msg.id = um.messageId;
    s.messageIndex[um.messageId] = s.messages.length - 1;
  }
  return true;
}

function tryUIMessage(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  const um = AE.normalizeUIMessage(parsed);
  if (!um) return false;
  applyUIMessage(um);
  return true;
}

/* Retain incidental model mentions as unverified evidence. A tool's model
 * parameter, catalog entry or feature flag never identifies the orchestrator. */
function noteModelHints(s, data) {
  if (!AE.scanForModelHints || !s) return;
  let found = null;
  try { found = AE.scanForModelHints(data, {}); } catch (e) { return; }
  Object.keys(found).forEach(function (name) {
    if (!s.modelHints[name] && Object.keys(s.modelHints).length >= 100) return;
    if (!s.modelHints[name]) s.modelHints[name] = { count: 0, first_seen: new Date().toISOString() };
    s.modelHints[name].count += found[name];
    s.modelHints[name].last_seen = new Date().toISOString();
  });
}

function resolveOrchestratorModel(s) {
  if (s.session && s.session.orchestrator_model_source === "arena_reveal" &&
      s.session.orchestrator_model && !AE.isPlaceholderModel(s.session.orchestrator_model)) {
    return { model: s.session.orchestrator_model, source: "arena_reveal" };
  }
  const hints = (s && s.modelHints) || {};
  const names = Object.keys(hints);
  names.sort(function (a, b) { return hints[b].count - hints[a].count; });
  return { model: null, source: "not_revealed", candidates: names.slice(0, 5) };
}

function newBuilder() { return { slots: [], byId: {}, tools: {} }; }

/* Rebuilds regenerate message content from builder slots only. When a stream
 * resumes without a "start" frame (worker woke mid-stream, interceptor
 * attached late), the builder must therefore be seeded with EVERY block kind
 * already captured for that message -- not just text/thinking -- or the next
 * rebuild silently deletes tool calls, results, and artifacts. */
function seedBuilderFromMessage(b, msg) {
  if (!b || !msg || !Array.isArray(msg.content)) return b;
  msg.content.forEach(function (blk) {
    if (!blk || !blk.type) return;
    if (blk.type === "thinking") {
      const ts = { kind: "thinking", id: blk.call_id || blk.id || null, text: blk.text || "" };
      b.slots.push(ts);
      if (ts.id) b.byId[ts.id] = ts;
    } else if (blk.type === "text") {
      b.slots.push({ kind: "text", id: null, text: blk.text || "" });
    } else if (blk.type === "artifact") {
      b.slots.push({ kind: "artifact", block: JSON.parse(JSON.stringify(blk)) });
    } else if (blk.type === "tool_call") {
      const sl = toolSlot(b, blk.call_id || null);
      if (blk.tool_name) sl.name = blk.tool_name;
      if (blk.arguments !== undefined) { sl.input = blk.arguments; sl.inputText = ""; }
      if (blk.status) sl.status = blk.status;
    } else if (blk.type === "tool_result" && blk.call_id && b.tools[blk.call_id]) {
      const rs = b.tools[blk.call_id];
      rs.output = blk.output;
      rs.status = blk.status === "error" ? "error" : "success";
    } else {
      /* command/action/unknown shapes round-trip verbatim through an artifact slot */
      b.slots.push({ kind: "artifact", block: JSON.parse(JSON.stringify(blk)) });
    }
  });
  return b;
}

function outText(v) {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function ensureStreamMessageByKey(key, messageId) {
  const s = ensureState();
  if (messageId != null && s.messageIndex[messageId] != null) {
    s.messageIndex[key] = s.messageIndex[messageId];
    return s.messages[s.messageIndex[key]];
  }
  if (s.messageIndex[key] != null) return s.messages[s.messageIndex[key]];
  const msg = addMessage("assistant");
  s.messageIndex[key] = s.messages.length - 1;
  if (messageId != null) s.messageIndex[messageId] = s.messageIndex[key];
  return msg;
}

function builderBlocks(b) {
  const out = [];
  for (let i = 0; i < b.slots.length; i++) {
    const sl = b.slots[i];
    if (sl.kind === "thinking") {
      if (sl.text) out.push({ type: "thinking", text: sl.text, source: "network" });
    } else if (sl.kind === "text") {
      if (sl.text) out.push({ type: "text", text: sl.text, format: "markdown", source: "network" });
    } else if (sl.kind === "artifact") {
      out.push(sl.block);
    } else if (sl.kind === "tool") {
      let args = sl.input;
      if (args == null && sl.inputText) {
        try { args = JSON.parse(sl.inputText); }
        catch (e) { args = { raw_input: sl.inputText.slice(0, 2000) }; }
      }
      out.push({
        type: "tool_call",
        tool_name: sl.name || "unknown",
        call_id: sl.callId || null,
        arguments: args != null ? args : null,
        status: sl.status || "pending",
        source: "network"
      });
      if (sl.output !== undefined || sl.status === "success" || sl.status === "error") {
        out.push({
          type: "tool_result",
          call_id: sl.callId || null,
          tool_name: sl.name || "unknown",
          output: sl.output !== undefined ? outText(sl.output) : (sl.errorText || ""),
          status: sl.status === "error" ? "error" : "success",
          source: "network"
        });
      }
    }
  }
  return out;
}

function rebuildStreamMessage(s) {
  s = s || ensureState();
  s.streamDirty = false;
  if (!s.currentStreamKey) return;
  const b = s.streamBuilders[s.currentStreamKey];
  if (!b) return;
  const idx = s.messageIndex[s.currentStreamKey];
  if (idx == null) {
    const msg = addMessage("assistant", s);
    s.messageIndex[s.currentStreamKey] = s.messages.length - 1;
    idx = s.messages.length - 1;
  }
  s.messages[idx].content = builderBlocks(b);
}

/* builderBlocks rebuilds every block in the message from scratch, so doing it
 * per token made a long response quadratic. Text and reasoning deltas only mark
 * the message stale; the rebuild is deferred to the next read (export, state
 * summary, stream finish) or to the 500ms save tick, whichever comes first. */
function markStreamDirty(s) {
  s.streamDirty = true;
}

function flushStreamMessage(s) {
  if (s && s.streamDirty) rebuildStreamMessage(s);
}

function flushAllStreamMessages() {
  Object.keys(store.sessions).forEach(function (k) {
    const sess = store.sessions[k];
    if (sess && sess.streamDirty) {
      rebuildStreamMessage(sess);
    }
  });
}

function slotFor(b, id, kind) {
  if (id != null && id !== "") return b.byId[id] || null;
  for (let i = b.slots.length - 1; i >= 0; i--) {
    if (b.slots[i].kind === kind) return b.slots[i];
  }
  return null;
}

function toolSlot(b, callId) {
  if (callId && b.tools[callId]) return b.tools[callId];
  const sl = { kind: "tool", callId: callId || null, name: "", inputText: "", input: null, status: "pending" };
  b.slots.push(sl);
  if (callId) b.tools[callId] = sl;
  return sl;
}

function handleStreamChunk(c) {
  const s = ensureState();
  if (!s.streamBuilders || typeof s.streamBuilders !== "object") s.streamBuilders = {};
  const t = c.type;

  if (t === "start") {
    const key = (typeof c.messageId === "string" && c.messageId) || genId("stream");
    s.streamBuilders[key] = newBuilder();
    s.currentStreamKey = key;
    const startMsg = ensureStreamMessageByKey(key, typeof c.messageId === "string" ? c.messageId : null);
    startMsg.content = [];
    return true;
  }

  if (!s.currentStreamKey || !s.streamBuilders[s.currentStreamKey]) {
    const continueId = typeof c.messageId === "string" ? c.messageId : null;
    let resumeKey = null;
    if (continueId && s.messageIndex[continueId] != null) {
      resumeKey = continueId;
    } else if (s.messages.length) {
      const last = s.messages[s.messages.length - 1];
      if (last && last.role === "assistant" && last.id) {
        resumeKey = last.id;
        s.messageIndex[resumeKey] = s.messages.length - 1;
      }
    }
    if (!resumeKey) {
      resumeKey = genId("stream");
      ensureStreamMessageByKey(resumeKey, null);
    }
    if (!s.streamBuilders[resumeKey]) {
      s.streamBuilders[resumeKey] = newBuilder();
      const idx = s.messageIndex[resumeKey];
      if (idx != null && s.messages[idx]) seedBuilderFromMessage(s.streamBuilders[resumeKey], s.messages[idx]);
    }
    s.currentStreamKey = resumeKey;
  }
  const b = s.streamBuilders[s.currentStreamKey];

  if (t === "start-step" || t === "finish-step" || t === "reasoning-end" || t === "text-end" || t === "finish") {
    if (t === "finish") {
      rebuildStreamMessage(s);
      markAgentTurnComplete(s, "finish", c.messageMetadata);
    }
    return true;
  }
  if (t === "reasoning-start") {
    const rs = { kind: "thinking", id: c.id || null, text: "" };
    b.slots.push(rs);
    if (c.id) b.byId[c.id] = rs;
    return true;
  }
  if (t === "reasoning-delta") {
    const rd = slotFor(b, c.id, "thinking") || (function () {
      const sl = { kind: "thinking", id: c.id || null, text: "" };
      b.slots.push(sl);
      if (c.id) b.byId[c.id] = sl;
      return sl;
    })();
    rd.text += c.delta || "";
    markStreamDirty(s);
    return true;
  }
  if (t === "text-start") {
    const ts = { kind: "text", id: c.id || null, text: "" };
    b.slots.push(ts);
    if (c.id) b.byId[c.id] = ts;
    return true;
  }
  if (t === "text-delta") {
    const td = slotFor(b, c.id, "text") || (function () {
      const sl = { kind: "text", id: c.id || null, text: "" };
      b.slots.push(sl);
      if (c.id) b.byId[c.id] = sl;
      return sl;
    })();
    td.text += c.delta || "";
    markStreamDirty(s);
    return true;
  }
  if (t === "tool-input-start") {
    const tis = toolSlot(b, c.toolCallId);
    if (c.toolName) tis.name = c.toolName;
    rebuildStreamMessage(s);
    return true;
  }
  if (t === "tool-input-delta") {
    const tid = toolSlot(b, c.toolCallId);
    tid.inputText += c.inputTextDelta || "";
    return true;
  }
  if (t === "tool-input-available") {
    const tia = toolSlot(b, c.toolCallId);
    if (c.toolName) tia.name = c.toolName;
    if (c.input !== undefined) tia.input = c.input;
    rebuildStreamMessage(s);
    return true;
  }
  if (t === "tool-output-available") {
    const toa = toolSlot(b, c.toolCallId);
    toa.output = c.output;
    toa.status = "success";
    rebuildStreamMessage(s);
    return true;
  }
  if (t === "tool-output-error") {
    const toe = toolSlot(b, c.toolCallId);
    toe.errorText = outText(c.errorText || c.error || "error");
    toe.status = "error";
    rebuildStreamMessage(s);
    return true;
  }
  if (t === "source-url" || t === "source-document") {
    b.slots.push({
      kind: "artifact",
      block: {
        type: "artifact",
        artifact_type: "source",
        title: c.title || c.url || c.sourceId || null,
        content_or_url: c.url || null,
        source: "network"
      }
    });
    rebuildStreamMessage(s);
    return true;
  }
  if (t === "file") {
    b.slots.push({
      kind: "artifact",
      block: {
        type: "artifact",
        artifact_type: c.mediaType || "file",
        title: c.filename || null,
        content_or_url: c.url || null,
        source: "network"
      }
    });
    rebuildStreamMessage(s);
    return true;
  }
  if (t === "message") {
    const um = AE.normalizeUIMessage(c.message ? { message: c.message } : c);
    if (um) applyUIMessage(um);
    return true;
  }
  if (t === "abort") {
    addWarning(s, "Agent stream aborted.");
    return true;
  }
  if (t === "error") {
    addWarning(s, "Agent stream error: " + outText(c.errorText || c.message || c.error || "unknown").slice(0, 200));
    return true;
  }
  return false;
}

function tryRealtimeRecords(data, url) {
  if (!data || typeof data !== "object") return false;
  if (data.tail && typeof data.timestamp === "number" && !data.records) return true;
  if (!Array.isArray(data.records)) return false;

  const s = ensureState();
  for (let i = 0; i < data.records.length; i++) {
    const rec = data.records[i];
    if (!rec) continue;
    const control = Array.isArray(rec.headers) && rec.headers.some(function (pair) {
      return pair && pair[0] === "trigger-control" && pair[1] === "turn-complete";
    });
    if (control) {
      s.transport.event_counts["turn-complete"] = (s.transport.event_counts["turn-complete"] || 0) + 1;
      rebuildStreamMessage(s);
      markAgentTurnComplete(s, "turn-complete");
    }
    if (rec.body == null) continue;
    let parsed;
    try { parsed = typeof rec.body === "string" ? JSON.parse(rec.body) : rec.body; } catch (e) { continue; }
    const chunk = parsed && parsed.data && typeof parsed.data.type === "string" ? parsed.data
      : parsed && typeof parsed.type === "string" ? parsed
      : null;
    if (!chunk) continue;
    if (parsed.id) {
      const sequenceKey = String(url || "realtime").split("?")[0];
      const lastSequence = s.recordSequences[sequenceKey];
      if (typeof rec.seq_num === "number" && isFinite(rec.seq_num)) {
        const freshMessage = chunk.type === "start" && chunk.messageId && s.messageIndex[chunk.messageId] == null;
        if (lastSequence != null && rec.seq_num <= lastSequence && !freshMessage) continue;
        s.recordSequences[sequenceKey] = rec.seq_num;
      }
      if (!s.seenRecordIds) s.seenRecordIds = [];
      if (s.seenRecordIds.indexOf(parsed.id) !== -1) continue;
      s.seenRecordIds.push(parsed.id);
      if (s.seenRecordIds.length > 2000) s.seenRecordIds.shift();
    }
    s.transport.event_counts[chunk.type] = (s.transport.event_counts[chunk.type] || 0) + 1;
    if (chunk.type === "turn-complete") { markAgentTurnComplete(s, "turn-complete"); continue; }
    if (!handleStreamChunk(chunk)) {
      s.stats.unknown++;
      sampleStream(s, url || "realtime-record", JSON.stringify(chunk));
    }
  }
  return true;
}

function handleEvent(evt, sender) {
  if (!evt || typeof evt !== "object") return;
  evt = AE.scrubSecrets(evt);
  const s = resolveSessionForEvent(evt, sender);
  const syncKey = s.session.conversation_key;
  const syncTabId = sender && sender.tab && sender.tab.id != null ? sender.tab.id : null;
  s.stats.events++;
  s.stats.lastEventAt = Date.now();
  if (evt.kind === "sse" || evt.kind === "stream_chunk" || evt.kind === "sse_raw" || evt.kind === "ws") {
    s.stats.lastStreamAt = Date.now();
  }

  if (evt.kind === "interceptor_ready") {
    if (!s.session.url) s.session.url = evt.url || "";
    scheduleSave();
    return;
  }
  if (evt.kind === "page_context") {
    scheduleSave();
    return;
  }
  if (evt.kind === "session_hint") {
    if (evt.sessionId) s.session.realtime_session_id = evt.sessionId;
    if (!s.session.url && evt.url) s.session.url = evt.url;
    scheduleSave();
    return;
  }
  if (evt.kind === "endpoint") {
    recordEndpoint(evt, s);
    captureResponseMetadata(s, evt);
    scheduleSave();
    return;
  }
  if (evt.kind === "page_data") {
    recordPageData(s, evt.data, evt.pageUrl || evt.url);
    scheduleSave();
    return;
  }
  if (evt.kind === "request_error" || evt.kind === "stream_error") {
    captureResponseMetadata(s, evt);
    scheduleSave();
    scheduleTurnSync("request_outcome", syncKey, syncTabId);
    return;
  }
  if (evt.kind === "battle_vote") {
    if (!recordBattleVote(s, evt)) s.stats.unknown++;
    scheduleSave();
    scheduleTurnSync("vote", syncKey, syncTabId);
    return;
  }
  if (evt.kind === "stream_end" || evt.kind === "stream_done") {
    captureResponseMetadata(s, Object.assign({}, evt, { kind: "stream_end" }));
    if (EVAL_URL_RE.test(evt.url || "")) finishEvaluationCapture(s, evt.url);
    scheduleSave();
    scheduleTurnSync("stream_end", syncKey, syncTabId);
    return;
  }
  if (evt.kind === "ws") {
    recordRequest(s, { method: "WS", url: evt.url, body: evt.text });
    try {
      const wsData = JSON.parse(evt.text);
      noteModelHints(s, wsData);
      if (tryUIMessage(wsData)) { scheduleSave(); return; }
      const wsBlocks = AE.normalizeCaptured(wsData, { streaming: false });
      if (wsBlocks.length) appendBlocks(wsBlocks);
      else s.stats.unknown++;
    } catch (e) {
      s.stats.unknown++;
      sampleStream(s, evt.url, evt.text);
    }
    scheduleSave();
    return;
  }
  if (evt.kind === "stream_chunk") {
    s.stats.streamChunks++;
    sampleStream(s, evt.url, evt.text, { requestId: evt.requestId });
    scheduleSave();
    return;
  }
  if (evt.kind === "rsc_row") {
    s.stats.streamChunks++;
    if (evt.data) recordPageData(s, AE.pageDataFromObjects([evt.data], evt.pageUrl || evt.url), evt.pageUrl || evt.url);
    sampleStream(s, evt.url, evt.text);
    scheduleSave();
    return;
  }
  if (evt.kind === "request") {
    recordRequest(s, evt);
    let reqParsed = null;
    try { reqParsed = JSON.parse(evt.body); } catch (e) { /* non-JSON */ }
    if (reqParsed) noteModelHints(s, reqParsed);
    if (reqParsed && tryUIMessage(reqParsed)) { scheduleSave(); return; }
    const reqBlocks = reqParsed ? AE.normalizeCaptured(reqParsed, { streaming: false }) : [];
    if (reqBlocks.length) {
      appendBlocks(reqBlocks);
    } else {
      s.stats.unknown++;
      if (/(in\/append|create-chat|create-evaluation|post-to-evaluation|\/nextjs-api\/)/i.test(evt.url || "")) {
        sampleStream(s, evt.url, evt.body, { evaluation: false });
      }
    }
    scheduleSave();
    return;
  }
  if (evt.kind === "sse" || evt.kind === "json") {
    if (tryRealtimeRecords(evt.data, evt.url)) {
      noteModelHints(s, evt.data);
      if (s.needsTurnSync) {
        s.needsTurnSync = false;
        scheduleTurnSync("turn_complete", syncKey, syncTabId);
      }
      scheduleSave();
      return;
    }
    noteModelHints(s, evt.data);
    if (tryUIMessage(evt.data)) { scheduleSave(); return; }
    let blocks = AE.normalizeCaptured(evt.data, { streaming: evt.kind === "sse" });
    if (evt.kind === "json" && WORKSPACE_URL_RE.test(evt.url || "")) {
      blocks = blocks.concat(AE.extractWorkspaceArtifacts(evt.data));
    }
    if (blocks.length) {
      appendBlocks(blocks);
    } else {
      s.stats.unknown++;
      if (AGENT_URL_RE.test(evt.url || "")) {
        try { sampleStream(s, evt.url, JSON.stringify(evt.data)); } catch (e) { /* circular */ }
      }
    }
    scheduleSave();
    return;
  }
  if (evt.kind === "sse_raw") {
    s.stats.unknown++;
    sampleStream(s, evt.url, evt.text);
    scheduleSave();
    return;
  }
}
