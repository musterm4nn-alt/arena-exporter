# Arena Exporter

**Version 2.2.0** is a local-first Manifest V3 extension for exporting [arena.ai](https://arena.ai) Agent, Battle, Direct, and Side-by-Side conversations as structured JSON and readable Markdown.

Arena Exporter records streamed text, reasoning and tool evidence, files, request outcomes, transport metadata, and model-label provenance. It keeps the page's own response intact and never treats a failed request as an assistant answer.

## What changed in 2.2

- Rebuilt the popup and archive workspace around a responsive ink/mint visual system with clearer capture-health, export, archive, backup, and diagnostics hierarchy.
- Scoped semantic replay suppression to one assistant message, preserving identical artifacts and actions in later turns.
- Hardened credential filtering for nested JSON, URL credentials and fragments, GitHub token forms, and PEM/OpenSSH private keys while preserving harmless raw URLs.
- Normalized the exported Battle outcome to the documented `neither_good` value.
- Added architecture/security documentation, project checks, and regression coverage for the overhaul.
- Kept the Chrome extension key, Firefox add-on ID, export schema 2.1, storage keys, archive layout, and existing message contracts compatible.

## Install

### Chrome / Chromium

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository root, or build and unzip `dist/Arena-Agent-Exporter-2.2.0-chrome.zip`.
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
- JSON or Markdown download
- Copy to clipboard
- **Save now** for an immediate archive write
- Automatic archive of completed turns
- Archive folder reveal/recovery
- Battle vote correction
- Redacted page diagnostics

A logical stream completion or `turn-complete` record schedules an archive write. Retries remain separate across CAPTCHA challenges, selection rejection, network failures, and successful retries. Tabs and late responses remain associated with the conversation that initiated them.

## Model identity

Model UUIDs, page catalog labels, message IDs, and transport IDs are intentionally distinct.

- Battle labels are marked verified only after Arena reveals them.
- Direct and Side-by-Side selection labels may come from the public page catalog and remain unverified.
- Agent orchestrator identity remains unknown unless Arena explicitly reveals it.
- Incidental UUIDs, selector flags, tool arguments, and leaderboard data never become model identity.

See [docs/export-schema.md](docs/export-schema.md) for the schema contract and [docs/architecture.md](docs/architecture.md) for runtime boundaries.

## Privacy

The extension filters known credential keys, authorization headers, cookies, CAPTCHA values, API keys, access/refresh/session tokens, JWTs, GitHub token forms, private-key blocks, and credential-bearing URLs before persistence and export. Only three bounded diagnostic response headers are retained:

- `x-session-settled`
- `x-stream-version`
- `x-arena-chat-id`

Conversation exports intentionally contain conversation content and files. Credential filtering is not general anonymization. See [docs/security.md](docs/security.md).

## Archive layout

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

The browser extension can use the native host `com.arenaarchive.host` when installed. Missing host, failed handshake, or no selected folder falls back to Downloads. The repository contains the optional macOS reader package:

```bash
cd macos/ArenaArchive
swift build --product ArenaArchive
swift run ArenaArchive
swift test
```

The native messaging host itself is an external installation dependency and is not bundled in this repository.

## GitHub backup

Open **Archive workspace → GitHub backup** to connect a private repository. New archive writes enter a durable IndexedDB outbox, upload changed files only, preserve remote history, retry transient failures, and use non-forced ref updates. Tokens stay in trusted extension storage and never enter exports or the outbox.

Use a fine-grained token limited to the archive repository with **Contents: read and write**. Existing folders can be imported through the folder picker. See [docs/github-backup.md](docs/github-backup.md).

## Build and verify

Requires Node.js 20 or newer. The project has no runtime npm dependencies.

```bash
npm test                 # build both packages and run all JavaScript suites
npm run build            # generate Chrome/Firefox folders and reproducible ZIPs
npm run check:project    # validate manifests, local assets, and accessibility hooks
npm run verify           # test + project check
npm run preview          # synthetic local UI preview; never live capture
```

`tools/build-release.mjs` regenerates `src/injected-main.js`, `src/injected-content.js`, and the complete `firefox/` tree. Do not hand-edit those generated files.

The automated suites simulate browser APIs and storage. They do not replace a live Arena acceptance check, installed Firefox check, native macOS helper check, or real GitHub network transaction. `docs/verification.md` records those limits honestly.
