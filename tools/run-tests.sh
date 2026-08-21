#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
node tests/normalize.test.js
node tests/background.test.js
node tests/turn-sync.test.js
node tests/interceptor.test.js
node tests/archive.test.js
node tests/archive-sink.test.js
if command -v swift >/dev/null; then
  (cd macos/ArenaArchive && swift test)
  (cd macos/ArenaArchive && swift run ArchiveKitProbe)
fi
echo "ALL SUITES OK"
