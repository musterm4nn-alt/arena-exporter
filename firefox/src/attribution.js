/* Build attribution_samples[]: one model output, never a whole battle.
 * Samples must not include vote, winner, or the opposing lane's text. */

/* archive-layout.js also defines AE.padBattleIndex (loaded after this file in
 * the worker's importScripts order), so resolve at call time and keep a local
 * fallback instead of a second definition that can drift. */
function padBattleIndex(n) {
  if (typeof AE !== "undefined" && AE.padBattleIndex) return AE.padBattleIndex(n);
  return n < 10 ? "0" + n : String(n);
}

function cloneBlocks(blocks) {
  return (blocks || []).map(function (b) {
    var c = {};
    Object.keys(b || {}).forEach(function (k) {
      if (k === "vote" || k === "winner" || k === "outcome" || k === "vote_choice") return;
      c[k] = b[k];
    });
    return c;
  });
}

function precedingUserPrompt(messages, index) {
  for (var i = index - 1; i >= 0; i--) {
    var m = messages[i];
    if (!m || m.role !== "user") continue;
    var texts = (m.content || []).filter(function (b) {
      return b && b.type === "text" && b.text;
    }).map(function (b) { return b.text; });
    if (texts.length) return texts.join("\n");
  }
  return null;
}

function laneSampleBlocks(contestant) {
  var blocks = [];
  if (contestant.reasoning) blocks.push({ type: "thinking", text: contestant.reasoning, source: "network" });
  if (contestant.response) {
    blocks.push({ type: "text", text: contestant.response, format: "markdown", source: "network" });
  }
  var calls = contestant.tool_calls && contestant.tool_calls.length
    ? contestant.tool_calls
    : (contestant.tools || []).map(function (name) { return { toolName: name }; });
  calls.forEach(function (t) {
    var name = t.toolName || t.tool_name || t;
    if (!name || typeof name !== "string") return;
    var block = { type: "tool_call", tool_name: name, source: "network" };
    if (t.toolCallId) block.call_id = t.toolCallId;
    if (t.args != null) block.arguments = t.args;
    blocks.push(block);
    if (t.output != null || t.error != null) blocks.push({ type: "tool_result", tool_name: name, call_id: t.toolCallId || null, output: t.output == null ? t.error : t.output, status: t.error != null ? "error" : "success", source: "network" });
  });
  (contestant.sources || []).forEach(function (src) {
    if (!src) return;
    blocks.push({
      type: "artifact",
      artifact_type: "source",
      title: src.title || src.url || null,
      content_or_url: src.url || null,
      source: "network"
    });
  });
  return blocks;
}

function buildAttributionSamples(s, payload) {
  var samples = [];
  var key = (s.session && (s.session.conversation_key || s.session.session_id)) || "unknown";
  var messages = (payload && payload.messages) || [];
  var battles = (payload && payload.battles) || [];
  var sourceMode = payload && payload.export && payload.export.source && payload.export.source.mode || "agent";
  var selectedMode = sourceMode === "direct" || sourceMode === "direct-battle" || sourceMode === "side-by-side";

  battles.forEach(function (battle, i) {
    var idx = i + 1;
    var prompt = battle.prompt || null;
    (battle.contestants || []).forEach(function (c) {
      if (!c || !c.lane) return;
      var model = c.model || null;
      if (model && AE.isPlaceholderModel && AE.isPlaceholderModel(model)) model = null;
      var files = (c.files || []).map(function (f) { return f.path || f; }).filter(Boolean);
      var sampleBlocks = laneSampleBlocks(c);
      if (!sampleBlocks.length && !files.length) return;
      samples.push({
        sample_id: key + ":battle-" + padBattleIndex(idx) + ":" + c.lane,
        conversation_key: key,
        mode: battle.mode || "battle",
        subtype: battle.subtype || "text",
        prompt: prompt,
        lane: c.lane,
        model: model,
        model_labeled: !!model,
        model_source: model ? (c.model_source || "arena_reveal") : "unknown",
        requested_model_id: c.requested_model_id || null,
        catalog_model_id: c.catalog_model_id || null,
        model_identity_verified: c.model_identity_verified == null ? !!model && /arena_reveal/.test(c.model_source || "arena_reveal") : c.model_identity_verified,
        context_source: c.context_source || "unknown",
        blocks: sampleBlocks,
        files: files
      });
    });
  });

  messages.forEach(function (m, i) {
    if (selectedMode && battles.length) return; // lane samples already contain these outputs
    if (!m || m.role !== "assistant") return;
    var blocks = cloneBlocks(m.content);
    if (!blocks.length) return;
    samples.push({
      sample_id: key + ":msg:" + (m.id || String(i)),
      conversation_key: key,
      mode: selectedMode ? sourceMode : battles.length ? "agent_in_mixed" : "agent",
      subtype: null,
      prompt: precedingUserPrompt(messages, i),
      lane: null,
      model: selectedMode ? m.model || null : (payload.session && payload.session.orchestrator_model) || null,
      model_labeled: selectedMode ? !!m.model : !!(payload.session && payload.session.orchestrator_model),
      model_source: selectedMode ? m.model_source || "unknown" : (payload.session && payload.session.orchestrator_model)
        ? (payload.session.orchestrator_model_source || "unknown")
        : ((payload.session && payload.session.orchestrator_model_source) || "not_revealed"),
      blocks: blocks,
      files: (blocks.filter(function (b) { return b.type === "artifact" && b.attachment && b.attachment.path; })
        .map(function (b) { return b.attachment.path; }))
    });
  });

  return samples;
}
