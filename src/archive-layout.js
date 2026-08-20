/* Folder taxonomy for the on-disk archive. Pure functions; no I/O. */

var AE = AE || {};

AE.ARCHIVE_INDEX = "_index.json";

AE.slugify = function (title, shortId) {
  var base = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (!base) base = "chat";
  var id = String(shortId || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  return id ? base + "--" + id : base;
};

AE.firstBattleSubtype = function (payload) {
  var battles = (payload && payload.battles) || [];
  if (!battles.length) return null;
  var sub = battles[0].subtype || "text";
  if (sub === "web-search" || sub === "web_search") return "web-search";
  if (sub === "webdev") return "code";
  if (sub === "image" || sub === "video" || sub === "code" || sub === "text") return sub;
  return "text";
};

AE.archiveRelFor = function (payload, existingRel) {
  if (existingRel) return existingRel;
  var battles = (payload && payload.battles) || [];
  var session = (payload && payload.session) || {};
  var key = session.conversation_key || session.session_id || "unknown";
  var shortId = String(key).replace(/^c:|^s:/, "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  var title = session.title || (battles[0] && battles[0].prompt) || "chat";
  var slug = AE.slugify(title, shortId);
  if (!battles.length) return "agent/" + slug;
  var sub = AE.firstBattleSubtype(payload);
  return "battle/" + sub + "/" + slug;
};

AE.padBattleIndex = function (n) {
  return n < 10 ? "0" + n : String(n);
};

AE.decorateArchivePaths = function (payload, existingRel) {
  payload = payload || {};
  var rel = AE.archiveRelFor(payload, existingRel);
  payload.archive = {
    rel: rel,
    conversation_json: "conversation.json",
    conversation_md: "conversation.md"
  };
  (payload.battles || []).forEach(function (b, i) {
    var idx = i + 1;
    var dir = "battle-" + AE.padBattleIndex(idx);
    b.index = idx;
    b.dir = dir;
    (b.contestants || []).forEach(function (c) {
      if (!c || !c.lane) return;
      c.dir = dir + "/" + c.lane;
      c.response_file = c.dir + "/response.md";
      (c.files || []).forEach(function (f) {
        if (!f || typeof f !== "object") return;
        var name = String(f.path || "file").replace(/^\/+/, "");
        f.archive_path = c.dir + "/" + name;
      });
    });
  });
  return payload;
};

AE.filesToWrite = function (payload) {
  var out = [];
  if (!payload) return out;
  var json = JSON.stringify(payload, null, 2);
  out.push({ path: "conversation.json", encoding: "utf8", content: json });
  if (AE.renderMarkdown) {
    out.push({ path: "conversation.md", encoding: "utf8", content: AE.renderMarkdown(payload) });
  }
  (payload.battles || []).forEach(function (b) {
    (b.contestants || []).forEach(function (c) {
      if (!c) return;
      var resp = c.response || "";
      if (c.response_file) {
        out.push({ path: c.response_file, encoding: "utf8", content: resp });
      }
      (c.files || []).forEach(function (f) {
        if (!f || !f.archive_path) return;
        if (typeof f.content === "string") {
          out.push({ path: f.archive_path, encoding: "utf8", content: f.content });
        }
      });
    });
  });
  return out;
};
