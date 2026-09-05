/* Export assembly. Explicit session input keeps background writes isolated. */
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

function buildExport(mode, domSnapshot, session) {
  var s = session || ensureState();
  flushStreamMessage(s);
  if (domSnapshot && domSnapshot.pageData) recordPageData(s, domSnapshot.pageData, domSnapshot.url);
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
  var sourceMode = battles.length ? battles[battles.length - 1].mode : observedMode(s, domSnapshot) || "agent";
  if (s.transcriptMetadata) captureSources.push("page_transcript");
  if (s.transcriptMetadata && s.transcriptMetadata.pagination && s.transcriptMetadata.pagination.hasMore) {
    warnings.push("The page transcript is paginated; earlier messages may be missing from this export.");
  }

  var payload = {
    schema_version: AE.SCHEMA_VERSION,
    export: {
      mode: mode,
      exported_at: new Date().toISOString(),
      extension_version: extensionVersion(),
      source: { site: "arena.ai", mode: sourceMode, url: s.session.url || (domSnapshot && domSnapshot.url) || null }
    },
    session: {
      session_id: s.session.session_id,
      realtime_session_id: s.session.realtime_session_id || null,
      conversation_key: s.session.conversation_key || null,
      started_at: s.session.started_at,
      title: s.session.title || "",
      orchestrator_model: sourceMode === "agent" ? orchestrator.model : null,
      orchestrator_model_source: sourceMode === "agent" ? orchestrator.source : "not_applicable",
      orchestrator_model_candidates: orchestrator.candidates || null,
      turn_count: exported.filter(function (m) { return m.role === "user"; }).length
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
      evaluation_streams: s.unparsedEvaluationStreams || {},
      request_attempts: s.requestAttempts || [],
      transport: s.transport,
      transcript: s.transcriptMetadata || null,
      model_catalog: s.modelCatalog ? { source_url: s.modelCatalog.source_url, captured_at: s.modelCatalog.captured_at, row_count: s.modelCatalog.models.length } : null,
      model_hints: { verified: false, names: orchestrator.candidates || [] },
      battle_votes: s.battleVotes || [],
      captured_requests: (s.capturedRequests || []).map(function (r) {
        var copy = { method: r.method, url: r.url, body: r.body };
        if (r.request_id) copy.request_id = r.request_id;
        if (r.turn_id) copy.turn_id = r.turn_id;
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
  if (mode === "last_message") {
    // Scope diagnostic bodies too: full transport samples contain older prompts.
    var ids = battles.map(function (b) { return b.request_id; }).filter(Boolean);
    var latest = latestRequestOutcome(s);
    if (!ids.length && latest && latest.request_id) ids.push(latest.request_id);
    payload.meta.request_attempts = (s.requestAttempts || []).filter(function (r) { return ids.includes(r.request_id); });
    payload.meta.captured_requests = payload.meta.captured_requests.filter(function (r) { return ids.includes(r.request_id); });
    payload.meta.stream_samples = [];
    payload.meta.evaluation_streams = {};
    payload.meta.battle_votes = battles.length ? (s.battleVotes || []).slice(-1) : [];
  }
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
  var filenamePrefix = sourceMode === "agent" ? "arena_agent" : /^direct/.test(sourceMode) ? "arena_direct" : "arena_battle";
  var filename = filenamePrefix + "_" + mode + (sid ? "_" + sid : "") + "_" + stamp() + ".json";
  return { payload: AE.scrubSecrets(payload), filename: filename };
}
