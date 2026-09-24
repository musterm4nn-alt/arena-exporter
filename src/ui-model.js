/* Pure view data shared by the popup, workspace, and UI regressions. */
(function (root) {
  "use strict";
  const model = {
    arenaUrl: function (value) {
      return /^https:\/\/([\w-]+\.)*(arena|lmarena)\.ai\//i.test(String(value || ""));
    },
    conversationKey: function (value) {
      try {
        const u = new URL(value);
        if (!model.arenaUrl(u.href)) return null;
        const m = /\/(?:c|agent)\/([A-Za-z0-9_-]+)/.exec(u.pathname);
        return m ? "c:" + m[1] : null;
      } catch (_) {
        return null;
      }
    },
    mode: function (value) {
      const m = String(value || "").toLowerCase();
      return /^side.by.side/.test(m) ? "side-by-side" : /^battle/.test(m) ? "battle" : /^direct/.test(m) ? "direct" : "agent";
    },
    modeLabel: function (value) {
      return { agent: "Agent", battle: "Battle", direct: "Direct", "side-by-side": "Side-by-Side" }[model.mode(value)];
    },
    completeness: function (value) {
      const status = String(value || "").toLowerCase();
      if (status === "full" || status === "green") return { label: "Complete", tone: "ok" };
      if (status === "red") return { label: "Needs attention", tone: "error" };
      if (status === "amber" || status === "partial") return { label: "Partial capture", tone: "warn" };
      return { label: "Not assessed", tone: "idle" };
    },
    filterEntries: function (entries, query, mode, sort) {
      const q = String(query || "").trim().toLowerCase();
      return (entries || []).filter(function (entry) {
        return (!mode || mode === "all" || model.mode(entry.mode) === mode) &&
          (!q || [entry.title, entry.rel, entry.key, (entry.models || []).join(" ")].join(" ").toLowerCase().includes(q));
      }).slice().sort(function (a, b) {
        if (sort === "title") return String(a.title || "").localeCompare(String(b.title || ""));
        if (sort === "turns") return (b.turns || 0) - (a.turns || 0);
        return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
      });
    },
    backupLabel: function (status) {
      if (!status || !status.ok) return "Backup status unavailable";
      if (status.error) return "Backup needs attention";
      if (status.running) return "Uploading to GitHub";
      if (!status.connected) return "Connect GitHub backup";
      if (!status.enabled) return "GitHub backup paused";
      if (status.pending) return status.pending + " queued for GitHub";
      return status.lastSuccess ? "Backed up to GitHub" : "GitHub backup ready";
    },
    outcomeLabel: function (value) {
      return { pending: "Pending", a_wins: "A wins", b_wins: "B wins", both_good: "Both good", neither_good: "Neither good", not_applicable: "Not applicable" }[value] || "Pending";
    }
  };
  root.AEView = model;
  if (typeof module !== "undefined" && module.exports) module.exports = model;
})(globalThis);
