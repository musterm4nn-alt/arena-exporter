# Arena Archive macOS package

This package contains the archive reader, shared archive store, and the native messaging host used by the extension.

## Build

```bash
swift build -c release
```

Products are written under `.build/release/`:

- `ArenaArchive` — desktop reader
- `ArenaArchiveHost` — Chrome/Firefox native messaging host
- `ArchiveKitProbe` — filesystem safety probe

## Install the native host

Build the host, then use the local installer from the repository root:

```bash
node tools/install-native-host.mjs --host "$PWD/macos/ArenaArchive/.build/release/ArenaArchiveHost" --browser chrome
node tools/install-native-host.mjs --host "$PWD/macos/ArenaArchive/.build/release/ArenaArchiveHost" --browser firefox
```

The installer writes browser-specific host manifests under the current user's native-messaging directories and uses the correct Chrome origin or Firefox extension allowlist. It never contacts GitHub or a remote service.

The host reads its archive root from `~/Library/Application Support/ArenaArchive/config.json`, falling back to `~/Downloads/arena-archive`. The desktop reader's **Choose Folder…** button updates that configuration for both the app and host.

## Protocol

The host implements the existing `hello` and `write` operations. Requests and responses use the browser native-messaging 4-byte little-endian length prefix followed by UTF-8 JSON. Writes are path-checked, capped at 80 files per message and 32 MiB per file, and support UTF-8, base64, and data-URL payloads. Encrypted `conversation.enc` bundles are labeled by the desktop reader and can be recovered locally with `tools/decrypt-archive.mjs`.
