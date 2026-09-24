# Local delivery plan: native host through release pipeline

This branch implements the six follow-up improvements locally. Nothing in this plan is pushed to GitHub.

1. **Native messaging host** — implemented as `ArenaArchiveHost`, `NativeHostCore`, Swift tests, a local manifest installer, and byte-bounded native write batching.
2. **Real browser-extension acceptance** — implemented as `tools/acceptance.mjs`: dependency-free HTTP smoke plus optional Playwright Chromium and unpacked-extension modes.
3. **Versioned JSON Schema** — implemented as `schemas/export-2.1.schema.json` with `schema:check` and a generated-payload regression.
4. **Encrypted local archives** — implemented as optional AES-GCM/PBKDF2 `conversation.enc` bundles, verifier-only persistence, lock/unlock states, and a recovery CLI.
5. **Streaming exports** — implemented as JSONL records plus reusable Markdown/JSONL chunk iteration and popup download support.
6. **Local release pipeline** — implemented as `tools/release-local.mjs` with tests/builds, SHA-256 checksums, release manifest, optional OpenSSL detached signatures, and optional native-host installation.

## Invariants

- Chrome public key, Firefox ID, schema 2.1, storage keys, and archive paths remain compatible.
- No credentials enter exports, diagnostics, or the backup outbox.
- Existing tests remain green; new features are opt-in where they change user data or security behavior.
- Generated Firefox files are rebuilt from root source.
