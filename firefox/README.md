# Arena Agent Exporter 1.17.1 (Firefox)

Requires Firefox 140.0+.

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on** and select this folder's `manifest.json`.
3. Reload the Arena tab. Temporary installations must be loaded again after restarting Firefox.

Captures Agent, Battle, Direct and Side-by-Side chats. Use **Write to archive now** or **Export full chat** in the popup. Turns also archive automatically.

Files go to `Downloads/arena-archive/`, or to the folder selected in the optional Arena Archive native app. Agent model identities remain unset when Arena does not reveal them.

See [release notes](CHANGELOG.md), [export metadata](docs/export-schema.md), and the [repository README](https://github.com/musterm4nn-alt/arena-exporter#readme).

Generated with `node tools/build-release.mjs`; edit the shared source in the repository root.
