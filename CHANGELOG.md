# Changelog

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
