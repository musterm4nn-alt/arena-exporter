/* DOM rendering for the local library: transcript reader, insights and health
 * findings. All content is written through textContent or text nodes; the
 * workspace never injects captured HTML.
 */
(function () {
  "use strict";
  const UI = AEUI;

  function element(tag, cls, text) { return UI.element(tag, cls, text); }

  function add(parent, tag, cls, text) {
    const node = element(tag, cls, text);
    parent.appendChild(node);
    return node;
  }

  function humanBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return bytes + " B";
    const units = ["KB", "MB", "GB", "TB"];
    let size = bytes / 1024, index = 0;
    while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
    return (size >= 10 ? size.toFixed(0) : size.toFixed(1)) + " " + units[index];
  }

  function pretty(value) {
    if (value == null) return "—";
    if (typeof value === "string") return value;
    try {
      const text = JSON.stringify(value, null, 2);
      return text.length > 20000 ? text.slice(0, 20000) + "\n…" : text;
    } catch (_) { return String(value); }
  }

  function terms(query) {
    const out = [];
    const pattern = /"([^"]+)"|(\S+)/g;
    let match;
    while ((match = pattern.exec(String(query || "")))) {
      const raw = String(match[1] != null ? match[1] : match[2] || "").trim();
      if (!raw) continue;
      const value = raw.replace(/^-/, "").replace(/^"+|"+$/g, "").toLowerCase();
      if (value && out.indexOf(value) === -1) out.push(value);
    }
    return out;
  }

  function appendRich(parent, value, queryTerms) {
    const text = String(value == null ? "" : value);
    if (!queryTerms || !queryTerms.length || text.length > 2000000) {
      parent.appendChild(document.createTextNode(text));
      return;
    }
    const escaped = queryTerms.slice().sort(function (a, b) { return b.length - a.length; })
      .map(function (term) { return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); });
    let pattern;
    try { pattern = new RegExp("(" + escaped.join("|") + ")", "gi"); } catch (_) {
      parent.appendChild(document.createTextNode(text));
      return;
    }
    let last = 0, match;
    while ((match = pattern.exec(text))) {
      if (!match[0]) { pattern.lastIndex++; continue; }
      if (match.index > last) parent.appendChild(document.createTextNode(text.slice(last, match.index)));
      const mark = element("mark", null, match[0]);
      parent.appendChild(mark);
      last = match.index + match[0].length;
    }
    parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function textBlock(parent, value, queryTerms) {
    const paragraph = add(parent, "div", "reader-text");
    appendRich(paragraph, value, queryTerms);
  }

  function toolCall(parent, call, queryTerms) {
    const card = add(parent, "div", "reader-tool");
    const head = add(card, "div", "reader-tool-head");
    add(head, "span", "reader-tool-name", call.tool_name || "tool");
    if (call.status) add(head, "span", "completeness-label " + (call.status === "success" ? "ok" : "idle"), call.status);
    const args = add(card, "pre", "reader-pre");
    appendRich(args, pretty(call.arguments), queryTerms);
    if (call.output != null) {
      const details = add(card, "details", "reader-details");
      add(details, "summary", null, "Result");
      const output = add(details, "pre", "reader-pre");
      appendRich(output, pretty(call.output), queryTerms);
    }
  }

  function block(parent, item, queryTerms) {
    if (!item) return;
    if (item.type === "text") { textBlock(parent, item.text, queryTerms); return; }
    if (item.type === "thinking") {
      const details = add(parent, "details", "reader-details reader-thinking");
      add(details, "summary", null, "Reasoning");
      const body = add(details, "div", "reader-text");
      appendRich(body, item.text, queryTerms);
      return;
    }
    if (item.type === "tool_call") { toolCall(parent, item, queryTerms); return; }
    if (item.type === "artifact") {
      const row = add(parent, "div", "reader-file");
      add(row, "span", "reader-file-name", item.title || "File");
      add(row, "span", "reader-file-meta", [item.artifact_type, item.content_omitted ? "stored in the archive" : null].filter(Boolean).join(" · "));
      return;
    }
    textBlock(parent, item.text || "", queryTerms);
  }

  function renderMessages(record, container, queryTerms) {
    const list = add(container, "div", "reader-messages");
    record.messages.forEach(function (message, index) {
      const section = add(list, "section", "reader-message " + (message.role === "user" ? "is-user" : "is-assistant"));
      const head = add(section, "header", "reader-message-head");
      add(head, "span", "reader-role", message.role === "user" ? "YOU" : message.role === "assistant" ? "ASSISTANT" : String(message.role || "MESSAGE").toUpperCase());
      add(head, "span", "reader-turn", "Turn " + (index + 1));
      (message.blocks || []).forEach(function (item) { block(section, item, queryTerms); });
    });
  }

  function renderBattles(record, container, queryTerms) {
    const list = add(container, "div", "reader-battles");
    record.battles.forEach(function (battle, index) {
      const section = add(list, "section", "reader-battle");
      const head = add(section, "header", "reader-battle-head");
      add(head, "span", "eyebrow", "ROUND " + (index + 1));
      const outcome = add(head, "span", "outcome-chip " + (battle.outcome || "pending"), String(battle.outcome || "pending").replace(/_/g, " "));
      if (battle.anonymous) add(head, "span", "mode-chip", "Anonymous");
      if (battle.prompt) {
        const prompt = add(section, "div", "reader-prompt");
        appendRich(prompt, battle.prompt, queryTerms);
      }
      const lanes = add(section, "div", "reader-lanes" + (battle.contestants.length < 2 ? " single" : ""));
      battle.contestants.forEach(function (contestant) {
        const lane = add(lanes, "article", "reader-lane");
        const laneHead = add(lane, "header", "reader-lane-head");
        add(laneHead, "span", "lane-badge", "Lane " + (contestant.lane || "?"));
        add(laneHead, "span", "reader-model", contestant.model || "Model not revealed");
        if (contestant.model && contestant.verified) add(laneHead, "span", "completeness-label ok", "Revealed");
        else if (contestant.model) add(laneHead, "span", "completeness-label idle", "Claim");
        if (contestant.response) {
          const body = add(lane, "div", "reader-text");
          appendRich(body, contestant.response, queryTerms);
        } else {
          add(lane, "p", "muted small", "No response text was captured for this lane.");
        }
        if (contestant.reasoning) {
          const details = add(lane, "details", "reader-details");
          add(details, "summary", null, "Reasoning");
          const reasoning = add(details, "div", "reader-text");
          appendRich(reasoning, contestant.reasoning, queryTerms);
        }
        (contestant.tool_calls || []).forEach(function (call) { toolCall(lane, call, queryTerms); });
      });
      const meta = add(section, "footer", "reader-battle-foot");
      if (battle.winner_model) add(meta, "span", null, "Winner: " + battle.winner_model);
      else if (battle.winner) add(meta, "span", null, "Winner: lane " + battle.winner);
      else add(meta, "span", "muted", "No winner recorded.");
      if (battle.vote_choice) add(meta, "span", "muted", "Vote: " + battle.vote_choice + (battle.vote_source ? " · " + battle.vote_source : ""));
    });
  }

  function renderFiles(record, container) {
    if (!record.files || !record.files.length) return;
    const panel = add(container, "section", "reader-files");
    add(panel, "h2", null, "Files and artifacts");
    const list = add(panel, "div", "reader-file-list");
    record.files.forEach(function (file) {
      const row = add(list, "div", "reader-file");
      add(row, "span", "reader-file-name", file.name);
      add(row, "span", "reader-file-meta", [file.lane ? "Lane " + file.lane : null, file.media_type, file.bytes ? humanBytes(file.bytes) : null].filter(Boolean).join(" · "));
    });
    add(panel, "p", "small muted", "Files stay in the archive folder. Use Folder to open them.");
  }

  function renderBody(record, container, query) {
    container.replaceChildren();
    const queryTerms = terms(query);
    if (record.completeness && record.completeness !== "full") {
      const note = add(container, "div", "notice warning");
      add(note, "p", null, record.completeness === "partial"
        ? "This capture is marked partial. Some reasoning, files or earlier messages may be missing."
        : "Completeness was not confirmed for this capture.");
    }
    if ((record.messages || []).length) renderMessages(record, container, queryTerms);
    if ((record.battles || []).length) renderBattles(record, container, queryTerms);
    if (!(record.messages || []).length && !(record.battles || []).length) {
      add(container, "p", "empty-reader", "No transcript text was captured for this conversation. The archive may hold metadata only.");
    }
    renderFiles(record, container);
    const foot = add(container, "p", "small muted reader-end");
    add(foot, "span", null, "Indexed " + UI.date(record.indexed_at, true) + (record.source === "import" ? " from an archive folder." : " when the turn was saved."));
  }

  function renderWarnings(warnings, container) {
    container.replaceChildren();
    if (!warnings || !warnings.length) return;
    const details = add(container, "details", "notice warning");
    add(details, "summary", null, "Capture notes (" + warnings.length + ")");
    const list = add(details, "ul", "reader-warning-list");
    warnings.forEach(function (warning) { add(list, "li", null, warning); });
  }

  function barList(container, rows, options) {
    container.replaceChildren();
    if (!rows.length) { add(container, "p", "muted small", options && options.empty || "Nothing recorded yet."); return; }
    const max = Math.max.apply(null, rows.map(function (row) { return Number(row.value) || 0; }).concat([1]));
    rows.forEach(function (row) {
      const line = add(container, "div", "bar-row");
      add(line, "span", "bar-label", row.label);
      const track = add(line, "div", "bar-track");
      const fill = add(track, "div", "bar-fill" + (row.tone ? " " + row.tone : ""));
      fill.style.width = Math.max(2, Math.round((Number(row.value) || 0) / max * 100)) + "%";
      add(line, "span", "bar-value", UI.number(row.value));
      if (row.note) add(line, "span", "bar-note", row.note);
    });
  }

  function monthLabel(month) {
    const parts = String(month || "").split("-");
    if (parts.length !== 2) return month;
    const date = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, 1));
    if (!Number.isFinite(date.getTime())) return month;
    return date.toLocaleDateString(undefined, { month: "short" }) + " " + String(parts[0]).slice(2);
  }

  function renderInsights(insights, refs) {
    const totals = insights.totals || {};
    UI.setText("insights-conversations", UI.number(totals.conversations));
    UI.setText("insights-turns", UI.number(totals.turns));
    UI.setText("insights-messages", UI.number(totals.messages));
    UI.setText("insights-tools", UI.number(totals.tool_calls));
    barList(refs.activity, (insights.activity && insights.activity.months || []).map(function (item) {
      return { label: monthLabel(item.month), value: item.count };
    }), { empty: "No dated conversations yet." });
    barList(refs.modes, (insights.modes || []).map(function (item) {
      return { label: String(item.mode || "unknown"), value: item.count };
    }), { empty: "No modes recorded." });
    const votes = insights.votes || {};
    const outcomes = votes.outcomes || {};
    barList(refs.votes, [
      { label: "A wins", value: outcomes.a_wins || 0, tone: "ok" },
      { label: "B wins", value: outcomes.b_wins || 0, tone: "ok" },
      { label: "Both good", value: outcomes.both_good || 0 },
      { label: "Neither good", value: outcomes.neither_good || 0, tone: "warn" }
    ], { empty: "No ballots in the archive." });
    refs.votesNote.textContent = UI.number(votes.ballots || 0) + " ballot" + (votes.ballots === 1 ? "" : "s") +
      " · " + UI.number(votes.manual_votes || 0) + " local correction" + (votes.manual_votes === 1 ? "" : "s") +
      " · " + UI.number(votes.pending || 0) + " pending · " +
      UI.number(votes.unrevealed_battles || 0) + " round" + (votes.unrevealed_battles === 1 ? "" : "s") + " with no model label.";
    refs.models.replaceChildren();
    if (!(insights.models || []).length) add(refs.models, "p", "muted small", "No model labels were recorded.");
    else {
      const head = add(refs.models, "div", "model-row model-head");
      add(head, "span", null, "MODEL");
      add(head, "span", null, "SEEN");
      add(head, "span", null, "WINS");
      add(head, "span", null, "SOURCE");
      insights.models.forEach(function (model) {
        const row = add(refs.models, "div", "model-row");
        add(row, "span", "model-name", model.name);
        add(row, "span", null, UI.number(model.appearances));
        add(row, "span", null, UI.number(model.wins));
        add(row, "span", "completeness-label " + (model.verified ? "ok" : "idle"), model.verified ? "Revealed" : "Claim");
      });
    }
    barList(refs.completeness, (insights.completeness || []).map(function (item) {
      const tone = item.status === "full" ? "ok" : item.status === "partial" ? "warn" : "";
      return { label: String(item.status || "unknown"), value: item.count, tone: tone };
    }), { empty: "No completeness data." });
    barList(refs.toolsList, (insights.tools || []).map(function (item) {
      return { label: item.tool, value: item.count };
    }), { empty: "No tool calls recorded." });
    let text = "Built " + UI.date(insights.generated_at, true) + " from " + UI.number(totals.conversations) + " conversation" + (totals.conversations === 1 ? "" : "s") +
      " · " + humanBytes(totals.payload_bytes) + " of payload · " + UI.number(totals.reasoning_chars) + " characters of reasoning.";
    if (insights.activity && insights.activity.earlier) text += " " + UI.number(insights.activity.earlier) + " older conversation(s) fall outside the chart.";
    refs.generated.textContent = text;
  }

  function findingSection(container, title, rows, render) {
    if (!rows || !rows.length) return;
    const details = add(container, "details", "health-section");
    add(details, "summary", null, title + " (" + rows.length + ")");
    const list = add(details, "div", "health-rows");
    rows.forEach(function (row) {
      const line = add(list, "div", "health-row");
      add(line, "span", "health-row-title", row.title || "Untitled conversation");
      add(line, "span", "health-row-key", row.key || "");
      if (render) add(line, "span", "health-row-note", render(row));
    });
  }

  function renderHealth(report, container) {
    container.replaceChildren();
    const problems = report.mismatched.length + report.stale.length + report.orphaned.length;
    if (!problems && !report.missing.length && !report.unchecked.length) {
      const note = add(container, "div", "notice success");
      add(note, "p", null, report.archive_count === 0
        ? "The archive index is empty. Save a conversation first."
        : "Everything lines up: all " + report.matched + " stored payload" + (report.matched === 1 ? "" : "s") + " match the archive hashes.");
      return;
    }
    add(container, "p", "small muted", report.checked + " checked · " + report.matched + " matched · " + report.unchecked.length + " not checked.");
    findingSection(container, "Missing from the library", report.missing, function (row) {
      return row.updated_at ? "archived " + UI.date(row.updated_at) : "index this folder";
    });
    findingSection(container, "Orphaned library entries", report.orphaned, function () { return "not in the archive index"; });
    findingSection(container, "Hash mismatches", report.mismatched, function () { return "re-index from the archive folder"; });
    findingSection(container, "Older than the archive", report.stale, function (row) {
      return "library " + UI.date(row.library_updated_at) + " · archive " + UI.date(row.archive_updated_at);
    });
    findingSection(container, "Not checked", report.unchecked, function (row) { return String(row.reason || "").replace(/_/g, " "); });
  }

  AEUI.reader = {
    renderBody: renderBody,
    renderWarnings: renderWarnings,
    renderInsights: renderInsights,
    renderHealth: renderHealth,
    terms: terms,
    humanBytes: humanBytes
  };
})();
