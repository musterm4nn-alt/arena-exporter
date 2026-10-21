# Local library, search, and bulk export

The 3.0 workspace adds an offline layer on top of the archive. It is deliberately small, local, and disposable: the archive folder remains the source of truth.

## What is stored

`src/research-store.js` opens IndexedDB database `arena-research` (version 1) with three object stores:

| Store | Key | Contents |
| --- | --- | --- |
| `records` | `key` | Bounded projection used by search, the reader, and Insights |
| `payloads` | `key` | Exact archived `conversation.json` text, when below the payload cap |
| `state` | `id` | `{id:"status", count, bytes, last_indexed_at}` |

The record is built by `AE.research.buildRecord()` (`src/lib/research.js`) from the exact JSON text written to the archive. It keeps title, URL, mode, subtype, timestamps, models, completeness, warnings, counts, projected messages, projected Battle lanes, file metadata, searchable `text`, and optional `detail` (reasoning and tool evidence). Attachments are never copied; only their metadata is indexed.

Bounds per conversation:

- archived JSON: **4 MiB** (larger payloads keep a record but no exportable payload);
- searchable text: **1 MiB**;
- reasoning/tool detail: **512 KiB**;
- 4,000 projected blocks, 500 files, 50 warnings.

`bytes` in `state` counts the stored record plus the exact payload when it is retained, so the workspace size is not an estimate of the archive on disk. The record keeps `payload_hash` = SHA-256 of the bytes `utf8`, a newline, and `conversation.json`. That is the same hash the archive index stores for `conversation.json`, so Library health can compare the two byte-for-byte.

## When it is written

1. **Automatic.** After a successful plaintext archive write, `src/downloads-sink.js` indexes `conversation.json` inline and records a `library/index_failed` issue if indexing fails. Archive success is not rolled back.
2. **Folder import.** **Library health → Index an archive folder** reads only `conversation.json` files (whole `arena-archive` folder), six files per message, with a 4 MiB per-file cap. The relative path is stored for display; folder actions remain available only when the conversation is also present in the archive index.
3. **Never when encrypted.** If archive encryption is enabled, `AE.researchStore` refuses reads and writes. Enabling encryption clears the library and returns `libraryCleared: true`; the workspace explains that a plaintext index cannot sit beside sealed archives. Disabling encryption does not resurrect old records; re-index the folder.

Downloads are authoritative for the extension, but the library is authoritative for what can be read offline. Removing the library or clearing browser storage does not touch archive files.

## Search

`src/lib/search.js` is pure and runs in the background over records returned by the store.

- Plain terms are ANDed and case-insensitive.
- `"a quoted phrase"` must occur in order.
- `-term` excludes any record containing it.
- Default scope searches title and message text. `scope:"all"` adds reasoning and tool arguments/output.
- Optional filters: `mode`, `model`, `vote` (`any`, `none`, or an outcome), and `days`.
- Results are capped at 200 and carry a bounded snippet plus a score. Title matches weigh more than text matches; detail matches weigh least.
- Empty queries return metadata rows rather than full-text hits.

Search runs in the background (`AE_RESEARCH_SEARCH`) so the workspace never loads every transcript into the page.

## Reader

`src/reader-view.js` renders records returned by `AE_RESEARCH_GET`. It uses `textContent` and text nodes only; captured HTML is never interpreted. Reasoning and tool output are collapsed in `<details>`, Battle rounds render as lanes, and query terms are wrapped in `<mark>`. JSON/Markdown exports replay the stored archive payload, not the projected record, so exported bytes match the archive.

## Insights

`src/lib/insights.js` computes totals, a 12-month activity window plus an `earlier` count, mode distribution, vote outcomes, manual-vote count, pending ballots, unrevealed Battles, model appearances/wins with verification state, completeness distribution, and tool usage. It reads only the library; it never calls Arena.

## Library health

`AE_RESEARCH_VERIFY` rebuilds the archive index and compares it with the library:

- `matched` — library payload hash equals the index hash;
- `mismatched` — both exist but hashes differ;
- `missing` — the archive knows the conversation but the library does not;
- `orphaned` — the library has a record the archive index does not;
- `stale` — the archive entry is newer than the library record;
- `unchecked` — no payload or hash is available to compare.

Pruning removes orphaned records only. Clearing removes the three local object stores; it never deletes archive files, GitHub backups, or preferences. Like any browser storage deletion, it is not a secure erase of the underlying disk.

## Bulk export

The workspace exports **the current filtered list**. Records without a stored payload are omitted with a reason. Files are written in batches of four conversations through `AE_RESEARCH_EXPORT_DATA` (hard cap: 12 keys per message), which keeps each extension message well below browser structured-clone limits.

`src/lib/zip.js` builds a deterministic, dependency-free ZIP:

- entries are **stored** (method 0), not deflated;
- timestamps come from one explicit date;
- UTF-8 names and CRC-32 are written explicitly;
- no ZIP64, so the whole selection is capped at 128 MiB before building.

`src/lib/bulk.js` provides folder names, collision suffixes, a deterministic `manifest.json`, and a bundle path for each conversation. Manifest shape:

```json
{
  "format": "arena-exporter-bulk-export/1",
  "schema_version": "2.1",
  "created_at": "2026-10-21T10:00:00.000Z",
  "extension_version": "3.0.0",
  "scope": "filtered library",
  "conversation_count": 2,
  "file_count": 4,
  "omitted_count": 1,
  "conversations": [
    {
      "key": "c:…",
      "title": "…",
      "mode": "agent",
      "updated_at": "…",
      "folder": "agent/…",
      "files": [{ "name": "conversation.json", "bytes": 1234, "sha256": "…" }]
    }
  ],
  "omitted": [{ "key": "c:…", "title": "…", "reason": "not_in_archive" }]
}
```

The archive layout under `agent/`, `battle/`, `direct/`, and `side-by-side/` is preserved so an exported bundle can be re-imported or read by other tooling.

## Message boundary

All library messages are handled only in `AE.handleWorkspaceMessage` (`src/runtime-services.js`) and are accepted only from the extension's own popup or options page. The message set is: `AE_RESEARCH_STATUS`, `LIST`, `SEARCH`, `GET`, `HAS`, `INSIGHTS`, `VERIFY`, `IMPORT`, `CLEAR`, `REMOVE`, `EXPORT`, `EXPORT_DATA`. Adding a library message anywhere else would bypass the sender checks.

## Limits

- IndexedDB is per browser profile; clearing site data removes the library.
- Records are bounded projections, not replicas. Use exports for the complete payload.
- The library does not index attachments' bytes, and does not run OCR or file-content search.
- No sync across devices; GitHub backup covers archive files, not library records.
