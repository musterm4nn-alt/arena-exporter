# Arena Agent Exporter

Chrome MV3 extension that captures arena.ai **Agent** and **Battle** chats into structured JSON (schema 2.0) plus an optional on-disk archive owned by a macOS app.

## Load the extension

1. Chrome → `chrome://extensions` → Developer mode → Load unpacked
2. Select this folder (`arena-exporter`)
3. Reload after pulls. Copy the extension ID from that page.

## Capture

Open an arena.ai Agent or Battle tab. The interceptor runs at `document_start`. Use the popup:

- **Sync now** — write the current session through Arena Archive (requires the native host)
- **Export full history (JSON)** — download JSON (works without the app)
- Vote override if the ballot click is missed

Battle outcomes default to `pending`. Idle “A is better / B is better” styling is not a vote. `Response A` / `Response B` are not treated as model names.

`attribution_samples[]` is one model output per lane/turn. Vote/winner/opponent text stay off the sample.

## macOS archive app

```bash
cd macos/ArenaArchive
swift build --product ArenaArchive
swift run ArenaArchive          # sidebar + markdown reader
swift run ArchiveKitProbe       # path-safety checks
```

Register the native host (after you have the extension ID):

```bash
ARENA_EXTENSION_ID=<id> bash tools/install-host.sh
```

Default archive root: `~/Documents/arena-archive/`

```
agent/<slug>/
battle/text|code|web-search|image|video/<slug>/
  conversation.json
  conversation.md
  battle-01/A/  battle-01/B/
```

The first battle round locks the parent subtype. Folders are never renamed.

## Tests

```bash
bash tools/run-tests.sh
```

## Deploy

```bash
bash tools/deploy.sh            # copies to ../arena-exporter-dist
bash tools/deploy.sh --force    # also --delete
```

Refuses to rsync onto itself.
