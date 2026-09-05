# Changelog

## 2.1.0 — 2026-09-05

- Rebuilt the popup and full-page workspace around locally bundled Departure Mono, ink surfaces, warm white text and cyan accents. Added keyboard focus, responsive layouts, explicit empty/error states and reduced-motion support.
- Added a searchable archive library with mode filters, sorting, pagination, Arena links and per-conversation folder actions. Split GitHub backup, preferences and diagnostics into dedicated views.
- Added full-conversation and last-answer JSON/Markdown export and clipboard actions, persistent automatic-archive controls, backup pause/resume and a diagnostics report that excludes conversation content.
- Replaced the experimental 2.0.0 engine with the verified 1.18.0 capture, archive, history, native-host and GitHub-backup components. Preserved v1 storage keys, extension identity, archive layout and schema 2.1 compatibility.
- Separated capture, export assembly, UI state, export downloads and message routing. Background exports use explicit sessions. Added serialized persistence and a working per-session evaluation parse cache.
- Last-answer exports also scope request metadata and exclude earlier raw transport samples. Added underscore-bearing Bearer and sk-key redaction with stable redaction markers.
- Replaced idle popup polling and recurring toolbar native probes with event updates. Added runtime issue codes and truthful save/backup outcomes.
- Built dedicated Chrome and Firefox distributions from the same source. Expanded regression coverage for popup/workspace actions, preferences, restart, caching, persistence and data isolation.
- Validation: automated suites and generated Firefox background loading pass. Browser-control access was unavailable for live rendering and installed-extension tests; those checks are not claimed. See docs/verification.md.

## 1.18.0 — 2026-09-04

- Added optional automatic backups to a private GitHub repository, with repository-scoped token setup, status, pause/disconnect, manual upload and existing-folder import.
- Keep the newest pending snapshot per conversation in IndexedDB, retry offline failures, and preserve newer turns when an older upload finishes.
- Upload only changed files, merge the remote archive index, preserve unrelated remote files and retry concurrent branch changes without force-pushing.
- Added an Open conversation folder button for the selected Arena tab. Downloads folders open in the system file manager; external native archives show their actual path.
- Added optional GitHub host/data permissions and a browser alarm for queued uploads. Backups stay disabled until connected.
- Preserved the Firefox last-message download fix. Added backup failure/concurrency/privacy tests, selected-tab folder tests, and a real-browser IndexedDB/import fixture.

## 1.17.1 — 2026-09-04

- Fixed Firefox JSON exports revoking their Blob URL before the browser finished consuming it, which could cause an extension download error.
- Wait for download completion before reporting success, and surface interrupted JSON or attachment downloads.
- Respect cancellation of the Save As dialog instead of retrying silently.
- Added a regression test covering the actual last-message save flow, delayed download completion, interruption, cancellation, and already-completed downloads.

## 1.17.0 — 2026-09-03

### Capture integrity

- Isolated sessions by tab, page conversation, transport session, and initiating request so concurrent chats and late responses cannot mix.
- Correlated evaluation streams by request ID, retained arbitrary AI SDK part IDs, handled fragmented SSE prefixes and all common line endings, and preserved the original Fetch response for the page.
- Recognized logical `finish` and `turn-complete` records, retained assistant node metadata, deduplicated large realtime replays, and triggered archive sync without waiting for a long-lived HTTP connection to close.
- Recorded retries separately, including CAPTCHA failures, explicit selection rejections, HTTP/network errors, aborts, and successful completion. Failed attempts do not create outputs.

### Modes and attribution

- Added Direct and Side-by-Side export while preserving the server's raw mode. Direct has one lane and no vote; Side-by-Side has two selected lanes.
- Read the public SSR Flight model catalog and joined requested model UUIDs to public selection labels without treating catalog flags as access controls.
- Kept Agent identity unknown unless Arena explicitly reveals it. Incidental network fields, selector flags, leaderboard aggregates, and UUIDs remain diagnostic metadata rather than model identity.
- Separated requested IDs, catalog fields, display labels, message/node IDs, and transport identifiers. Added explicit model provenance and verification fields.
- Preserved transcript pagination and assistant metadata from completed Agent page data.

### Privacy and archives

- Filtered CAPTCHA values, authorization data, cookies, keys, credentials, token families, JWTs, and nested/raw credential text before persistence and export.
- Redacted short page text and text-bearing attributes from DOM debug captures.
- Serialized full archive index transactions to prevent concurrent lost updates, scoped hashes to each Downloads/native destination, retried mirror failures, and exposed storage failures to the popup.
- Added archive roots for Direct and Side-by-Side and limited Agent workspace ZIP retrieval to Agent exports.

### Packaging

- Bumped the extension and export metadata to 1.17.0 / schema 2.1.
- Added a complete generated Firefox tree with ordered background scripts.
- Added a dependency-free reproducible release builder for unpacked folders and ZIPs, plus a cross-platform JavaScript test runner.

The 2.1 schema is additive. Existing `messages`, `battles`, and `attribution_samples` consumers can continue reading their established fields.
