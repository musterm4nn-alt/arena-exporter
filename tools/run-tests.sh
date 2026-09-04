#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
node tools/run-tests.mjs
if command -v swift >/dev/null; then
  # XCTest ships with full Xcode, not the Command Line Tools, so `swift test`
  # cannot even compile under a CLT-only toolchain. Probe for the framework
  # rather than assuming, and say so when skipping -- ArchiveKitProbe covers
  # the same three cases (path traversal, subtype lock, slug) without XCTest,
  # which is why it exists.
  DEVELOPER_DIR_PATH="$(xcode-select -p 2>/dev/null || true)"
  if [ -n "$DEVELOPER_DIR_PATH" ] && [ -d "$DEVELOPER_DIR_PATH/Library/Frameworks/XCTest.framework" ]; then
    (cd macos/ArenaArchive && swift test)
  else
    echo "skipping: swift test (XCTest unavailable under ${DEVELOPER_DIR_PATH:-no developer dir}; ArchiveKitProbe covers the same assertions)"
  fi
  (cd macos/ArenaArchive && swift run ArchiveKitProbe)
fi
echo "ALL SUITES OK"
