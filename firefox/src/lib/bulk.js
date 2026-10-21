/* Naming and manifest for bulk library export. Pure so the format can be
 * pinned by tests; the caller supplies already-computed SHA-256 values.
 */
var AE = AE || {};
(function () {
  "use strict";

  const FORMAT = "arena-exporter-bulk-export/1";

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function stamp(date) {
    const d = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " +
      pad(d.getHours()) + "." + pad(d.getMinutes()) + "." + pad(d.getSeconds());
  }

  function slug(value) {
    return String(value == null ? "" : value).toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "conversation";
  }

  function keyTail(key) {
    return String(key || "").replace(/^c:/, "").replace(/[^a-zA-Z0-9-]/g, "").slice(-12) || "unknown";
  }

  function safeRel(rel) {
    const value = String(rel == null ? "" : rel).replace(/\\/g, "/").replace(/^\/+/, "");
    if (!value) return null;
    const parts = value.split("/");
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i] || parts[i] === "." || parts[i] === "..") return null;
    }
    return parts.join("/");
  }

  function bundlePath(entry, used) {
    used = used || new Set();
    const rel = safeRel(entry && entry.rel);
    const base = rel || (slug(entry && entry.title) + "--" + keyTail(entry && entry.key));
    let candidate = base, n = 2;
    while (used.has(candidate)) { candidate = base + "-" + n; n++; }
    used.add(candidate);
    return candidate;
  }

  function manifest(input) {
    input = input || {};
    const conversations = (input.conversations || []).map(function (conversation) {
      return {
        key: conversation.key,
        title: conversation.title || "Untitled conversation",
        mode: conversation.mode || "unknown",
        updated_at: conversation.updated_at || null,
        folder: conversation.folder,
        files: (conversation.files || []).map(function (file) {
          return { name: file.name, bytes: file.bytes, sha256: file.sha256 };
        })
      };
    });
    const omitted = (input.omitted || []).map(function (item) {
      return { key: item.key, title: item.title || "Untitled conversation", reason: item.reason };
    });
    return {
      format: FORMAT,
      schema_version: "2.1",
      extension_version: input.extension_version || null,
      created_at: input.created_at || new Date().toISOString(),
      scope: input.scope || "library",
      conversation_count: conversations.length,
      file_count: conversations.reduce(function (sum, item) { return sum + item.files.length; }, 0),
      omitted_count: omitted.length,
      conversations: conversations,
      omitted: omitted
    };
  }

  AE.bulk = { FORMAT: FORMAT, folderName: function (date) { return "Arena Exporter export " + stamp(date); }, stamp: stamp, bundlePath: bundlePath, manifest: manifest };
  if (typeof module !== "undefined" && module.exports) module.exports = AE.bulk;
})();
