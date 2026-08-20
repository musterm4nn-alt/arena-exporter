/* Shared constants for Arena Agent Exporter.
 * Loaded by both the content-script world (as a classic script) and the
 * service worker (via importScripts). Everything hangs off the global `AE`. */
var AE = AE || {};

AE.SCHEMA_VERSION = "2.0";

/* postMessage bridge type between MAIN-world interceptor and ISOLATED content script */
AE.MSG_NS = "__ARENA_EXPORTER_EVT__";

/* Canonical block types used in the export schema */
AE.BLOCK_TYPES = [
  "thinking",    // chain-of-thought text
  "text",        // visible message text (markdown)
  "tool_call",   // tool invocation with arguments
  "tool_result", // output of a tool invocation
  "command",     // shell/terminal command + output
  "action",      // higher-level agent action (create_file, navigate, ...)
  "artifact"     // produced files / images / reports
];

AE.ROLES = ["user", "assistant", "system", "tool"];

/* Canonical battle-vote choices. A/B identify a single preferred lane;
 * both_good and neither_good preserve the two non-singular ballot outcomes. */
AE.BATTLE_VOTE_CHOICES = ["A", "B", "both_good", "neither_good"];

AE.isPlaceholderModel = function (name) {
  var t = String(name == null ? "" : name).replace(/\s+/g, " ").trim();
  if (!t) return true;
  return /^(?:response|model|assistant|lane|player|option)\s*[ab]$/i.test(t);
};

