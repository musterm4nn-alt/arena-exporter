/* Render conversation.json as human-readable markdown. */

var AE = AE || {};

function fence(lang, text) {
  var body = String(text == null ? "" : text).replace(/\n+$/, "");
  return "```" + (lang || "") + "\n" + body + "\n```";
}

AE.renderMarkdown = function (payload) {
  payload = payload || {};
  var session = payload.session || {};
  var battles = payload.battles || [];
  var messages = payload.messages || [];
  var exp = payload.export || {};
  var source = exp.source || {};
  var title = session.title || (battles[0] && battles[0].prompt) || "Arena chat";
  var lines = [];
  lines.push("# " + title);
  lines.push("");
  lines.push("- Mode: " + (source.mode || (battles.length ? "battle" : "agent")));
  if (battles[0] && battles[0].subtype) lines.push("- Subtype: " + battles[0].subtype);
  if (source.url) lines.push("- URL: " + source.url);
  if (session.conversation_key) lines.push("- Key: " + session.conversation_key);
  if (payload.archive && payload.archive.rel) lines.push("- Archive: " + payload.archive.rel);
  if (exp.extension_version) lines.push("- Captured by: arena-agent-exporter v" + exp.extension_version);
  if (exp.exported_at) lines.push("- Exported: " + exp.exported_at);
  var latest = battles.length ? battles[battles.length - 1] : null;
  if (latest) {
    var models = (latest.contestants || []).map(function (c) { return c.model || c.lane; }).join(" vs ");
    lines.push("- Models: " + (latest.anonymous ? "pending" : models));
    lines.push("- Outcome (latest): " + (latest.outcome || "pending"));
  }
  lines.push("");

  if (battles.length) {
    battles.forEach(function (b, i) {
      lines.push("## Battle " + (b.index || i + 1));
      lines.push("");
      if (b.prompt) {
        lines.push("### User");
        lines.push("");
        lines.push(b.prompt);
        lines.push("");
      }
      lines.push("Vote: " + (b.outcome || "pending"));
      lines.push("");
      (b.contestants || []).forEach(function (c) {
        lines.push("### " + (c.lane || "?"));
        lines.push("");
        lines.push(c.model ? "(" + c.model + ")" : "(anonymous)");
        lines.push("");
        var thinking = (c.tool_calls || []).length ? "" : "";
        void thinking;
        if (c.response) {
          lines.push(c.response);
          lines.push("");
        }
        (c.tool_calls || []).forEach(function (t) {
          lines.push("- tool `" + (t.toolName || t.tool_name) + "`" + (t.args && t.args.path ? " `" + t.args.path + "`" : ""));
        });
        (c.files || []).forEach(function (f) {
          var p = f.archive_path || f.path;
          if (p) lines.push("- file [" + (f.path || p) + "](" + p + ")");
        });
        lines.push("");
      });
    });
  }

  if (messages.length) {
    messages.forEach(function (m) {
      var heading = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : m.role;
      lines.push("## " + heading);
      lines.push("");
      (m.content || []).forEach(function (b) {
        if (!b) return;
        if (b.type === "thinking" && b.text) {
          lines.push(fence("thinking", b.text));
          lines.push("");
        } else if (b.type === "text" && b.text) {
          lines.push(b.text);
          lines.push("");
        } else if (b.type === "tool_call") {
          lines.push("- tool `" + (b.tool_name || "unknown") + "`");
        } else if (b.type === "artifact") {
          var href = (b.attachment && b.attachment.path) || b.content_or_url || b.title;
          lines.push("- artifact [" + (b.title || href) + "](" + href + ")");
        }
      });
      lines.push("");
    });
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
};
