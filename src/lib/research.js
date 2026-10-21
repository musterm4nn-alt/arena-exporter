/* Pure projection from an archived conversation payload into a local library
 * record. No DOM, no storage: the record is what the reader and search index
 * consume, and it is deliberately bounded so one huge conversation cannot
 * exhaust browser storage or freeze the workspace.
 *
 * The input `jsonText` is the exact text written to conversation.json, so the
 * record's payload hash can be compared with the archive index later.
 */
var AE = AE || {};
(function () {
  "use strict";

  const LIMITS = {
    payloadBytes: 4 * 1024 * 1024,
    textChars: 1024 * 1024,
    detailChars: 512 * 1024,
    blockChars: 200000,
    jsonChars: 8000,
    blocks: 4000,
    /* Shared by every message block, battle text and tool call in one record,
     * so the reading preview stays below the payload limit however long the
     * conversation is. Per-block limits alone multiply out to gigabytes. */
    previewChars: 2 * 1024 * 1024,
    previewBlocks: 20000,
    files: 500,
    warnings: 50,
    warningChars: 300
  };

  function text(value) {
    return typeof value === "string" ? value : value == null ? "" : String(value);
  }

  function clip(value, max) {
    const s = text(value);
    return s.length > max ? s.slice(0, max) : s;
  }

  function jsonValue(value, depth, budget) {
    depth = depth || 0;
    budget = budget || { chars: LIMITS.jsonChars };
    if (value == null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") {
      if (/^data:/i.test(value)) return { omitted: "data-url", chars: value.length };
      if (value.length > budget.chars) return { omitted: "too-large", chars: value.length, preview: value.slice(0, 1000) };
      return value;
    }
    if (depth > 6) return { omitted: "too-deep" };
    if (Array.isArray(value)) {
      const max = Math.min(value.length, 200);
      const out = [];
      for (let i = 0; i < max; i++) {
        const item = jsonValue(value[i], depth + 1, budget);
        out.push(item);
        budget.chars -= JSON.stringify(item || "").length;
        if (budget.chars <= 0) { out.push({ omitted: "budget" }); break; }
      }
      if (value.length > max) out.push({ omitted: "items", count: value.length - max });
      return out;
    }
    if (typeof value === "object") {
      const keys = Object.keys(value);
      const out = {};
      for (let i = 0; i < keys.length && i < 100; i++) {
        const key = keys[i];
        if (/^(?:__proto__|constructor|prototype)$/i.test(key)) continue;
        if (/^(?:content|data|bytes|body)$/i.test(key) && typeof value[key] === "string" && value[key].length > limitFor(key)) {
          out[key] = { omitted: "large-field", chars: value[key].length };
          continue;
        }
        const item = jsonValue(value[key], depth + 1, budget);
        out[key] = item;
        budget.chars -= JSON.stringify(item || "").length;
        if (budget.chars <= 0) { out._omitted = "budget"; break; }
      }
      if (keys.length > 100) out._omitted = "keys";
      return out;
    }
    return null;
  }

  function limitFor(key) {
    return key === "body" ? 2000 : 4000;
  }

  /* Clip to the per-field limit and to what is left of the record budget. */
  function take(budget, value, max) {
    const s = text(value);
    const room = Math.max(0, Math.min(max, budget.chars));
    if (s.length > room && room < max) budget.truncated = true;
    const out = s.length > room ? s.slice(0, room) : s;
    budget.chars -= out.length;
    return out;
  }

  function toolArguments(value, budget) {
    if (value == null) return value;
    if (budget.chars <= 0) {
      budget.truncated = true;
      return { omitted: "preview-budget" };
    }
    const out = jsonValue(value, 0, { chars: Math.min(LIMITS.jsonChars, budget.chars) });
    try { budget.chars -= JSON.stringify(out == null ? null : out).length; } catch (_) { /* counted as free */ }
    return out;
  }

  function blockSummary(block, budget) {
    if (!block || typeof block !== "object") return { type: "unknown" };
    const type = clip(block.type, 40) || "unknown";
    if (type === "text") return { type: type, text: take(budget, block.text, LIMITS.blockChars), format: clip(block.format, 40) || null };
    if (type === "thinking") return { type: type, text: take(budget, block.text, LIMITS.blockChars) };
    if (type === "tool_call") {
      return {
        type: type,
        tool_name: clip(block.tool_name || block.name, 200) || "tool",
        status: clip(block.status, 40) || null,
        call_id: clip(block.call_id, 120) || null,
        arguments: toolArguments(block.arguments != null ? block.arguments : block.input, budget),
        output: toolArguments(block.output != null ? block.output : block.result, budget)
      };
    }
    if (type === "artifact") {
      const raw = text(block.content_or_url);
      return {
        type: type,
        title: clip(block.title || block.filename || "File", 300),
        artifact_type: clip(block.artifact_type || block.media_type, 120) || null,
        url: /^https?:/i.test(raw) ? clip(raw, 2000) : null,
        content_omitted: /^data:/i.test(raw) || raw.length > 2000
      };
    }
    if (type === "command" || type === "action") {
      return { type: type, text: take(budget, block.text || block.command || block.action || block.title, LIMITS.blockChars) };
    }
    return { type: type, text: take(budget, block.text || block.title || block.message, LIMITS.blockChars) };
  }

  /* A block left out of the preview still counts toward the conversation's
   * totals, so Insights and the reader header describe the whole chat. */
  function countSkipped(block, record) {
    record.counts.blocks++;
    if (!block || typeof block !== "object") return;
    if (block.type === "tool_call") record.counts.tool_calls++;
    if (block.type === "thinking" && block.text) {
      record.counts.thinking_blocks++;
      record.counts.thinking_chars += text(block.text).length;
    }
  }

  function projectMessages(payload, record, budget) {
    const out = [];
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    messages.forEach(function (message) {
      if (!message || typeof message !== "object" || out.length >= LIMITS.blocks) return;
      const blocks = [];
      (Array.isArray(message.content) ? message.content : []).forEach(function (block) {
        if (blocks.length >= LIMITS.blocks) return;
        if (budget.blocks <= 0 || budget.chars <= 0) {
          budget.truncated = true;
          countSkipped(block, record);
          return;
        }
        budget.blocks--;
        const projected = blockSummary(block, budget);
        blocks.push(projected);
        record.counts.blocks++;
        if (projected.type === "thinking" && projected.text) { record.counts.thinking_blocks++; record.counts.thinking_chars += projected.text.length; record.detail.push(projected.text); }
        if (projected.type === "tool_call") {
          record.counts.tool_calls++;
          record.detail.push(projected.tool_name || "tool");
          try { record.detail.push(JSON.stringify(projected.arguments || null)); } catch (_) { /* skipped */ }
          try { record.detail.push(JSON.stringify(projected.output || null)); } catch (_) { /* skipped */ }
        }
        if (projected.type === "text" && projected.text) record.text.push(projected.text);
      });
      const role = clip(message.role, 40) || "unknown";
      if (role === "user") record.counts.user_messages++;
      if (role === "assistant") record.counts.assistant_messages++;
      out.push({ role: role, blocks: blocks });
    });
    record.counts.messages = out.length;
    return out;
  }

  function projectFilesFromPayload(payload, record) {
    const files = [];
    function add(file, lane) {
      if (!file || files.length >= LIMITS.files) return;
      const name = text(file.archive_path || file.path || file.title || file.filename || file.name);
      if (!name || /^data:/i.test(name)) return;
      files.push({
        name: clip(name, 400),
        lane: clip(lane, 20) || null,
        media_type: clip(file.media_type || file.contentType || file.mimeType, 160) || null,
        bytes: Number(file.bytes || file.size || (typeof file.content === "string" ? file.content.length : 0)) || null,
        has_content: typeof file.content === "string" && !/^data:/i.test(file.content)
      });
    }
    (payload.messages || []).forEach(function (message) {
      (message.content || []).forEach(function (block) {
        if (block && block.type === "artifact") add(block, null);
      });
    });
    (payload.battles || []).forEach(function (battle) {
      (battle.contestants || []).forEach(function (contestant) {
        (contestant.files || []).forEach(function (file) { add(file, contestant.lane); });
      });
      (battle.workspace_files || []).forEach(function (file) { add(file, null); });
    });
    (payload.agent_files || []).forEach(function (file) { add(file, null); });
    record.counts.files = files.length;
    return files;
  }

  /* Battle metadata (lanes, models, votes) is always kept because the library
   * row and Insights read it; only the long texts draw from the budget. */
  function projectBattles(payload, record, budget) {
    const out = [];
    (Array.isArray(payload.battles) ? payload.battles : []).forEach(function (battle) {
      if (!battle || typeof battle !== "object") return;
      const contestants = [];
      (battle.contestants || []).forEach(function (contestant) {
        if (!contestant || typeof contestant !== "object") return;
        const response = take(budget, contestant.response, LIMITS.blockChars);
        const reasoning = take(budget, contestant.reasoning, LIMITS.blockChars);
        if (response) record.text.push(response);
        if (reasoning) record.detail.push(reasoning);
        const calls = [];
        (contestant.tool_calls || []).slice(0, 100).forEach(function (call) {
          calls.push({
            tool_name: clip(call && (call.tool_name || call.name), 200) || "tool",
            arguments: toolArguments(call && (call.arguments != null ? call.arguments : call.input), budget),
            output: toolArguments(call && (call.output != null ? call.output : call.result), budget)
          });
          record.counts.tool_calls++;
          record.detail.push(calls[calls.length - 1].tool_name);
          try { record.detail.push(JSON.stringify(calls[calls.length - 1].arguments || null)); } catch (_) { /* skipped */ }
          try { record.detail.push(JSON.stringify(calls[calls.length - 1].output || null)); } catch (_) { /* skipped */ }
        });
        if (response) record.text.push("");
        contestants.push({
          lane: clip(contestant.lane, 20) || "A",
          model: clip(contestant.model, 300) || null,
          model_source: clip(contestant.model_source, 80) || null,
          verified: !!contestant.model_identity_verified,
          response: response,
          reasoning: reasoning || null,
          tool_calls: calls
        });
      });
      const votes = Array.isArray(battle.votes) ? battle.votes : [];
      const latestVote = votes.length ? votes[votes.length - 1] : (battle.vote || null);
      const outcome = clip(battle.outcome, 40) || "pending";
      if (battle.prompt) record.text.push(battle.prompt);
      if (["a_wins", "b_wins", "both_good", "neither_good"].indexOf(outcome) !== -1) record.vote_outcomes.push(outcome);
      out.push({
        mode: clip(battle.mode, 40) || "battle",
        prompt: take(budget, battle.prompt, LIMITS.blockChars) || null,
        outcome: outcome,
        vote_choice: clip(battle.vote_choice, 40) || null,
        vote_source: latestVote && latestVote.source ? clip(latestVote.source, 40) : null,
        anonymous: !!battle.anonymous,
        winner: clip(battle.winner, 10) || null,
        winner_model: clip(battle.winner_model, 300) || null,
        contestants: contestants
      });
      record.counts.battles++;
    });
    return out;
  }

  function modeOf(payload, battles) {
    const declared = payload && payload.export && payload.export.source && payload.export.source.mode;
    if (declared) return clip(declared, 40);
    if (battles.length) return clip(battles[battles.length - 1].mode, 40) || "battle";
    return "agent";
  }

  function keyFromUrl(url) {
    try {
      const parsed = new URL(url);
      const match = /\/(?:c|agent)\/([A-Za-z0-9_-]+)/.exec(parsed.pathname);
      return match ? "c:" + match[1] : null;
    } catch (_) {
      return null;
    }
  }

  function conversationKey(payload) {
    const session = payload && payload.session || {};
    return text(session.conversation_key || session.session_id) || keyFromUrl(payload && payload.export && payload.export.source && payload.export.source.url) || null;
  }

  function modelList(battles, payload) {
    const models = [];
    if (battles.length) {
      (battles[battles.length - 1].contestants || []).forEach(function (contestant) {
        if (contestant.model && models.indexOf(contestant.model) === -1) models.push(contestant.model);
      });
    } else {
      const session = payload && payload.session || {};
      if (session.orchestrator_model) models.push(clip(session.orchestrator_model, 300));
    }
    return models;
  }

  function warningList(payload) {
    const out = [];
    const warnings = payload && payload.meta && payload.meta.warnings;
    (Array.isArray(warnings) ? warnings : []).forEach(function (warning) {
      const value = clip(warning, LIMITS.warningChars);
      if (value && out.length < LIMITS.warnings && out.indexOf(value) === -1) out.push(value);
    });
    const detail = payload && payload.meta && payload.meta.completeness_detail;
    (detail && Array.isArray(detail.warnings) ? detail.warnings : []).forEach(function (warning) {
      const value = clip(warning, LIMITS.warningChars);
      if (value && out.length < LIMITS.warnings && out.indexOf(value) === -1) out.push(value);
    });
    return out;
  }

  function buildRecord(jsonText, options) {
    options = options || {};
    let payload;
    try {
      payload = JSON.parse(jsonText);
    } catch (_) {
      throw new Error("This conversation file is not valid JSON.");
    }
    if (!payload || typeof payload !== "object") throw new Error("This conversation file is not an export.");
    const key = conversationKey(payload);
    if (!key) throw new Error("This conversation file has no conversation identifier.");
    if (key.length > 200) throw new Error("This conversation identifier is too long.");
    const record = {
      key: key,
      version: 1,
      indexed_at: options.now || new Date().toISOString(),
      source: options.source || "archive",
      rel: options.rel ? clip(options.rel, 500) : null,
      title: "",
      url: clip(payload.export && payload.export.source && payload.export.source.url, 2000) || null,
      mode: "agent",
      subtype: options.subtype ? clip(options.subtype, 60) : null,
      updated_at: options.updated_at || (payload.export && payload.export.exported_at) || new Date().toISOString(),
      conversation_at: clip(payload.session && payload.session.started_at, 80) || null,
      turns: 0,
      models: [],
      models_pending: false,
      completeness: "unknown",
      warnings: [],
      export_mode: clip(payload.export && payload.export.mode, 40) || null,
      extension_version: clip(payload.export && payload.export.extension_version, 40) || null,
      counts: {
        messages: 0, user_messages: 0, assistant_messages: 0, battles: 0,
        blocks: 0, thinking_blocks: 0, thinking_chars: 0, tool_calls: 0, files: 0
      },
      messages: [],
      battles: [],
      files: [],
      text: [],
      detail: [],
      vote_outcomes: [],
      payload_bytes: byteLength(jsonText),
      payload_hash: null,
      payload_omitted: false,
      preview_truncated: false
    };
    const budget = { chars: LIMITS.previewChars, blocks: LIMITS.previewBlocks, truncated: false };
    record.battles = projectBattles(payload, record, budget);
    record.messages = projectMessages(payload, record, budget);
    record.preview_truncated = budget.truncated;
    record.files = projectFilesFromPayload(payload, record);
    record.mode = modeOf(payload, record.battles);
    record.title = clip(payload.session && payload.session.title, 500) || clip(record.battles[0] && record.battles[0].prompt, 500) || "Untitled conversation";
    record.turns = record.battles.length || record.counts.user_messages;
    record.models = modelList(record.battles, payload);
    record.models_pending = record.mode === "agent" ? false : !record.models.length;
    const detail = payload.meta && payload.meta.completeness_detail;
    record.completeness = clip(detail && detail.status || payload.meta && payload.meta.completeness, 20) || "unknown";
    record.warnings = warningList(payload);
    record.text = clip(record.text.join("\n").replace(/\n{4,}/g, "\n\n\n"), LIMITS.textChars);
    record.detail = clip(record.detail.join("\n"), LIMITS.detailChars);
    if (record.payload_bytes > LIMITS.payloadBytes) {
      record.payload_omitted = true;
    }
    delete record.textArray;
    return record;
  }

  function byteLength(value) {
    try { return new TextEncoder().encode(String(value)).length; } catch (_) { return String(value).length; }
  }

  async function sha256(value) {
    const bytes = new TextEncoder().encode(String(value));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const view = new Uint8Array(digest);
    let hex = "";
    for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, "0");
    return hex;
  }

  function archiveHash(jsonText) {
    return sha256("utf8\n" + String(jsonText));
  }

  AE.research = {
    LIMITS: LIMITS,
    keyOf: function (payload) { return conversationKey(payload); },
    buildRecord: buildRecord,
    sha256: sha256,
    archiveHash: archiveHash,
    byteLength: byteLength
  };
  if (typeof module !== "undefined" && module.exports) module.exports = AE.research;
})();
