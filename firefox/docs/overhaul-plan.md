# Arena Exporter 2.1.0 implementation plan

## Outcome

A complete Chrome and Firefox extension for capturing, exporting, archiving and backing up Arena conversations, with a new Departure Mono interface. Preserve the existing extension identity, archive layout, storage keys, private-backup configuration and schema 2.1 compatibility.

## Implementation sequence

1. **Recover the reliable foundation.** Use the tested 1.18.0 transport, normalization, request correlation, attachment, native host and GitHub queue components. Retain the existing test fixtures. Preserve the experimental 2.0.0 and stable 1.18.0 folders before installing the completed overhaul.
2. **Reorganize the runtime.** Separate capture, export assembly, download completion and message routing. Make export construction take an explicit session. Add an actual per-session parse cache, serialized persistence, saved automatic-archive preferences, bounded diagnostics and event notifications for the interface. Port v2's useful redaction fixes.
3. **Rebuild the popup.** Departure Mono, dark ink surfaces, warm white text and cyan emphasis. Give the current conversation, capture health and archive/backup outcomes clear hierarchy. Add scoped JSON/Markdown export, last-turn export, copy, archive and folder actions. Put vote correction, history and diagnostics behind progressive disclosure. Provide honest empty, streaming, success, partial and error states.
4. **Build the archive workspace.** A responsive full-page library with search, mode filters, sorting and pagination; conversation and folder actions; separate backup, preferences and diagnostics views. Preserve GitHub connection, retry, pause/resume and existing-folder import. No conversation text or credentials in diagnostic reports.
5. **Verify behavior.** Run inherited regression suites plus meaningful coverage for new preferences, explicit sessions, parse caching, write serialization, redaction, Markdown, library routing and UI actions. Render the actual UI with synthetic browser APIs; inspect popup, library, backup and narrow layouts and exercise controls.
6. **Package and deliver.** Produce deterministic 2.1.0 Chrome and Firefox ZIPs, update documentation and local versioned folders, retain recovery copies, place the Firefox ZIP on the Desktop, and update the authorized source repository if the available GitHub access supports it. Document any unperformed live-browser or native-app checks accurately.

## Acceptance gates

- Capture does not consume the page's response; turns and tabs remain separate.
- Last-turn exports do not reintroduce older messages or unrelated battle rounds.
- Files retain their hierarchy within the correct conversation folder; failed downloads never report success.
- Worker restoration preserves capture state, archive index and backup queue.
- Existing v1 features remain usable in both distribution manifests.
- Every visible action is wired, with busy/error feedback and keyboard focus.
- Departure Mono is bundled locally with its license; no remote fonts or runtime dependencies.
- Release builds and regression tests pass; visual checks are recorded with their limits.

## Architecture decision

This replaces the defective 2.0.0 capture/archive implementation with the proven components, then refactors and extends them. It does not ship two competing engines. Classic background modules remain compatible with Firefox's ordered background scripts; a small composition entry point owns their load order. The visual redesign is implemented directly in extension HTML/CSS/JavaScript without a framework or build-time package download.

## Execution record

- Plan written before implementation. Work staged in `overhaul/` so the installed sources remain available during development.
- Steps 1–4 implemented: one proven capture/archive engine, split runtime responsibilities, explicit sessions, serialized saves, actual parse caching, saved preferences and the new popup/workspace controllers.
- Automated verification passes 19 JavaScript suites, including both generated browser manifests and Firefox background loading. The new UI handlers are exercised with synthetic document/browser fixtures.
- Live visual and installed-browser smoke checks could not run: the in-app browser was unavailable and browser discovery returned no connected browsers. This remains a verification limit, recorded in `verification.md`; no live-rendering pass is claimed.
- Chrome/Firefox packaging and local/repository delivery are the final execution steps.
