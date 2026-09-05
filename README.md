# Arena Exporter

Version **2.1.0** is a Manifest V3 extension for exporting arena.ai **Agent**, **Battle**, **Direct**, and **Side-by-Side** conversations as structured JSON and readable Markdown. It records streamed text, reasoning, tools, files, transport outcomes, and model label provenance.

## The 2.1 overhaul

A new Departure Mono popup puts the current conversation, export scope, format, local save and backup status together. The full-page workspace adds a searchable archive library with mode filters, sorting, pagination and direct Arena/folder actions, plus dedicated GitHub backup, preferences and diagnostics views.

The runtime retains the tested 1.18.0 capture, history, native archive and GitHub queue components, with separated capture/export/router files, explicit export sessions, serialized persistence, a working evaluation parse cache and event-driven UI updates. It replaces the experimental 2.0.0 implementation. Storage keys, the Chrome extension identity, Firefox ID and export schema 2.1 remain compatible with v1.

See the [implementation plan](docs/overhaul-plan.md), [release notes](CHANGELOG.md) and [verification scope](docs/verification.md). Live rendering and installed-browser smoke tests remain unverified because no browser-control connection was available during implementation.

## GitHub backups and conversation folders

Use **Open archive library → GitHub backup** to connect a private repository. New archive writes upload automatically, with a persistent retry queue, visible status and existing-folder import. Use **Open folder** to reveal the selected Arena chat in your file manager. See [setup, permissions and restore instructions](docs/github-backup.md).

## Install

### Chrome

1. Open `chrome://extensions` and enable Developer mode.
2. Choose **Load unpacked** and select the repository root, or unzip `dist/Arena-Agent-Exporter-2.1.0-chrome.zip` and select that folder.
3. Reload the Arena tab. After updating the source, also press **Reload** on the extension card.

The manifest keeps the same public key across releases to preserve the unpacked extension ID.

### Firefox

Firefox uses its own complete build under `firefox/`, with an ordered `background.scripts` manifest. Use this build when loading the add-on in Firefox.

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on** and select `firefox/manifest.json`, or select the manifest in the extracted `dist/Arena-Agent-Exporter-2.1.0-firefox.zip`.
3. Reload the Arena tab.

The Firefox build requires Firefox 140 or later. A temporary add-on must be loaded again after Firefox restarts. Its download UI is not suppressed.

## Capture and export

The interceptor starts at `document_start`. Open an Arena conversation and use the popup:

- **Save now** writes the active tab's current conversation.
- Choose **Full conversation** or **Last answer**, then JSON or Markdown, and export.
- **Last answer** includes the triggering user prompt for context and excludes older raw transport samples.
- **Copy** copies the selected scope and format.
- **Conversation tools** contains Battle vote correction, redacted page diagnostics and capture reset.
- **Open archive library** opens search, history import, backup, preferences and diagnostics.

A logical stream finish or `turn-complete` control record schedules an automatic archive write. Request attempts remain separate across CAPTCHA challenges, selection rejections, network failures, and successful retries. A failed request never creates a synthetic assistant answer.

The extension correlates each request and stream by request ID and keeps each browser tab in a separate session. Late responses remain attached to the conversation that initiated them after tab navigation. Replayed realtime batches are deduplicated without relying solely on a small rolling window.

### Model identity

Model IDs, page catalog labels, message/node IDs, and transport/session IDs are distinct fields.

- Battle model names are verified only after Arena reveals them.
- Direct and Side-by-Side selections can be joined to the page's public model catalog. These labels use `model_source: "request_catalog"` and `model_identity_verified: false` because a selection label does not prove the serving backend.
- Agent orchestrator identity remains `null` with source `not_revealed` unless Arena explicitly reveals it. Tool arguments, network hints, selector flags, leaderboard statistics, and UUID-shaped identifiers never become the Agent model name.

See [docs/export-schema.md](docs/export-schema.md) for the additive schema 2.1 fields and their interpretation.

### Privacy

Before an event is stored or exported, the extension filters authorization headers, cookies, CAPTCHA values, API keys, credentials, access/refresh/session tokens, private keys, JSON nested inside strings, common JWTs, and raw Bearer or Basic credentials. Only the diagnostic response headers `x-session-settled`, `x-stream-version`, and `x-arena-chat-id` are retained.

DOM debug dumps redact all non-empty page text, text-bearing attributes, URL query strings, and comments. They preserve bounded structure and selected state attributes. Exports still contain conversation content and files; credential filtering is not general anonymization.

## Archive

Without the optional native app, `chrome.downloads` writes below `Downloads/arena-archive/`. The first successful write pins a conversation to one folder. The index tracks content hashes separately for Downloads and for every native archive root, so changing destinations writes a complete copy and switching back preserves the other destination's cache.

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

Subtypes are `text`, `code`, `web-search`, `image`, or `video`. Folder names contain the complete Arena conversation ID to avoid collisions. Direct has one contestant lane, Side-by-Side has two, and Battle retains its vote outcome. Agent workspace ZIP capture is requested only for Agent conversations; files on unsupported preview hosts remain URL references with a capture warning.

To expose the default archive elsewhere on macOS or Linux, link from the target location to the real Downloads directory:

```bash
mkdir -p ~/Downloads/arena-archive
ln -s ~/Downloads/arena-archive ~/Documents/arena-archive
```

The browser still writes to the real directory below Downloads; readers and Git can use the link.

### Arena Archive native app

If the Arena Archive desktop app is installed, automatic and manual archive writes use the native host `com.arenaarchive.host` and its selected root. Missing host, failed handshake, or no selected folder falls back to Downloads. JSON export and copy remain available independently.

The optional macOS reader is under `macos/ArenaArchive`:

```bash
cd macos/ArenaArchive
swift build --product ArenaArchive
swift run ArenaArchive
swift test
```

## Build and test

The release builder regenerates the full Firefox tree, complete unpacked Chrome and Firefox folders, and reproducible ZIP files:

```bash
node tools/build-release.mjs
node tools/run-tests.mjs
```

`bash tools/run-tests.sh` runs the same JavaScript build and test gate, followed by the optional Swift checks when the local toolchain supports them. `bash tools/deploy.sh` builds and copies the Chrome package to `../arena-exporter-dist`; pass `--force` to remove stale files there.

The tests cover stream framing, arbitrary part IDs, retries and rejection outcomes, credential filtering, Flight metadata, Direct capture, Agent completion, session isolation, archive concurrency, destination switching, and both browser manifests. Browser APIs are simulated in the JavaScript suites; they do not replace a live Arena acceptance check.
