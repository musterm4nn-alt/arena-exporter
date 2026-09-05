/* Arena Exporter: composition root. Firefox uses this same ordered list. */
if (typeof importScripts === "function") {
  importScripts("lib/schema.js", "lib/privacy.js", "lib/page-data.js", "lib/normalize.js", "lib/evaluation-stream.js", "session-store.js", "request-capture.js", "battles.js", "attribution.js", "archive-layout.js", "capture-health.js", "markdown.js", "downloads-sink.js", "native-sink.js", "backup-store.js", "github-backup.js", "turn-sync.js", "archive-folder.js", "history-backfill.js", "status-led.js", "runtime-services.js", "capture.js", "export-builder.js", "ui-state.js", "export-download.js", "message-router.js");
}
