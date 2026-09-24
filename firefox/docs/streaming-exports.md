# Streaming exports

Arena Exporter keeps the existing JSON and Markdown downloads and adds JSONL for large conversations.

## JSONL format

The first record is a header:

```json
{"type":"arena.export.header","schema_version":"2.1","export":{},"session":{}}
```

The remaining records are newline-delimited objects with one of these types:

- `message` — one canonical `payload.messages[]` entry
- `battle` — one canonical `payload.battles[]` entry
- `attribution` — one `payload.attribution_samples[]` entry
- `arena.export.footer` — summary and metadata

Each line is a complete JSON object. Consumers can process records without loading the entire conversation into memory. The regular JSON export remains the compatibility format for consumers that expect one document.

`AE.streamExport(payload, "jsonl", sink)` iterates records lazily and awaits each sink write; `AE.streamExport(payload, "markdown", sink)` emits the normalized compatibility rendering as one chunk. The current browser download path still assembles the selected JSONL file before handing it to the browser's download API, but the format and sink are ready for a streaming transport.
