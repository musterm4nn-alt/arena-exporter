#!/usr/bin/env bash
# Copy the extension to a sibling dist/ folder. Refuses to rsync onto itself.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${ARENA_EXTENSIONS_ROOT:-"$SRC/../arena-exporter-dist"}"
FORCE="${1:-}"

ver_of() {
  python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$1"
}

SRC_ABS="$(cd "$SRC" && pwd)"
mkdir -p "$DEST"
DEST_ABS="$(cd "$DEST" && pwd)"

if [ "$SRC_ABS" = "$DEST_ABS" ]; then
  echo "Refusing to deploy: source and destination are the same path: $SRC_ABS" >&2
  exit 1
fi

new_ver="$(ver_of "$SRC/manifest.json")"
echo "Deploying v$new_ver"
echo "  src  $SRC_ABS"
echo "  dest $DEST_ABS"

RSYNC_FLAGS=(-a --exclude=.DS_Store --exclude=macos/ArenaArchive/.build --exclude=macos/ArenaArchive/.swiftpm)
if [ "$FORCE" = "--force" ]; then
  RSYNC_FLAGS+=(--delete)
else
  echo "(pass --force to enable rsync --delete)"
fi

rsync "${RSYNC_FLAGS[@]}" "$SRC_ABS/" "$DEST_ABS/"
echo "Done. Load $DEST_ABS as an unpacked extension (or reload it)."
