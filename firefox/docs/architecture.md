# Arena Exporter architecture

Arena Exporter 2.2 keeps the browser extension as the product. There is no application server, hosted account system, or database dependency. The presentation site under `site/` is deliberately separate from extension runtime and packaging.

## Runtime boundaries

The background worker remains a small composition root because Firefox consumes the same ordered modules as background scripts. The important boundaries are:

1. **Raw interception** — `src/interceptor.js` starts in the page MAIN world at `document_start`, clones Fetch/XHR responses and emits bounded capture events without consuming Arena's own streams.
2. **Transport parsing** — `src/lib/evaluation-stream.js`, `src/lib/normalize.js` and page-data helpers turn SSE, NDJSON, RSC/evaluation frames and UI messages into typed evidence.
3. **Session correlation** — `src/session-store.js` owns tab/page/request aliases. An initiating request retains its conversation key so a late response cannot follow a tab to a different conversation.
4. **Request outcomes** — `src/request-capture.js` records attempts independently from assistant output. Retries, selection rejection, CAPTCHA rejection, HTTP/network failures and completion remain distinguishable.
5. **Conversation reconstruction** — `src/capture.js` and `src/battles.js` reconstruct Agent messages and evaluation lanes. Replayed transport frames are deduplicated, while semantic block dedupe is scoped to a single message so an identical artifact/action in a later turn is still preserved.
6. **Model attribution** — `src/attribution.js` separates requested IDs, catalog labels and verified Arena reveals. UUIDs and transport identifiers are never interpreted as hidden model identity.
7. **Privacy** — `src/lib/privacy.js` structurally traverses captured values, nested JSON strings and URLs before persistence/export. `src/lib/dom-extract.js` owns redacted page diagnostics.
8. **Persistence** — `src/session-store.js` serializes session writes; archive modules serialize archive-index changes and key hashes by destination.
9. **Archive/export** — `src/export-builder.js`, `src/markdown.js` and archive sinks produce schema-2.1-compatible JSON/Markdown and conversation folder trees.
10. **Backup** — `src/backup-store.js` and `src/github-backup.js` keep a durable, credential-free outbox and write only to a configured private GitHub repository.
11. **Browser integration/UI** — `src/message-router.js`, `src/runtime-services.js`, `src/ui-state.js` and the popup/workspace controllers expose explicit session state and real actions.

## Compatibility contract

The 2.2 release intentionally keeps:

- the Chrome/Chromium manifest public key and resulting unpacked extension identity;
- Firefox ID `arena-agent-exporter@local`;
- schema version `2.1`;
- `ae_store_v2` and legacy `ae_state_v1` state loading;
- existing archive folder semantics and `_index.json`;
- destination-specific archive hashes;
- existing JSON fields and unknown archive files;
- optional native host `com.arenaarchive.host`;
- private GitHub repository backup semantics.

Schema 2.1 remains the interchange contract. New runtime/UI state is additive and is not used to reinterpret old identifiers.

## Capture correctness rules

Data preservation takes priority over compactness:

- user and assistant turns are not collapsed across rounds;
- Direct has one lane, Side-by-Side has two, Battle has two anonymous/revealed lanes;
- a failed request is transport metadata, not an assistant message;
- request IDs bind late responses to the conversation that initiated them;
- per-record sequence/IDs handle replayed realtime batches;
- within a message, exact non-text semantic replays are suppressed, but the same artifact/action may legitimately appear again in a later message;
- a Battle reveal can label earlier rounds only within the same evaluation conversation and records propagated provenance;
- DOM backfill only adds visible messages around text anchors and emits an explicit completeness warning.

## Build shape

`tools/build-release.mjs` creates distinct MAIN/ISOLATED content-script bundles, then emits reproducible Chrome and Firefox packages. The static site is not included in either extension package.

Run:

    npm test
    npm run build
    npm run site:check

The test command regenerates both browser builds before running every JavaScript suite.
