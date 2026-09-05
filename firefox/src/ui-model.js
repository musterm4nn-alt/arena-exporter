/* Pure view data; shared by both extension documents and UI regressions. */
(function (root) {
  "use strict";
  var model = {
    arenaUrl: function (value) { return /^https:\/\/([\w-]+\.)*(arena|lmarena)\.ai\//i.test(String(value || "")); },
    conversationKey: function (value) {
      try { var u = new URL(value); if (!model.arenaUrl(u.href)) return null;
        var m = /\/(?:c|agent)\/([A-Za-z0-9_-]+)/.exec(u.pathname); return m ? "c:" + m[1] : null;
      } catch (_) { return null; }
    },
    mode: function (value) { var m = String(value || "").toLowerCase(); return /^side.by.side/.test(m) ? "side-by-side" : /^battle/.test(m) ? "battle" : /^direct/.test(m) ? "direct" : "agent"; },
    modeLabel: function (value) { return {agent:"Agent",battle:"Battle",direct:"Direct","side-by-side":"Side-by-Side"}[model.mode(value)]; },
    filterEntries: function (entries, query, mode, sort) {
      var q = String(query || "").trim().toLowerCase();
      return entries.filter(function (e) {
        return (!mode || mode === "all" || model.mode(e.mode) === mode) &&
          (!q || [e.title,e.rel,e.key,(e.models || []).join(" ")].join(" ").toLowerCase().includes(q));
      }).slice().sort(function (a,b) {
        if (sort === "title") return String(a.title).localeCompare(String(b.title));
        if (sort === "turns") return (b.turns || 0) - (a.turns || 0);
        return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
      });
    },
    backupLabel: function (s) {
      if (!s || !s.ok) return "Backup status unavailable";
      if (s.error) return "Backup needs attention";
      if (s.running) return "Uploading to GitHub";
      if (!s.connected) return "Connect GitHub backup";
      if (!s.enabled) return "GitHub backup paused";
      if (s.pending) return s.pending + " queued for GitHub";
      return s.lastSuccess ? "Backed up to GitHub" : "GitHub backup ready";
    }
  };
  root.AEView = model;
  if (typeof module !== "undefined" && module.exports) module.exports = model;
})(globalThis);
