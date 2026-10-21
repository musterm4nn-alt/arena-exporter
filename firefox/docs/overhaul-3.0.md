# 3.0 overhaul notes

3.0 turns Arena Exporter from a capture-and-download tool into a capture, archive, and
offline-reading tool, without giving up the local-first model or adding runtime
dependencies.

## Goals

1. Make saved conversations readable and searchable without returning to Arena.
2. Close the most useful capability gaps identified against Arena Suite while staying
   inside Manifest V3 constraints.
3. Keep the archive folder, export schema 2.1, storage keys, and encryption format
   compatible with 2.2.
4. Add useful capabilities that were not in either project where they fit the same
   privacy model.

## Borrowed from Arena Suite

Arena Suite is a native macOS archive application. Its reader, search, Insights, and
bulk-export ideas were the basis for the workspace work; its native journal, FTS5 index,
dataset pipeline, MCP server, multi-account isolation, and embedded web view are not
portable to an extension and were deliberately not imitated.

| Arena Suite capability | 3.0 equivalent | Difference |
| --- | --- | --- |
| Transcript reader with reasoning/tools/lanes | `src/reader-view.js` | Renders from a bounded local record; images open from the archive folder |
| Full-text search over the archive | `src/lib/search.js` | In-memory over indexed records, not FTS5 |
| Filters and vote/model facets | Library filters | Same useful axes, no dataset recipes |
| Insights | `src/lib/insights.js` | Local library only |
| Bulk export with manifest and SHA-256 | `src/lib/zip.js`, `src/lib/bulk.js` | Export the current filtered set as one ZIP; 128 MiB cap |
| Library maintenance | Library health | Hash verification against `_index.json`, not a journal |

## Self-directed additions

- **Library health verification** compares stored payload hashes with the archive index
  and reports missing, orphaned, stale, mismatched, and unchecked entries.
- **Folder indexing** turns an existing `arena-archive` folder into a searchable library
  without re-downloading anything.
- **Popup integration** shows how many conversations are readable offline and deep-links
  the current conversation into the reader.
- **Deterministic stored-entry ZIP** avoids a compression dependency and keeps exports
  inspectable with standard tools.
- **Explicit omission reasons** in `manifest.json` instead of silently skipping
  conversations the library cannot export.
- **Per-conversation reader exports** copy or download the exact archived JSON/Markdown.

## Design decisions

- The archive stays authoritative. The library is a bounded cache that can be rebuilt.
- The exact `conversation.json` text is retained up to 4 MiB so exports and hash
  verification are byte-identical to the archive.
- Plaintext library records are never kept when archive encryption is enabled; enabling
  encryption clears the library and blocks new indexing.
- Library messages are handled only in `AE.handleWorkspaceMessage` and only for the
  extension's own popup/options pages.
- No new permissions, runtime dependencies, remote assets, or network services.
- Reader rendering uses text nodes only; captured HTML is never injected.

## Non-goals

- Native macOS performance, FTS5, journal durability, or multi-account isolation.
- An MCP server, dataset recipes, or a native app replacement.
- Indexing attachment bytes, OCR, or file-content search.
- Cross-device sync of the library (GitHub backup covers archive files only).
- Changing export schema 2.1 or the encrypted bundle format.

## Verification

`npm test` builds both packages, runs all JavaScript suites (including synthetic
IndexedDB), validates the project and schema, and is followed by `npm run lint`. See
[verification.md](verification.md) for the limits of simulated browser tests.
