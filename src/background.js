/* Service worker: routes capture events into per-conversation sessions,
 * assembles messages, and builds export JSON (network-as-truth, DOM fallback). */
if (typeof importScripts === "function") {
  importScripts("lib/schema.js", "lib/normalize.js", "session-store.js", "battles.js", "attribution.js", "archive-layout.js", "capture-health.js", "markdown.js", "downloads-sink.js", "native-sink.js", "turn-sync.js", "history-backfill.js", "status-led.js");
}

var STREAMING_WINDOW_MS = 2500;
var AGENT_URL_RE = /(ai-proxy|\/api\/chat\/|stream\/create-chat|stream\/create-evaluation|stream\/post-to-evaluation|\/nextjs-api\/|\/api\/history|workspace)/i;
var NOISE_URL_RE = /(recaptcha|unpkg|iconify|\.riv|\.wasm|surveys|\/rpc\/flags|posthog|analytics|github)/i;
var WORKSPACE_URL_RE = /workspace\/latest/i;
var EVAL_URL_RE = /(create-evaluation|post-to-evaluation)/i;
var EVAL_STREAM_CAP = 2 * 1024 * 1024;

function addMessage(role) {
  var s = ensureState();
  var msg = { id: genId("msg"), turn_index: s.messages.length, role: role, timestamp: new Date().toISOString(), content: [] };
  s.messages.push(msg);
  return msg;
}

function currentAssistantMessage() {
  var s = ensureState();
  var last = s.messages[s.messages.length - 1];
  if (last && last.role === "assistant") return last;
  return addMessage("assistant");
}

function appendBlock(msg, b) {
  var s = ensureState();
  var clean = Object.assign({}, b);
  delete clean.partial;

  if (!b.partial && b.type !== "thinking" && b.type !== "text" && isDuplicateOn(s, clean)) return;

  var last = msg.content[msg.content.length - 1];
  if (b.partial && last && last.type === clean.type && (clean.type === "thinking" || clean.type === "text")) {
    last.text = (last.text || "") + (clean.text || "");
    return;
  }

  if (clean.type === "tool_result" && clean.call_id) {
    for (var i = msg.content.length - 1; i >= 0; i--) {
      var prev = msg.content[i];
      if (prev.type === "tool_call" && prev.call_id === clean.call_id) {
        prev.status = clean.status === "error" ? "error" : "success";
        break;
      }
    }
  }

  msg.content.push(clean);
}

function appendBlocks(blocks) {
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    if (!b || !b.type) continue;

    if (b.type === "text" && (b.role === "user" || b.role === "system")) {
      var msg = addMessage(b.role);
      var clean = Object.assign({}, b);
      delete clean.role;
      delete clean.partial;
      msg.content.push(clean);
      continue;
    }

    appendBlock(currentAssistantMessage(), b);
  }
}

function recordEndpoint(evt, s) {
  var url = String(evt.url || "");
  if (!url || url.indexOf("data:") === 0) return;
  var short = url.length > 300 ? url.slice(0, 300) : url;
  var existing = null;
  for (var i = 0; i < s.endpoints.length; i++) {
    if (s.endpoints[i].url === short) { existing = s.endpoints[i]; break; }
  }
  if (existing) {
    existing.count++;
  } else {
    var tier = AGENT_URL_RE.test(url) ? "agent" : NOISE_URL_RE.test(url) ? "noise" : "other";
    s.endpoints.push({ url: short, status: evt.status || null, contentType: evt.contentType || "", count: 1, tier: tier });
    if (s.endpoints.length > 200) s.endpoints.shift();
  }
  if (!s.session.url && /^https:\/\/([^/]+\.)?(arena\.ai|lmarena\.ai)/.test(url)) s.session.url = url;
}

function evaluationBaseKey(url) {
  return String(url || "").slice(0, 200);
}

function beginEvaluationCapture(s, url, text) {
  if (!s.evaluationStreams || typeof s.evaluationStreams !== "object") s.evaluationStreams = {};
  if (!s.evaluationActive || typeof s.evaluationActive !== "object") s.evaluationActive = {};
  if (!s.evaluationSequence || typeof s.evaluationSequence !== "object") s.evaluationSequence = {};
  var base = evaluationBaseKey(url);
  var key = s.evaluationActive[base];
  if (key && text && /^\s*\{/.test(text) && /\"mode\"\s*:\s*\"battle\"/.test(text) &&
      /[ab]d\s*:\s*\{/.test(s.evaluationStreams[key] || "")) {
    delete s.evaluationActive[base];
    key = null;
  }
  if (!key) {
    var next = (s.evaluationSequence[base] || 0) + 1;
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
  var base = evaluationBaseKey(url);
  if (s.evaluationActive) delete s.evaluationActive[base];
}

function sampleStream(s, url, text, opts) {
  url = String(url || "");
  text = String(text || "");
  opts = opts || {};
  if (EVAL_URL_RE.test(url) && opts.evaluation !== false) {
    var key = beginEvaluationCapture(s, url, text);
    var cur = s.evaluationStreams[key] || "";
    if (cur.length >= EVAL_STREAM_CAP) {
      s.truncatedEval = true;
    } else {
      var next = cur + text;
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

var CAPTURED_REQ_CAP = 40;
function recordRequest(s, evt) {
  var url = String(evt.url || "");
  if (!url) return;
  var body = String(evt.body || "");
  if (EVAL_URL_RE.test(url) && AE.summarizeEvalRequest) body = AE.summarizeEvalRequest(body);
  else if (AE.scrubSecrets) body = AE.scrubSecrets(body);
  if (typeof body !== "string") {
    try { body = JSON.stringify(body); } catch (e) { body = String(evt.body || ""); }
  }
  var bodyCap = EVAL_URL_RE.test(url) ? 24000 : 8000;
  /* Every turn of a multi-turn battle POSTs to the same post-to-evaluation URL,
   * so deduping on method+url alone kept only the final turn and threw away the
   * prompts for every earlier round. Evaluation requests are keyed by the turn's
   * userMessageId so each round survives. */
  var turnId = null;
  if (EVAL_URL_RE.test(url)) {
    var tm = /"userMessageId"\s*:\s*"([^"]+)"/.exec(body);
    turnId = tm ? tm[1] : null;
  }
  var entry = { method: evt.method || "?", url: url.slice(0, 250), body: body.slice(0, bodyCap) };
  if (turnId) entry.turn_id = turnId;
  for (var i = 0; i < s.capturedRequests.length; i++) {
    var prevReq = s.capturedRequests[i];
    if (prevReq.method !== entry.method || prevReq.url !== entry.url) continue;
    if ((prevReq.turn_id || null) !== (entry.turn_id || null)) continue;
    s.capturedRequests[i] = entry;
    return;
  }
  s.capturedRequests.push(entry);
  if (s.capturedRequests.length > CAPTURED_REQ_CAP) s.capturedRequests.shift();
}

function applyUIMessage(um) {
  var s = ensureState();
  var blocks = um.blocks.map(function (b) {
    var c = Object.assign({}, b);
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

  var role = um.role === "user" || um.role === "system" ? um.role : "assistant";
  var msg = addMessage(role);
  msg.content = blocks;
  if (um.messageId != null) s.messageIndex[um.messageId] = s.messages.length - 1;
  return true;
}

function tryUIMessage(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  var um = AE.normalizeUIMessage(parsed);
  if (!um) return false;
  applyUIMessage(um);
  return true;
}

/* Accumulate model-shaped strings seen on the wire for this conversation.
 * Resolution happens at export time: only a single dominant candidate claims
 * orchestrator_model; anything ambiguous is exported as a candidate list so a
 * human (or a fingerprint pass) can decide. */
function noteModelHints(s, data) {
  if (!AE.scanForModelHints || !s) return;
  var found = null;
  try { found = AE.scanForModelHints(data, {}); } catch (e) { return; }
  Object.keys(found).forEach(function (name) {
    if (!s.modelHints[name]) s.modelHints[name] = { count: 0, first_seen: new Date().toISOString() };
    s.modelHints[name].count += found[name];
    s.modelHints[name].last_seen = new Date().toISOString();
  });
}

function resolveOrchestratorModel(s) {
  if (s.session && s.session.orchestrator_model) {
    return { model: s.session.orchestrator_model, source: "arena_reveal" };
  }
  var hints = (s && s.modelHints) || {};
  var names = Object.keys(hints);
  if (!names.length) return { model: null, source: null };
  names.sort(function (a, b) { return hints[b].count - hints[a].count; });
  var total = names.reduce(function (n, k) { return n + hints[k].count; }, 0);
  var top = names[0];
  /* Claim identity only when evidence is essentially unanimous; with two or
   * more strong candidates (e.g. an orchestrator plus a search-side model)
  	* stay silent and surface the candidates instead. */
  var unanimous = names.length === 1 || hints[top].count >= Math.ceil(total * 0.9);
  if (unanimous) return { model: top, source: "network_scan" };
  return { model: null, source: null, candidates: names.slice(0, 5) };
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
      var ts = { kind: "thinking", id: blk.call_id || blk.id || null, text: blk.text || "" };
      b.slots.push(ts);
      if (ts.id) b.byId[ts.id] = ts;
    } else if (blk.type === "text") {
      b.slots.push({ kind: "text", id: null, text: blk.text || "" });
    } else if (blk.type === "artifact") {
      b.slots.push({ kind: "artifact", block: JSON.parse(JSON.stringify(blk)) });
    } else if (blk.type === "tool_call") {
      var sl = toolSlot(b, blk.call_id || null);
      if (blk.tool_name) sl.name = blk.tool_name;
      if (blk.arguments !== undefined) { sl.input = blk.arguments; sl.inputText = ""; }
      if (blk.status) sl.status = blk.status;
    } else if (blk.type === "tool_result" && blk.call_id && b.tools[blk.call_id]) {
      var rs = b.tools[blk.call_id];
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
  var s = ensureState();
  if (messageId != null && s.messageIndex[messageId] != null) {
    s.messageIndex[key] = s.messageIndex[messageId];
    return s.messages[s.messageIndex[key]];
  }
  if (s.messageIndex[key] != null) return s.messages[s.messageIndex[key]];
  var msg = addMessage("assistant");
  s.messageIndex[key] = s.messages.length - 1;
  if (messageId != null) s.messageIndex[messageId] = s.messageIndex[key];
  return msg;
}

function builderBlocks(b) {
  var out = [];
  for (var i = 0; i < b.slots.length; i++) {
    var sl = b.slots[i];
    if (sl.kind === "thinking") {
      if (sl.text) out.push({ type: "thinking", text: sl.text, source: "network" });
    } else if (sl.kind === "text") {
      if (sl.text) out.push({ type: "text", text: sl.text, format: "markdown", source: "network" });
    } else if (sl.kind === "artifact") {
      out.push(sl.block);
    } else if (sl.kind === "tool") {
      var args = sl.input;
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
  var b = s.streamBuilders[s.currentStreamKey];
  if (!b) return;
  var idx = s.messageIndex[s.currentStreamKey];
  if (idx == null) {
    var msg = addMessage("assistant");
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
    var sess = store.sessions[k];
    if (sess && sess.streamDirty) {
      var prev = store.activeKey;
      store.activeKey = k;
      try { rebuildStreamMessage(sess); } finally { store.activeKey = prev; }
    }
  });
}

function slotFor(b, id, kind) {
  if (id && b.byId[id]) return b.byId[id];
  for (var i = b.slots.length - 1; i >= 0; i--) {
    if (b.slots[i].kind === kind) return b.slots[i];
  }
  return null;
}

function toolSlot(b, callId) {
  if (callId && b.tools[callId]) return b.tools[callId];
  var sl = { kind: "tool", callId: callId || null, name: "", inputText: "", input: null, status: "pending" };
  b.slots.push(sl);
  if (callId) b.tools[callId] = sl;
  return sl;
}

function handleStreamChunk(c) {
  var s = ensureState();
  if (!s.streamBuilders || typeof s.streamBuilders !== "object") s.streamBuilders = {};
  var t = c.type;

  if (t === "start") {
    var key = (typeof c.messageId === "string" && c.messageId) || genId("stream");
    s.streamBuilders[key] = newBuilder();
    s.currentStreamKey = key;
    var startMsg = ensureStreamMessageByKey(key, typeof c.messageId === "string" ? c.messageId : null);
    startMsg.content = [];
    return true;
  }

  if (!s.currentStreamKey || !s.streamBuilders[s.currentStreamKey]) {
    var continueId = typeof c.messageId === "string" ? c.messageId : null;
    var resumeKey = null;
    if (continueId && s.messageIndex[continueId] != null) {
      resumeKey = continueId;
    } else if (s.messages.length) {
      var last = s.messages[s.messages.length - 1];
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
      var idx = s.messageIndex[resumeKey];
      if (idx != null && s.messages[idx]) seedBuilderFromMessage(s.streamBuilders[resumeKey], s.messages[idx]);
    }
    s.currentStreamKey = resumeKey;
  }
  var b = s.streamBuilders[s.currentStreamKey];

  if (t === "start-step" || t === "finish-step" || t === "reasoning-end" || t === "text-end" || t === "finish") {
    if (t === "finish") rebuildStreamMessage(s);
    return true;
  }
  if (t === "reasoning-start") {
    var rs = { kind: "thinking", id: c.id || null, text: "" };
    b.slots.push(rs);
    if (c.id) b.byId[c.id] = rs;
    return true;
  }
  if (t === "reasoning-delta") {
    var rd = slotFor(b, c.id, "thinking") || (function () {
      var sl = { kind: "thinking", id: c.id || null, text: "" };
      b.slots.push(sl);
      if (c.id) b.byId[c.id] = sl;
      return sl;
    })();
    rd.text += c.delta || "";
    markStreamDirty(s);
    return true;
  }
  if (t === "text-start") {
    var ts = { kind: "text", id: c.id || null, text: "" };
    b.slots.push(ts);
    if (c.id) b.byId[c.id] = ts;
    return true;
  }
  if (t === "text-delta") {
    var td = slotFor(b, c.id, "text") || (function () {
      var sl = { kind: "text", id: c.id || null, text: "" };
      b.slots.push(sl);
      if (c.id) b.byId[c.id] = sl;
      return sl;
    })();
    td.text += c.delta || "";
    markStreamDirty(s);
    return true;
  }
  if (t === "tool-input-start") {
    var tis = toolSlot(b, c.toolCallId);
    if (c.toolName) tis.name = c.toolName;
    rebuildStreamMessage(s);
    return true;
  }
  if (t === "tool-input-delta") {
    var tid = toolSlot(b, c.toolCallId);
    tid.inputText += c.inputTextDelta || "";
    return true;
  }
  if (t === "tool-input-available") {
    var tia = toolSlot(b, c.toolCallId);
    if (c.toolName) tia.name = c.toolName;
    if (c.input !== undefined) tia.input = c.input;
    rebuildStreamMessage(s);
    return true;
  }
  if (t === "tool-output-available") {
    var toa = toolSlot(b, c.toolCallId);
    toa.output = c.output;
    toa.status = "success";
    rebuildStreamMessage(s);
    return true;
  }
  if (t === "tool-output-error") {
    var toe = toolSlot(b, c.toolCallId);
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
    var um = AE.normalizeUIMessage(c.message ? { message: c.message } : c);
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

  var s = ensureState();
  for (var i = 0; i < data.records.length; i++) {
    var rec = data.records[i];
    if (!rec || typeof rec.body !== "string") continue;
    var parsed;
    try { parsed = JSON.parse(rec.body); } catch (e) { continue; }
    var chunk = parsed && parsed.data && typeof parsed.data.type === "string" ? parsed.data
      : parsed && typeof parsed.type === "string" ? parsed
      : null;
    if (!chunk) continue;
    if (!handleStreamChunk(chunk)) {
      s.stats.unknown++;
      sampleStream(s, url || "realtime-record", JSON.stringify(chunk));
    }
  }
  return true;
}

function handleEvent(evt, sender) {
  if (!evt || typeof evt !== "object") return;
  var s = resolveSessionForEvent(evt, sender);
  var syncKey = s.session.conversation_key;
  var syncTabId = sender && sender.tab && sender.tab.id != null ? sender.tab.id : null;
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
    if (evt.sessionId) s.session.session_id = evt.sessionId;
    if (!s.session.url && evt.url) s.session.url = evt.url;
    scheduleSave();
    return;
  }
  if (evt.kind === "endpoint") {
    recordEndpoint(evt, s);
    scheduleSave();
    return;
  }
  if (evt.kind === "battle_vote") {
    if (!recordBattleVote(s, evt)) s.stats.unknown++;
    scheduleSave();
    scheduleTurnSync("vote", syncKey, syncTabId);
    return;
  }
  if (evt.kind === "stream_end" || evt.kind === "stream_done") {
    if (EVAL_URL_RE.test(evt.url || "")) finishEvaluationCapture(s, evt.url);
    scheduleSave();
    scheduleTurnSync("stream_end", syncKey, syncTabId);
    return;
  }
  if (evt.kind === "ws") {
    recordRequest(s, { method: "WS", url: evt.url, body: evt.text });
    try {
      var wsData = JSON.parse(evt.text);
      noteModelHints(s, wsData);
      if (tryUIMessage(wsData)) { scheduleSave(); return; }
      var wsBlocks = AE.normalizeCaptured(wsData, { streaming: false });
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
    sampleStream(s, evt.url, evt.text);
    scheduleSave();
    return;
  }
  if (evt.kind === "rsc_row") {
    s.stats.streamChunks++;
    sampleStream(s, evt.url, evt.text);
    scheduleSave();
    return;
  }
  if (evt.kind === "request") {
    recordRequest(s, evt);
    var reqParsed = null;
    try { reqParsed = JSON.parse(evt.body); } catch (e) { /* non-JSON */ }
    if (reqParsed) noteModelHints(s, reqParsed);
    if (reqParsed && tryUIMessage(reqParsed)) { scheduleSave(); return; }
    var reqBlocks = reqParsed ? AE.normalizeCaptured(reqParsed, { streaming: false }) : [];
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
    if (tryRealtimeRecords(evt.data, evt.url)) { noteModelHints(s, evt.data); scheduleSave(); return; }
    noteModelHints(s, evt.data);
    if (tryUIMessage(evt.data)) { scheduleSave(); return; }
    var blocks = AE.normalizeCaptured(evt.data, { streaming: evt.kind === "sse" });
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

function buildSummary(messages) {
  var tools = {};
  var commands = 0;
  var actions = 0;
  var thinkingChars = 0;
  messages.forEach(function (m) {
    if (!m) return;
    (m.content || []).forEach(function (b) {
      if (b.type === "tool_call") tools[b.tool_name || "unknown"] = true;
      else if (b.type === "command") commands++;
      else if (b.type === "action") actions++;
      else if (b.type === "thinking") thinkingChars += (b.text || "").length;
    });
  });
  return {
    tools_used: Object.keys(tools),
    commands_executed: commands,
    actions_performed: actions,
    thinking_chars: thinkingChars
  };
}

function extensionVersion() {
  try {
    return chrome.runtime.getManifest().version;
  } catch (e) {
    return "unknown";
  }
}

function stamp() {
  var d = new Date();
  function p(n) { return String(n).padStart(2, "0"); }
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function messageTextFingerprint(msg) {
  if (!msg || !Array.isArray(msg.content)) return "";
  var pieces = msg.content.filter(function (b) {
    return b && b.type === "text" && typeof b.text === "string" && b.text.trim();
  }).map(function (b) { return b.text; });
  return pieces.join("\n").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 1000);
}

function messagesMatchForBackfill(a, b) {
  var af = messageTextFingerprint(a);
  var bf = messageTextFingerprint(b);
  if (!af || !bf) return false;
  if (af === bf) return true;
  return Math.min(af.length, bf.length) >= 32 && (af.indexOf(bf) !== -1 || bf.indexOf(af) !== -1);
}

function mergeDomBackfill(networkMessages, domMessages) {
  if (!Array.isArray(networkMessages) || !Array.isArray(domMessages) || !domMessages.length) {
    return { messages: networkMessages, added: 0 };
  }
  var networkIndex = [];
  for (var ni = 0; ni < networkMessages.length; ni++) {
    if (messageTextFingerprint(networkMessages[ni])) networkIndex.push(ni);
  }
  if (!networkIndex.length) return { messages: networkMessages, added: 0 };

  var domAnchors = [];
  for (var di = 0; di < domMessages.length; di++) {
    var matched = -1;
    for (var xi = 0; xi < networkIndex.length; xi++) {
      var candidateIndex = networkIndex[xi];
      if (messagesMatchForBackfill(domMessages[di], networkMessages[candidateIndex])) {
        matched = candidateIndex;
        break;
      }
    }
    domAnchors.push(matched);
  }
  if (domAnchors.every(function (x) { return x < 0; })) return { messages: networkMessages, added: 0 };

  var inserts = {};
  var added = 0;
  for (var mi = 0; mi < domMessages.length; mi++) {
    if (domAnchors[mi] >= 0) continue;
    var before = null;
    for (var next = mi + 1; next < domMessages.length; next++) {
      if (domAnchors[next] >= 0) { before = domAnchors[next]; break; }
    }
    if (before == null) {
      var after = null;
      for (var prev = mi - 1; prev >= 0; prev--) {
        if (domAnchors[prev] >= 0) { after = domAnchors[prev] + 1; break; }
      }
      before = after == null ? networkMessages.length : after;
    }
    if (!inserts[before]) inserts[before] = [];
    inserts[before].push(JSON.parse(JSON.stringify(domMessages[mi])));
    added++;
  }

  if (!added) return { messages: networkMessages, added: 0 };
  var merged = [];
  for (var outi = 0; outi <= networkMessages.length; outi++) {
    if (inserts[outi]) merged.push.apply(merged, inserts[outi]);
    if (outi < networkMessages.length) merged.push(networkMessages[outi]);
  }
  merged.forEach(function (m, i) { m.turn_index = i; });
  return { messages: merged, added: added };
}

function deriveCompleteness(s, warnings) {
  if (s.storageError || s.truncatedEval) return "partial";
  if (warnings.length) return "partial";
  return "full";
}

function sessionIsStreaming(s) {
  var at = s && s.stats ? (s.stats.lastStreamAt || 0) : 0;
  return !!(at && (Date.now() - at) < STREAMING_WINDOW_MS);
}

function applyCaptureHealth(s, snapshot, extra) {
  if (!s || !AE.captureHealth || !AE.healthInputFromSession) return { warnings: [], critical: false };
  extra = extra || {};
  extra.streaming = extra.streaming != null ? extra.streaming : sessionIsStreaming(s);
  var health = AE.captureHealth(AE.healthInputFromSession(s, snapshot, extra));
  s.warnings = AE.mergeHealthWarnings(s.warnings || [], health);
  return health;
}

function buildExport(mode, domSnapshot) {
  var s = ensureState();
  flushStreamMessage(s);
  applyCaptureHealth(s, domSnapshot);
  var warnings = (s.warnings || []).slice();
  var captureSources = ["network"];
  var messages = s.messages.map(function (m) { return JSON.parse(JSON.stringify(m)); });

  var domMsgs = (domSnapshot && domSnapshot.messages) || [];
  if (!messages.length && domMsgs.length) {
    messages = JSON.parse(JSON.stringify(domMsgs));
    captureSources = ["dom"];
    warnings.push("Export reconstructed from DOM: network capture was not active when this conversation started. Roles may rely on positional heuristics.");
  } else if (messages.length && domMsgs.length) {
    var backfill = mergeDomBackfill(messages, domMsgs);
    if (backfill.added) {
      messages = backfill.messages;
      captureSources = ["network", "dom"];
      warnings.push("DOM backfilled " + backfill.added + " visible message(s) that were missed by network capture; hidden reasoning/tool details may still be incomplete.");
    } else if (domMsgs.length > messages.length + 1) {
      warnings.push("DOM shows " + domMsgs.length + " message containers vs " + messages.length + " captured via network; capture may have started mid-session.");
    }
  }
  var exported = messages;
  if (mode === "last_message" && messages.length) {
    var idx = -1;
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") { idx = i; break; }
    }
    if (idx === -1) idx = messages.length - 1;
    var start = idx;
    if (start > 0 && messages[start - 1].role === "user") start--;
    exported = messages.slice(start);
  }

  var battles = buildBattles(s, domSnapshot);
  if (mode === "last_message" && battles.length) battles = battles.slice(-1);

  if (!messages.length && !battles.length) {
    warnings.push("No conversation data captured. Open an Agent Mode or Battle chat, interact with it, then export again.");
  }

  var orchestrator = resolveOrchestratorModel(s);

  var payload = {
    schema_version: AE.SCHEMA_VERSION,
    export: {
      mode: mode,
      exported_at: new Date().toISOString(),
      extension_version: extensionVersion(),
      source: { site: "arena.ai", mode: battles.length ? "battle" : "agent", url: s.session.url || null }
    },
    session: {
      session_id: s.session.session_id,
      conversation_key: s.session.conversation_key || null,
      started_at: s.session.started_at,
      orchestrator_model: orchestrator.model,
      orchestrator_model_source: orchestrator.source,
      orchestrator_model_candidates: orchestrator.candidates || null,
      turn_count: messages.filter(function (m) { return m.role === "user"; }).length
    },
    messages: exported,
    battles: battles,
    attribution_samples: [],
    summary: buildSummary(exported),
    meta: {
      capture_sources: captureSources,
      completeness: deriveCompleteness(s, warnings),
      warnings: warnings,
      stream_samples: s.streamSamples.slice(0, 20),
      evaluation_streams: {},
      battle_votes: s.battleVotes || [],
      captured_requests: (s.capturedRequests || []).map(function (r) {
        var copy = { method: r.method, url: r.url, body: r.body };
        if (AE.scrubSecrets) copy.body = AE.scrubSecrets(copy.body);
        return copy;
      }),
      stats: {
        events_seen: s.stats.events,
        unknown_events: s.stats.unknown,
        stream_chunks: s.stats.streamChunks || 0
      },
      generator: "arena-agent-exporter v" + extensionVersion() + " (schema " + AE.SCHEMA_VERSION + ")",
      endpoint_catalog: s.endpoints.slice(0, 50).map(function (e) { return e.url; })
    }
  };
  payload.attribution_samples = buildAttributionSamples(s, payload);
  if (AE.decorateArchivePaths) AE.decorateArchivePaths(payload, s.archiveRel);
  if (AE.listUrlOnlyFiles) {
    var urlOnly = AE.listUrlOnlyFiles(payload);
    applyCaptureHealth(s, domSnapshot, { urlOnlyFiles: urlOnly, payload: payload });
    var healthOnly = (s.warnings || []).filter(function (w) {
      return AE.isCaptureHealthWarning && AE.isCaptureHealthWarning(w);
    });
    warnings = AE.mergeHealthWarnings(warnings, { warnings: healthOnly });
    s.warnings = warnings.slice();
    payload.meta.warnings = warnings;
    payload.meta.completeness = deriveCompleteness(s, warnings);
  }

  var sid = String(s.session.session_id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  var filenamePrefix = battles.length ? "arena_battle" : "arena_agent";
  var filename = filenamePrefix + "_" + mode + (sid ? "_" + sid : "") + "_" + stamp() + ".json";
  return { payload: payload, filename: filename };
}

function getStateSummary() {
  var s = ensureState();
  flushStreamMessage(s);
  var counts = {};
  s.messages.forEach(function (m) {
    if (!m) return;
    (m.content || []).forEach(function (b) {
      if (b && b.type) counts[b.type] = (counts[b.type] || 0) + 1;
    });
  });
  return {
    sessionId: s.session.session_id,
    conversationKey: s.session.conversation_key || null,
    startedAt: s.session.started_at,
    url: s.session.url,
    title: s.session.title || "",
    messageCount: s.messages.length,
    blockCounts: counts,
    endpointCount: s.endpoints.length,
    endpoints: s.endpoints.slice(0, 50).map(function (e) { return { url: e.url, tier: e.tier }; }),
    warningCount: s.warnings.length,
    warnings: s.warnings.slice(),
    captureHealthCritical: (s.warnings || []).some(function (w) {
      return AE.isCaptureHealthWarning && AE.isCaptureHealthWarning(w) &&
        (w === AE.CAPTURE_HEALTH_MSG.BATTLE_NO_EVAL || w === AE.CAPTURE_HEALTH_MSG.AGENT_NO_STREAM);
    }),
    events: s.stats.events,
    unknownEvents: s.stats.unknown,
    streamChunkCount: s.stats.streamChunks || 0,
    battleVoteCount: Array.isArray(s.battleVotes) ? s.battleVotes.length : 0,
    lastBattleVote: Array.isArray(s.battleVotes) && s.battleVotes.length ? s.battleVotes[s.battleVotes.length - 1] : null,
    streaming: sessionIsStreaming(s),
    lastSync: s.lastSync || null,
    archiveRel: s.archiveRel || null,
    nativeSink: typeof AE.nativeLastStatus === "function" ? AE.nativeLastStatus() : null
  };
}

function isArenaSender(sender) {
  var url = (sender && sender.tab && sender.tab.url) || "";
  return /^https:\/\/([^/]+\.)?(arena\.ai|lmarena\.ai)\//i.test(url);
}

/* Popup actions are about the popup's active tab, never whichever capture
 * session happened to receive the latest event. Full History used to combine
 * the active page's DOM with a different tab's network session, producing a
 * valid-looking export with the wrong URL and conversation id. */
function activateRequestSession(msg) {
  msg = msg || {};
  var explicitKey = typeof msg.sessionKey === "string" ? msg.sessionKey : null;
  var snapshotKey = msg.snapshot && msg.snapshot.url ? conversationKeyFromUrl(msg.snapshot.url) : null;
  if (explicitKey && snapshotKey && explicitKey !== snapshotKey) {
    return { error: "active tab and DOM snapshot refer to different conversations" };
  }
  /* Only an explicit popup/tab key may switch sessions. A snapshot URL is a
   * consistency check, not authority to redirect an older internal caller. */
  var key = explicitKey || null;
  var s;
  if (key) {
    if (!store.sessions[key]) store.sessions[key] = freshState(key);
    store.activeKey = key;
    s = store.sessions[key];
    s.session.conversation_key = key;
    if (msg.tabId != null) {
      store.tabKeys[msg.tabId] = key;
      store.tabKeys[String(msg.tabId)] = key;
    }
  } else {
    s = ensureState();
  }
  if (msg.snapshot && msg.snapshot.url) s.session.url = msg.snapshot.url;
  if (msg.snapshot && msg.snapshot.title) s.session.title = msg.snapshot.title;
  return { key: key, session: s, error: null };
}


function downloadTextFile(filename, text, mime, saveAs) {
  mime = mime || "application/json;charset=utf-8";
  saveAs = saveAs !== false;
  filename = String(filename || "export.json").replace(/[\\/:*?"<>|]/g, "_");
  return new Promise(function (resolve) {
    var blobUrl = null;
    try {
      if (typeof URL !== "undefined" && URL.createObjectURL && typeof Blob !== "undefined") {
        blobUrl = URL.createObjectURL(new Blob([text], { type: mime }));
      }
    } catch (e0) { blobUrl = null; }
    var dataUrl = "data:" + mime + "," + encodeURIComponent(text);
    function attempt(url, useSaveAs, triedBlob) {
      try {
        chrome.downloads.download({
          url: url,
          filename: filename,
          saveAs: !!useSaveAs,
          conflictAction: "uniquify"
        }, function (id) {
          var err = (chrome.runtime.lastError && chrome.runtime.lastError.message) || null;
          if (err && useSaveAs) { attempt(url, false, triedBlob); return; }
          if (err && triedBlob && url === blobUrl) { attempt(dataUrl, useSaveAs, false); return; }
          if (blobUrl && url === blobUrl) {
            try { URL.revokeObjectURL(blobUrl); } catch (e1) { /* ignore */ }
          }
          resolve({ ok: !err && id != null, error: err, id: id });
        });
      } catch (e) {
        if (blobUrl && url === blobUrl) {
          try { URL.revokeObjectURL(blobUrl); } catch (e2) { /* ignore */ }
        }
        resolve({ ok: false, error: String(e) });
      }
    }
    attempt(blobUrl || dataUrl, saveAs, !!blobUrl);
  });
}

function downloadDataUrlFile(filename, dataUrl) {
  filename = String(filename || "file").replace(/[\\/:*?"<>|]/g, "_");
  return new Promise(function (resolve) {
    try {
      chrome.downloads.download({
        url: dataUrl,
        filename: filename,
        saveAs: false,
        conflictAction: "uniquify"
      }, function (id) {
        var err = (chrome.runtime.lastError && chrome.runtime.lastError.message) || null;
        resolve({ ok: !err && id != null, error: err });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== "string" || msg.type.indexOf("AE_") !== 0) return;

  if (msg.type === "AE_EVENT") {
    if (!isArenaSender(sender)) {
      sendResponse({ ok: false, error: "ignored" });
      return;
    }
    if (stateReady) handleEvent(msg.evt, sender);
    else pendingEvents.push({ evt: msg.evt, sender: sender });
    sendResponse({ ok: true, queued: !stateReady });
    try { if (AE.refreshStatusLed) AE.refreshStatusLed(); } catch (eLed) {}
    return;
  }
  if (msg.type === "AE_GET_STATE") {
    stateReadyPromise.then(function () {
      var selected = activateRequestSession(msg);
      if (selected.error) { sendResponse({ ok: false, error: selected.error }); return; }
      var s = selected.session;
      if (msg.snapshot) applyCaptureHealth(s, msg.snapshot);
      var finish = function () {
        sendResponse({ ok: true, state: getStateSummary(), sessions: listSessionSummaries() });
        try { if (AE.refreshStatusLed) AE.refreshStatusLed(); } catch (eLed) {}
        /* Opening the popup/options page is the natural moment to re-check
         * battles whose model reveal was missed by the retry ladder. */
        if (s.labelsPending) {
          scheduleTurnSync("state_poll_label_retry", s.session.conversation_key, null);
        }
      };
      if (typeof AE.nativeStatus === "function") AE.nativeStatus().then(finish);
      else finish();
    });
    return true;
  }
  if (msg.type === "AE_SET_MANUAL_VOTE") {
    stateReadyPromise.then(function () {
      var selected = activateRequestSession(msg);
      if (selected.error) { sendResponse({ ok: false, error: selected.error }); return; }
      var s = selected.session;
      if (msg.choice === "clear") {
        for (var i = s.battleVotes.length - 1; i >= 0; i--) {
          if (s.battleVotes[i].source === "manual") { s.battleVotes.splice(i, 1); break; }
        }
        scheduleSave();
        sendResponse({ ok: true, state: getStateSummary() });
        return;
      }
      var ok = recordBattleVote(s, {
        choice: msg.choice, source: "manual", url: msg.url || "",
        capturedAt: new Date().toISOString()
      });
      scheduleSave();
      sendResponse({ ok: ok, state: getStateSummary() });
    });
    return true;
  }
  if (msg.type === "AE_SAVE_TEXT") {
    downloadTextFile(msg.filename, msg.text || "", msg.mime, msg.saveAs !== false).then(sendResponse);
    return true;
  }
  if (msg.type === "AE_EXPORT") {
    stateReadyPromise.then(function () {
      var selected = activateRequestSession(msg);
      if (selected.error) { sendResponse({ ok: false, error: selected.error }); return; }
      var mode = msg.mode === "last_message" ? "last_message" : "full_history";
      var out = buildExport(mode, msg.snapshot);
      var payload = out.payload;
      var after = (AE.finalizeArchivePayload)
        ? AE.finalizeArchivePayload(payload, { tabId: msg.tabId })
        : Promise.resolve(payload);
      after.then(function () {
        if (AE.applyCompletenessMeta) AE.applyCompletenessMeta(payload);
        var json = JSON.stringify(payload, null, 2);
        if (!msg.save) {
          sendResponse({ ok: true, json: json, filename: out.filename, payload: null });
          return;
        }
        var stamp = (function () {
          var d = new Date();
          var p = function (n) { return String(n).padStart(2, "0"); };
          return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
        })();
        var dir = "arena-exporter-attachments/" + stamp + "/";
        var downloads = [];
        if (AE.decorateInlineArtifacts) {
          var inline = AE.decorateInlineArtifacts(payload, dir);
          (inline.saved || []).forEach(function (s) {
            if (s && s.dataUrl && s.path) downloads.push({ dataUrl: s.dataUrl, path: s.path });
          });
        }
        downloadTextFile(out.filename, json, "application/json;charset=utf-8", true).then(function (dl) {
          var chain = Promise.resolve();
          downloads.forEach(function (d) {
            chain = chain.then(function () { return downloadDataUrlFile(d.path, d.dataUrl); });
          });
          chain.then(function () {
            sendResponse({
              ok: !!dl.ok,
              json: json,
              filename: out.filename,
              error: dl.error || null,
              savedCount: downloads.length
            });
          });
        });
      }, function (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      });
    });
    return true;
  }

  if (msg.type === "AE_HISTORY_PROGRESS") {
    if (!globalThis.__aeBackfill) globalThis.__aeBackfill = {};
    var p = globalThis.__aeBackfill;
    if (msg.stage) p.stage = msg.stage;
    if (msg.page != null) p.page = msg.page;
    if (msg.count != null) p.count = msg.count;
    if (msg.index != null) p.index = msg.index;
    if (msg.total != null) p.total = msg.total;
    if (msg.title != null) p.title = msg.title;
    if (msg.id != null) p.id = msg.id;
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "AE_HISTORY_STATUS") {
    sendResponse({ ok: true, backfill: globalThis.__aeBackfill || { running: false } });
    return;
  }
  if (msg.type === "AE_HISTORY_BACKFILL") {
    if (globalThis.__aeBackfill && globalThis.__aeBackfill.running) {
      sendResponse({ ok: false, error: "backfill already running", backfill: globalThis.__aeBackfill });
      return;
    }
    var tabId = msg.tabId;
    globalThis.__aeBackfill = { running: true, stage: "start", written: 0, skipped: 0, failed: 0, listed: 0, error: null, failedItems: [] };
    var tabMsg = function (payload) {
      return new Promise(function (resolve) {
        try {
          chrome.tabs.sendMessage(tabId, payload, function (got) {
            var err = chrome.runtime.lastError;
            if (err) resolve({ ok: false, error: err.message || "no response — reload the arena.ai tab" });
            else resolve(got || { ok: false, error: "no response — open an arena.ai tab and reload it" });
          });
        } catch (e) {
          resolve({ ok: false, error: String(e) });
        }
      });
    };
    var finish = function (res) {
      globalThis.__aeBackfill.running = false;
      if (res && res.ok === false) globalThis.__aeBackfill.error = res.error || globalThis.__aeBackfill.error;
      try { sendResponse(res); } catch (e) { /* popup may have closed */ }
    };
    AE.archiveIndexLoad().then(function (index) {
      var skip = {};
      Object.keys(index || {}).forEach(function (k) { skip[k] = true; });
      globalThis.__aeBackfill.stage = "list";
      return tabMsg({ type: "AE_HISTORY_LIST" }).then(function (got) {
        if (!got || !got.ok) {
          return { ok: false, error: (got && got.error) || "history list failed" };
        }
        var list = got.list || [];
        var wanted = [];
        var skipped = 0;
        list.forEach(function (item) {
          if (item && item.id) wanted.push(item);
        });
        globalThis.__aeBackfill.listed = list.length;
        globalThis.__aeBackfill.skipped = skipped;
        globalThis.__aeBackfill.total = wanted.length;
        var failed = [];
        var written = 0;
        var chain = Promise.resolve();
        wanted.forEach(function (item, i) {
          chain = chain.then(function () {
            globalThis.__aeBackfill.stage = "fetch";
            globalThis.__aeBackfill.index = i + 1;
            globalThis.__aeBackfill.total = wanted.length;
            globalThis.__aeBackfill.title = item.title || "";
            globalThis.__aeBackfill.id = item.id;
            return tabMsg({ type: "AE_HISTORY_FETCH", item: item }).then(function (gotRec) {
              if (!gotRec || !gotRec.ok || !gotRec.record) {
                failed.push({ id: item.id, error: (gotRec && gotRec.error) || "fetch failed" });
                globalThis.__aeBackfill.failed = failed.length;
                globalThis.__aeBackfill.failedItems = failed.slice(-20);
                return;
              }
              var payload = AE.historyRecordToPayload(gotRec.record);
              if (!payload || !payload.session || !payload.session.conversation_key) {
                failed.push({ id: item.id, error: "could not convert" });
                globalThis.__aeBackfill.failed = failed.length;
                return;
              }
              if (!((payload.messages || []).length || (payload.battles || []).length)) {
                failed.push({ id: item.id, error: "empty conversation" });
                globalThis.__aeBackfill.failed = failed.length;
                return;
              }
              var key = payload.session.conversation_key;
              var prior = index[key] || index["c:" + item.id] || null;
              var alreadyGreen = !!(prior && (prior.completeness === "green" || prior.completeness === "full"));
              if (AE.applyHonestSubtype) AE.applyHonestSubtype(payload);
              var urls = AE.collectArtifactUrls ? AE.collectArtifactUrls(payload) : [];
              if (alreadyGreen && !urls.length) {
                skipped += 1;
                globalThis.__aeBackfill.skipped = skipped;
                return;
              }
              if (AE.shouldSkipEmptyArchive && AE.shouldSkipEmptyArchive(payload) && !urls.length) {
                skipped += 1;
                globalThis.__aeBackfill.skipped = skipped;
                return;
              }
              var existingRel = (prior && prior.rel) || null;
              globalThis.__aeBackfill.stage = "fetch";
              return AE.finalizeArchivePayload(payload, { tabId: tabId, existingRel: existingRel }).then(function () {
              var score = payload.meta && payload.meta.completeness_detail;
              if (score && score.emptyShell && !score.prompt && !(score.files && score.files.expected)) {
                skipped += 1;
                globalThis.__aeBackfill.skipped = skipped;
                return;
              }
              globalThis.__aeBackfill.stage = "write";
              var files = AE.filesToWrite ? AE.filesToWrite(payload) : [];
              return writeArchiveBest(payload, files).then(function (res) {
                if (res && res.ok) {
                  written += 1;
                  globalThis.__aeBackfill.written = written;
                  globalThis.__aeBackfill.lastRel = res.rel;
                } else {
                  failed.push({ id: payload.session.conversation_key, error: (res && res.error) || "write failed" });
                  globalThis.__aeBackfill.failed = failed.length;
                  globalThis.__aeBackfill.failedItems = failed.slice(-20);
                }
              });
              });
            }).then(function () {
              return new Promise(function (r) { setTimeout(r, 180); });
            });
          });
        });
        return chain.then(function () {
          globalThis.__aeBackfill.failed = failed.length;
          globalThis.__aeBackfill.written = written;
          globalThis.__aeBackfill.stage = "done";
          globalThis.__aeBackfill.failedItems = failed.slice(-20);
          return {
            ok: true,
            written: written,
            skipped: skipped,
            listed: list.length,
            failed: failed,
            backfill: globalThis.__aeBackfill
          };
        });
      });
    }).then(finish, function (err) {
      globalThis.__aeBackfill.running = false;
      globalThis.__aeBackfill.error = String(err);
      finish({ ok: false, error: String(err), backfill: globalThis.__aeBackfill });
    });
    return true;
  }

  if (msg.type === "AE_SYNC") {
    stateReadyPromise.then(function () {
      var tabId = msg.tabId != null ? msg.tabId : null;
      var key = msg.sessionKey || null;
      if (!key && tabId != null) {
        key = store.tabKeys[tabId] || store.tabKeys[String(tabId)] || null;
      }
      runTurnSync("manual", key, tabId).then(function (result) {
        if (key && store.sessions[key]) store.activeKey = key;
        sendResponse({ ok: !!(result && result.ok), sync: result, state: getStateSummary() });
      });
    });
    return true;
  }
  /* Round-trips one file through the real sink so the options page can prove
   * the archive path works before a capture depends on it. */
  if (msg.type === "AE_TEST_ARCHIVE") {
    var stamp = new Date().toISOString();
    var body = "arena-exporter archive self-test\n" + stamp + "\n";
    var viaDownloads = function () {
      return AE.writeArchiveFile(AE.ARCHIVE_DIR + "/_selftest.txt", body);
    };
    var done = function (res) { sendResponse(res); };
    if (typeof AE.writeNativeSelftest === "function") {
      AE.writeNativeSelftest(body).then(function (res) {
        if (res && res.ok) { done(res); return; }
        if (res && res.fallback) return viaDownloads().then(done);
        done(res);
      });
    } else {
      viaDownloads().then(done);
    }
    return true;
  }
  if (msg.type === "AE_NATIVE_STATUS") {
    if (typeof AE.nativeStatus === "function") {
      AE.nativeStatus().then(function (st) { sendResponse(st); });
    } else {
      sendResponse({ state: "missing", connected: false, error: "host-missing", fallback: true });
    }
    return true;
  }
  if (msg.type === "AE_ARCHIVE_INDEX") {
    AE.archiveIndexLoad().then(function (index) { sendResponse({ ok: true, index: index }); });
    return true;
  }
  if (msg.type === "AE_SET_SILENT") {
    AE.setSilentWrites(msg.enabled !== false).then(function (v) {
      chrome.storage.local.set({ ae_silent_writes: msg.enabled !== false }, function () {
        void chrome.runtime.lastError;
        sendResponse({ ok: true, suppressed: v });
      });
    });
    return true;
  }
  if (msg.type === "AE_CLEAR") {
    stateReadyPromise.then(function () {
      var selected = activateRequestSession(msg);
      if (selected.error) { sendResponse({ ok: false, error: selected.error }); return; }
      clearActiveSession();
      sendResponse({ ok: true });
    });
    return true;
  }
});

/* Download-bubble suppression does not persist across worker restarts and is
 * opt-in: it hides the shelf for the whole browser, not just this extension. */
try {
  chrome.storage.local.get(["ae_silent_writes"], function (r) {
    void chrome.runtime.lastError;
    if (r && r.ae_silent_writes === true) AE.setSilentWrites(true);
  });
} catch (e) { /* downloads.ui unavailable */ }

startStoreLoad();
