# Local release pipeline

The local release command never pushes, publishes, or contacts GitHub.

```bash
npm run release:local
```

It runs the JavaScript gate, regenerates both browser packages, writes SHA-256 checksums, and creates `dist/release-manifest.json` with the source commit, branch, dirty state, runtime, and artifact hashes. A plain `npm test`/`npm run build` intentionally removes old release metadata rather than leaving it beside rebuilt ZIPs; rerun `npm run release:local` for a coherent artifact set.

Useful options:

```bash
node tools/release-local.mjs --skip-tests
node tools/release-local.mjs --acceptance
node tools/release-local.mjs --output C:\Temp\arena-exporter-release
node tools/release-local.mjs --sign-key C:\secure\arena-release-key.pem
node tools/release-local.mjs --native-host C:\path\to\ArenaArchiveHost
# macOS only; omit this on Windows/Linux artifact builds
node tools/release-local.mjs --install-native-host --host /path/to/ArenaArchiveHost
```

`--sign-key` creates detached OpenSSL signatures for the ZIP artifacts. It is an artifact signature, not browser store signing. `--install-native-host` invokes the macOS-only local native-host manifest installer and is never performed implicitly.
