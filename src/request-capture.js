/* Request attempts retain selection intent and HTTP outcomes independently of
 * assistant output. A retry has its own identity and never overwrites its predecessor. */
function requestAttempt(s, evt) {
  if (!evt.requestId || !/(create-chat|create-evaluation|post-to-evaluation|in\/append)/i.test(evt.url || "")) return null;
  var attempt = s.requestAttempts.find(function (a) { return a.request_id === evt.requestId; });
  if (!attempt) {
    attempt = { request_id: evt.requestId, url: evt.url, method: evt.method || "POST", outcome: "pending", started_at: evt.capturedAt || new Date().toISOString() };
    s.requestAttempts.push(attempt);
    if (s.requestAttempts.length > 160) s.requestAttempts.shift();
  }
  return attempt;
}

function captureRequestMetadata(s, evt) {
  var attempt = requestAttempt(s, evt);
  if (!attempt) return;
  var parsed;
  try { parsed = JSON.parse(evt.body || "{}"); } catch (e) { return; }
  attempt.mode = typeof parsed.mode === "string" ? parsed.mode : null;
  attempt.evaluation_id = /(create-evaluation|post-to-evaluation)/i.test(evt.url || "") ? parsed.id || null : null;
  attempt.turn_id = parsed.userMessageId || (parsed.userMessage && parsed.userMessage.id) || null;
  attempt.requested_model_a_id = parsed.modelAId || null;
  attempt.requested_model_b_id = parsed.modelBId || null;
  attempt.requested_agent_model_id = parsed.modelId || null;
  attempt.requested_harness_id = parsed.harnessId || null;
  if (attempt.turn_id) {
    var previous = s.requestAttempts.filter(function (a) {
      return a !== attempt && a.turn_id === attempt.turn_id && a.evaluation_id === attempt.evaluation_id && a.started_at <= attempt.started_at;
    }).pop();
    if (previous) attempt.retry_of = previous.request_id;
  }
}

function captureResponseMetadata(s, evt) {
  var headers = AE.safeTransportHeaders(evt.headers);
  Object.assign(s.transport.headers, headers);
  var attempt = requestAttempt(s, evt);
  if (!attempt) return;
  if (evt.status != null) attempt.status = evt.status;
  attempt.response_headers = Object.assign({}, attempt.response_headers || {}, headers);
  if (evt.kind === "endpoint") {
    attempt.responded_at = new Date().toISOString();
    attempt.outcome = evt.status >= 400 ? "http_error" : "streaming";
  }
  if (evt.kind === "request_error") {
    var text = String(evt.error || evt.body || "Request failed");
    var parsed;
    try { parsed = JSON.parse(text); } catch (e) { /* text error response */ }
    if (parsed) text = String(parsed.message || (parsed.error && (parsed.error.message || parsed.error)) || text);
    attempt.error = AE.redactSecretText(text).slice(0, 600);
    attempt.selection_rejected = /selected model is not available for user selection/i.test(text);
    attempt.outcome = attempt.selection_rejected ? "selection_rejected"
      : /recaptcha|captcha/i.test(text) ? "captcha_rejected" : evt.status ? "http_error" : "network_error";
  }
  if (evt.kind === "stream_error") {
    attempt.transport_error = String(evt.error || "Stream interrupted").slice(0, 300);
    // A consumer can close a settled /out after the final logical frame.
    if (attempt.outcome !== "completed") attempt.outcome = evt.aborted ? "aborted" : "stream_error";
  }
  if (evt.kind === "stream_end" && !(attempt.status >= 400) && !/^(?:.*_error|selection_rejected|captcha_rejected|aborted)$/.test(attempt.outcome)) {
    attempt.outcome = "completed";
    attempt.completed_at = new Date().toISOString();
  }
}

function markAgentTurnComplete(s, kind, metadata) {
  var key = s.currentStreamKey;
  if (!key) return;
  var idx = s.messageIndex[key];
  if (idx != null && s.messages[idx]) {
    var message = s.messages[idx];
    message.finished = true;
    if (metadata) message.metadata = Object.assign({}, message.metadata || {}, AE.assistantMetadata({ metadata: metadata }));
  }
  if (s.transport.completed_turns.indexOf(key) === -1) {
    s.transport.completed_turns.push(key);
    s.transport.completed_turns = s.transport.completed_turns.slice(-100);
    s.needsTurnSync = true;
  }
  s.transport.last_completion = { message_id: key, signal: kind, captured_at: new Date().toISOString() };
}

function recordPageData(s, data, url) {
  if (!data || typeof data !== "object") return;
  if (data.catalog && Array.isArray(data.catalog.models) && /\/(?:text\/(?:direct|side-by-side)|max|c)(?:[/?#]|$)/i.test(url || "")) {
    s.modelCatalog = AE.cleanModelCatalog(data.catalog.models, url);
  }
  var transcript = data.transcript;
  if (!transcript || !Array.isArray(transcript.messages)) return;
  s.transcriptMetadata = AE.transcriptMetadata(transcript);
  if (typeof AE.historyAgentToPayload !== "function") return;
  var history = AE.historyAgentToPayload(transcript, { id: s.session.session_id });
  history.messages.forEach(function (message, historyIndex) {
    var existingIndex = s.messageIndex[message.id];
    if (existingIndex != null) {
      var old = s.messages[existingIndex];
      old.metadata = Object.assign({}, old.metadata || {}, message.metadata || {});
      if (!old.content.length || (JSON.stringify(message.content).length > JSON.stringify(old.content).length && !s.streamDirty)) old.content = message.content;
    } else {
      var insertAt = s.messages.length;
      for (var i = historyIndex + 1; i < history.messages.length; i++) {
        var nextIndex = s.messageIndex[history.messages[i].id];
        if (nextIndex != null) { insertAt = nextIndex; break; }
      }
      s.messages.splice(insertAt, 0, message);
      s.messages.forEach(function (m, idx) { if (m.id != null) s.messageIndex[m.id] = idx; });
    }
  });
}

function latestRequestOutcome(s) {
  var attempts = s.requestAttempts || [];
  return attempts.length ? attempts[attempts.length - 1] : null;
}

function observedMode(s, snapshot) {
  var attempt = latestRequestOutcome(s);
  if (attempt && attempt.mode) return attempt.mode;
  if (snapshot && snapshot.battle && snapshot.battle.mode) return snapshot.battle.mode;
  var url = snapshot && snapshot.url || s.session.url || "";
  if (/\/(?:text\/direct|max)(?:[/?#]|$)/i.test(url)) return "direct";
  if (/\/text\/side-by-side(?:[/?#]|$)/i.test(url)) return "side-by-side";
  if (/\/agent(?:[/?#]|$)/i.test(url)) return "agent";
  return null;
}
