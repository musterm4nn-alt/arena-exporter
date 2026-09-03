# Arena Agent Exporter

**Version 1.16.1** — Chrome / Firefox MV3 extension that captures arena.ai **Agent** and **Battle** chats into structured JSON (schema 2.0) and an on-disk archive.

## Load the extension

### Chrome

Load unpacked **this repository root** (the folder that contains `manifest.json`).

1. Chrome → `chrome://extensions` → Developer mode → Load unpacked
2. Select this repo root
3. Reload after pulls

### Firefox

Load from the **`firefox/`** tree, or install the AMO unlisted zip. Gecko id: `arena-agent-exporter@local`.

1. Firefox → `about:debugging#/runtime/this-firefox` → **This Firefox**
2. **Load Temporary Add-on…**
3. Select `firefox/manifest.json`
4. Reload the Arena tab after loading

Temporary add-ons **die when Firefox quits** — load again after restart.

`downloads.ui` silent-shelf suppression is **Chrome-only**. Firefox always shows the download UI when falling back to Downloads.

## Capture

Open an arena.ai Agent or Battle tab. The interceptor runs at `document_start`. Use the popup:

- **Write to archive now** — write the current tab's session to the archive
- **Export full history (JSON)** — download JSON (always available)
- Vote override if the ballot click is missed

Turns also archive automatically when a stream ends or a vote lands.

Battle outcomes default to `pending`. Idle “A is better / B is better” styling is not a vote. `Response A` / `Response B` are not treated as model names.
Preview-tab navigation is explicitly excluded from vote capture, and modern
code-battle cards backfill a lane when its agent stream was missed. **Write to
archive now** can also reconstruct a reopened battle from the rendered page
after the extension reloads or its older in-memory capture session is evicted.
Popup actions are pinned to the active tab's full conversation key, so two open
Arena tabs cannot mix one page's DOM with another tab's capture session. A
reopened anonymous battle can also be reconstructed from its two rendered lanes
before Arena reveals either model name.

`attribution_samples[]` is one model output per lane/turn. Vote/winner/opponent text stay off the sample. After a decisive A/B vote the losing lane's next turn is marked `context_source: "cross_lane"` — that model is continuing the other lane's text.

## Where the archive lives

On **Windows**, archive writes go through the native **Arena Archive** app to `Documents\arena-archive` when that host is installed and a folder is chosen. If the native host is missing, hello fails, or no folder is chosen, the extension **falls back** to the browser Downloads folder (`Downloads/arena-archive/`).

Native messaging (`chrome.runtime.connectNative`, host `com.arenaarchive.host`) is the writer path. The extension only writes — choosing the root is the app's job. Native host manifests live with the app installers, not in this extension. JSON export (download / copy) is unchanged.

`chrome.downloads` can only write beneath the browser's download directory, and it refuses to follow a directory symlinked *out* of it — it shows a Save As dialog and then reports `complete` while silently writing to the Downloads root instead. It does create the target directory during path reservation before refusing, so seeing the folder appear proves nothing.

When using the Downloads fallback, the real directory lives under Downloads and can be surfaced where you want it:

```bash
mkdir -p ~/Downloads/arena-archive
ln -s ~/Downloads/arena-archive ~/Documents/arena-archive
```

Reads, Finder and git all follow that link; only Chrome's download-target logic objects, and it never sees it. Nested real subdirectories under Downloads work fine, so the full `battle/<subtype>/<slug>/` tree writes normally.

The File System Access API was evaluated and rejected: the handle survives in IndexedDB, but the readwrite grant drops back to `prompt` on every browser restart, and a service worker cannot re-request without a user gesture.

Tree:

```
agent/<slug>/
  files/                  # agent artifacts when bytes were captured
battle/text|code|web-search|image|video/<slug>/
  conversation.json
  conversation.md
  battle-01/A/  battle-01/B/
```

Capture health: if the page shows a finished battle (two replies) or a substantial Agent thread but the interceptor saw no evaluation / realtime stream, the popup warnings card shows a critical alert — reload the Arena tab before the next turn. Quiet “0 endpoints” is not enough.

Code and Agent files are written into `battle-01/A|B/` and `agent/<slug>/files/` when bytes are available (inline content or a same-origin `arena.ai` / `lmarena.ai` / `blob:` URL). Preview hosts such as `*.arena.site` stay as URL + a capture-health warning.

The first battle round locks the parent subtype. Folders are never renamed.
Folder suffixes contain the complete Arena conversation UUID so chats created
close together cannot overwrite one another. If an older index contains two
conversation keys pinned to the same truncated folder, each chat is moved to
its full-UUID folder the next time that chat syncs.

Open the extension's options page to self-test a write and to optionally suppress Chrome's download bubble. That suppression is **off by default** because it is global to the browser, not just this extension. Firefox does not implement `chrome.downloads.setUiOptions`, so the toggle is disabled there.

## Arena Archive native app

If the **Arena Archive** desktop app is installed (including the Windows writer), auto-archive and **Write to archive now** send files through native messaging to `com.arenaarchive.host` (stdio JSON; the app writes under the folder you pick there — on Windows typically `Documents\arena-archive`).

If the host is missing, hello fails, or no folder is chosen, the extension **falls back** to `chrome.downloads` under `Downloads/arena-archive/` — same load-unpacked Chrome/Firefox behaviour as before.

## Optional macOS reader

A SwiftUI app that reads the archive (it does not write). A native Windows writer exists separately via the Arena Archive app above.

```bash
cd macos/ArenaArchive
swift build --product ArenaArchive
swift run ArenaArchive          # sidebar + markdown reader
swift test                      # ArchiveKit path-safety / pinning
```

Default archive root for the reader: `~/Downloads/arena-archive/` (the Downloads fallback folder). If you created the symlink above, `~/Documents/arena-archive` is the same tree. On Windows with the native app, the writer uses `Documents\arena-archive`.

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
