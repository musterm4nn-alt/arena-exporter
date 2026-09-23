# Architecture

Arena Exporter is a local-first Manifest V3 extension. There is no application server, hosted account, analytics service, or runtime dependency.

## Runtime boundaries

1. **MAIN-world capture** — `src/interceptor.js` runs at `document_start` and observes Fetch, XHR, WebSocket, and beacon traffic without consuming the page response.
2. **ISOLATED-world bridge** — `src/content.js` forwards allowlisted events, serves DOM snapshots, collects bounded diagnostics, and performs authenticated history backfill in the page context.
3. **Background runtime** — `src/background.js` is a compatibility composition root. Chrome loads the ordered module list with `importScripts`; Firefox receives the same ordered list in `background.scripts`.
4. **Session correlation** — `src/session-store.js` binds tab, page, conversation, realtime session, and request IDs so late responses cannot cross conversation boundaries.
5. **Reconstruction** — `src/capture.js`, `src/request-capture.js`, and `src/battles.js` turn transport evidence into Agent messages, evaluation lanes, request outcomes, and provenance.
6. **Export/archive** — `src/export-builder.js`, `src/markdown.js`, `src/archive-layout.js`, and the archive sinks produce schema-2.1-compatible JSON/Markdown and destination-aware folder trees.
7. **Backup** — `src/backup-store.js` stores a credential-free IndexedDB outbox; `src/github-backup.js` uploads the newest snapshot for each conversation to a configured private repository.
8. **Interface** — `src/popup.*` and `src/options.*` are dependency-free controllers over the same explicit message boundary.

## Compatibility rules

- The Chrome manifest public key remains unchanged.
- The Firefox add-on ID remains `arena-agent-exporter@local`.
- Export schema remains `2.1` for existing consumers.
- `ae_store_v2`, legacy `ae_state_v1`, archive paths, `_index.json`, and destination-specific hashes remain readable.
- Runtime/UI additions are additive; identifiers are never reinterpreted as model identity.
- Generated `src/injected-*.js` and `firefox/` files are outputs, not hand-edited source.

## Capture correctness

- A failed request is transport metadata, never a synthetic assistant answer.
- Request attempts remain separate across CAPTCHA, rejection, network, and successful retries.
- Stream record IDs and sequence numbers suppress true replay frames.
- Semantic artifact/action dedupe is scoped to one assistant message so repeated work in a later turn survives.
- DOM backfill is bounded, anchored to visible text, and explicitly marked partial.
- Model labels distinguish page selection, public catalog joins, Arena reveals, and unknown identity.

## Local verification limits

The JavaScript harness simulates browser APIs and storage. It does not establish live Arena compatibility, native-host installation, browser-store behavior, or a real GitHub network transaction. Those claims require explicit acceptance runs.
