# Arena Exporter

**Version 3.0.0** is a local-first Manifest V3 extension for keeping [arena.ai](https://arena.ai) Agent, Battle, Direct, and Side-by-Side conversations. It captures every turn as it streams, writes a structured archive, and adds a searchable offline library you can read, verify, and export without returning to Arena.

Arena Exporter records streamed text, reasoning and tool evidence, files, request outcomes, transport metadata, and model-label provenance. It keeps the page's own response intact and never treats a failed request as an assistant answer.

## What changed in 3.0

- **Offline library.** Plaintext archives are projected into a bounded local library (IndexedDB) as they are saved, so conversations can be searched and read without network access.
- **Full-text search and filters.** Search message text, titles, models, and optionally reasoning/tool evidence. Quoted phrases and `-exclusions` are supported. Filter by mode, model, vote outcome, and date.
- **Reader workspace.** A seven-view workspace (`Library`, `Reader`, `Insights`, `Library health`, `GitHub backup`, `Preferences`, `Diagnostics`) with deep links such as `#read/<key>`, per-conversation JSON/Markdown export, clipboard copy, and a link back to Arena.
- **Insights.** Activity by month, mode mix, model appearances and wins, ballot and manual-vote outcomes, capture-completeness distribution, and tool usage.
- **Library health.** Verify every stored payload against the SHA-256 recorded in the archive index; report missing, orphaned, stale, and mismatched entries; index an existing `arena-archive` folder; prune orphans; or clear the library.
- **Bulk export.** Export the current filtered list as one deterministic ZIP with `manifest.json`, `conversation.json`, `conversation.md`, per-file SHA-256 hashes, and explicit reasons for omitted conversations.
- **Popup integration.** The popup shows whether the current conversation is readable offline and opens it directly in the reader.
- **Privacy by construction.** The local library is plaintext and never uploaded. Enabling encrypted archives clears it, because a plaintext index must not sit beside sealed files.
- Retained from 2.2: live capture, JSON/JSONL/Markdown export, per-turn auto-archive, encrypted bundles, GitHub private backup, battle-vote correction, history backfill, redacted diagnostics, and export schema **2.1**.

## Install

### Chrome / Chromium

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository root, or build and unzip `dist/Arena-Agent-Exporter-3.0.0-chrome.zip`.
3. Reload the extension and the Arena tab.

The manifest public key is retained so an unpacked installation keeps its identity.

### Firefox

Firefox uses the generated tree under `firefox/`:

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on** and select `firefox/manifest.json`, or use the generated Firefox ZIP.
3. Reload the Arena tab.

Firefox requires version 140 or later. Temporary add-ons must be loaded again after a browser restart.

## Capture and export

The interceptor starts at `document_start`. Open an Arena conversation, then use the popup:

- **Full conversation** or **Last answer** export scope
- JSON, Markdown, or JSONL download
- Copy to clipboard
- **Save now** for an immediate archive write
- Automatic archive of completed turns
- Archive folder reveal/recovery
- Battle vote correction
- Redacted page diagnostics
- **Read in library** when the conversation is indexed locally

A logical stream completion or `turn-complete` record schedules an archive write. Retries remain separate across CAPTCHA challenges, selection rejection, network failures, and successful retries. Tabs and late responses remain associated with the conversation that initiated them.

## Archive workspace

Open the workspace from the popup, the extension's options page, or `chrome-extension://<id>/src/options.html`.

- **Library** lists archive-index entries and local-library records together. Rows marked `Readable` open in the reader; other rows link back to Arena. Search is debounced and searches titles and metadata immediately, then content when the conversation is indexed.
- **Reader** renders messages, reasoning, tool calls, Battle lanes, outcomes, and file metadata. All captured content is written with text nodes, never injected as HTML. Query terms are highlighted with `<mark>`.
- **Insights** summarises the library without sending it anywhere.
- **Library health** compares the local library with `_index.json`, verifies payload hashes, and can index an existing archive folder.
- **Bulk export** exports exactly what the current filters show, up to 128 MiB. Conversations without a stored payload are listed in `manifest.json` with a reason instead of being silently dropped.
- **GitHub backup**, **Preferences**, and **Diagnostics** keep their 2.2 behaviour.

Search syntax: plain words are **AND**ed; `"a quoted phrase"` must appear in order; `-word` excludes. By default only message text and titles are searched. Tick **Include reasoning & tools** to search reasoning, tool arguments, and tool output as well.

The local library is bounded per conversation (4 MiB of archived JSON, 1 MiB of searchable text). Larger conversations remain in the archive folder and can be exported from the popup, but are not copied into browser storage. See [docs/library.md](docs/library.md) and [docs/overhaul-3.0.md](docs/overhaul-3.0.md).

## Model identity

Model UUIDs, page catalog labels, message IDs, and transport IDs are intentionally distinct.

- Battle labels are marked verified only after Arena reveals them.
- Direct and Side-by-Side selection labels may come from the public page catalog and remain unverified.
- Agent orchestrator identity remains unknown unless Arena explicitly reveals it.
- Incidental UUIDs, selector flags, tool arguments, and leaderboard data never become model identity.

See [docs/export-schema.md](docs/export-schema.md) for the schema contract and [`schemas/export-2.1.schema.json`](schemas/export-2.1.schema.json) for the machine-readable contract. [docs/architecture.md](docs/architecture.md) documents runtime boundaries.

## Privacy

The extension filters known credential keys, authorization headers, cookies, CAPTCHA values, API keys, access/refresh/session tokens, JWTs, GitHub token forms, private-key blocks, and credential-bearing URLs before persistence and export. Only three bounded diagnostic response headers are retained:

- `x-session-settled`
- `x-stream-version`
- `x-arena-chat-id`

Conversation exports intentionally contain conversation content and files. Credential filtering is not general anonymization. The local library is plaintext, stays in this browser profile, is excluded from GitHub backup, and is cleared when archive encryption is enabled. See [docs/security.md](docs/security.md).

## Archive layout

Archive encryption is opt-in from **Preferences → Private archives**. It derives separate AES-GCM key and verifier values with PBKDF2-SHA-256, stores no password or AES key, and pauses new saves when locked. Encrypted conversations are written as a `conversation.enc` bundle. Disabling encryption requires the current password; known plaintext archive files cause a migration warning instead of being silently mixed with sealed files. Native-host bundles remain subject to the documented 32 MiB per-file limit. Enabling encryption also clears the local library and disables new plaintext indexing until encryption is turned off. Use the recovery tool for sealed bundles:

```bash
# PowerShell (or use ARENA_ARCHIVE_PASSWORD=... on POSIX shells)
$env:ARENA_ARCHIVE_PASSWORD="your-password"
node tools/decrypt-archive.mjs path/to/conversation.enc --out path/to/recovered
```

Archive index metadata such as titles and URLs remains visible in the local index; the sealed bundle protects conversation files and attachments.

Without the optional native app, `chrome.downloads` writes below `Downloads/arena-archive/`:

```text
agent/<slug>/
  conversation.json
  conversation.md
  files/
direct/<subtype>/<slug>/
side-by-side/<subtype>/<slug>/
battle/<subtype>/<slug>/
  conversation.json
  conversation.md
  battle-01/A/
  battle-01/B/
```

The first successful write pins a conversation to one folder. The index tracks content hashes separately for Downloads and each native root, so switching destinations writes a complete copy without corrupting the other destination's cache.

The Downloads data-URL fallback is intentionally bounded. Large attachments may require the optional native archive app, which has a larger per-file limit.

## Optional Arena Archive app

The browser extension can use the native host `com.arenaarchive.host` when installed. Missing host, failed handshake, or no selected folder falls back to Downloads. Build the local macOS reader and host:

```bash
cd macos/ArenaArchive
swift build -c release
swift run ArenaArchive
swift test
```

Install the local host manifest without contacting a remote service:

```bash
node tools/install-native-host.mjs --host "$PWD/macos/ArenaArchive/.build/release/ArenaArchiveHost" --browser chrome
node tools/install-native-host.mjs --host "$PWD/macos/ArenaArchive/.build/release/ArenaArchiveHost" --browser firefox
```

## GitHub backup

Open **Archive workspace → GitHub backup** to connect a private repository. New archive writes enter a durable IndexedDB outbox, upload changed files only, preserve remote history, retry transient failures, and use non-forced ref updates. Tokens stay in trusted extension storage and never enter exports, the local library, or the outbox.

Use a fine-grained token limited to the archive repository with **Contents: read and write**. Existing folders can be imported through the folder picker. See [docs/github-backup.md](docs/github-backup.md).

## Build and verify

Requires Node.js 20 or newer. The project has no runtime npm dependencies.

```bash
npm test                   # build both packages, run every JS suite, project + schema checks
npm run build              # generate Chrome/Firefox folders and reproducible ZIPs
npm run check:project      # validate manifests, assets, accessibility hooks, UI inventory
npm run schema:check       # validate a generated export against schema 2.1
npm run lint               # static hygiene checks
npm run verify             # npm test + lint
npm run acceptance:preview # HTTP smoke; real Chromium when Playwright is installed
npm run release:local      # build, checksum, and write a local release manifest
npm run preview            # synthetic local UI preview; never live capture
```

`tools/build-release.mjs` regenerates `src/injected-main.js`, `src/injected-content.js`, and the complete `firefox/` tree. Do not hand-edit those generated files.

The automated suites simulate browser APIs and storage. They do not replace a live Arena acceptance check, installed Firefox check, native macOS helper check, or real GitHub network transaction. `docs/verification.md` records those limits honestly. See [docs/release-local.md](docs/release-local.md) for the local artifact pipeline and [docs/streaming-exports.md](docs/streaming-exports.md) for JSONL.

## Upgrading from 2.2

3.0 is additive: export schema 2.1, storage keys, archive paths, `_index.json`, GitHub backup, and encrypted bundles are unchanged. To make old conversations readable offline, open **Library health** and select your whole `arena-archive` folder. If encrypted archives are enabled, the library stays off by design.
