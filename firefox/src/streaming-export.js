/* Streaming-friendly export helpers. JSONL is newline-delimited so large
 * conversations can be consumed incrementally by downstream tools. */
var AE = AE || {};
(function () {
  "use strict";

  function* jsonlRecordIterator(payload) {
    payload = payload || {};
    yield {
      type: "arena.export.header",
      schema_version: payload.schema_version || AE.SCHEMA_VERSION || "2.1",
      export: payload.export || {},
      session: payload.session || {}
    };
    for (var i = 0; i < (payload.messages || []).length; i++) yield { type: "message", message: payload.messages[i] };
    for (var j = 0; j < (payload.battles || []).length; j++) yield { type: "battle", battle: payload.battles[j] };
    for (var k = 0; k < (payload.attribution_samples || []).length; k++) yield { type: "attribution", sample: payload.attribution_samples[k] };
    yield { type: "arena.export.footer", summary: payload.summary || {}, meta: payload.meta || {} };
  }

  AE.jsonlRecordIterator = jsonlRecordIterator;
  AE.jsonlRecords = function (payload) { return Array.from(jsonlRecordIterator(payload)); };
  AE.forEachJsonlRecord = function (payload, callback) {
    for (var record of jsonlRecordIterator(payload)) callback(record);
  };
  AE.iterateJsonl = function (payload) {
    var lines = [];
    for (var record of jsonlRecordIterator(payload)) lines.push(JSON.stringify(record));
    return lines;
  };
  AE.renderJsonl = function (payload) {
    return AE.iterateJsonl(payload).join("\n") + "\n";
  };

  AE.streamExport = async function (payload, format, sink) {
    if (format === "markdown") {
      // Preserve the exact compatibility rendering (including blank-line
      // normalization) while exposing a transport-shaped async operation.
      var markdown = AE.renderMarkdown(payload);
      var markdownBytes = new TextEncoder().encode(markdown).byteLength;
      if (typeof sink === "function") await sink(markdown, 0);
      return { chunks: 1, bytes: markdownBytes, format: "markdown" };
    }
    var count = 0, bytes = 0;
    for (var record of jsonlRecordIterator(payload)) {
      var chunk = JSON.stringify(record) + "\n";
      bytes += new TextEncoder().encode(chunk).byteLength;
      count++;
      if (typeof sink === "function") await sink(chunk, count - 1);
    }
    return { chunks: count, bytes: bytes, format: "jsonl" };
  };
})();
