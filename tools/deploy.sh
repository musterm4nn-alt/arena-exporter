#!/usr/bin/env bash
# Copy the extension to a sibling dist/ folder. Refuses to rsync onto itself.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
node "$ROOT/tools/build-release.mjs"
VERSION="$(node -p "require(process.argv[1]).version" "$ROOT/manifest.json")"
SRC="$ROOT/dist/Arena-Agent-Exporter-$VERSION-chrome"
DEST="${ARENA_EXTENSIONS_ROOT:-"$ROOT/../arena-exporter-dist"}"
FORCE="${1:-}"

SRC_ABS="$(cd "$SRC" && pwd)"
mkdir -p "$DEST"
DEST_ABS="$(cd "$DEST" && pwd)"

if [ "$SRC_ABS" = "$DEST_ABS" ] || [ "$ROOT" = "$DEST_ABS" ] || [[ "$SRC_ABS/" == "$DEST_ABS/"* ]]; then
  echo "Refusing to deploy: source and destination are the same path: $SRC_ABS" >&2
  exit 1
fi

echo "Deploying v$VERSION"
echo "  src  $SRC_ABS"
echo "  dest $DEST_ABS"

RSYNC_FLAGS=(-a)
if [ "$FORCE" = "--force" ]; then
  RSYNC_FLAGS+=(--delete)
else
  echo "(pass --force to enable rsync --delete)"
fi

rsync "${RSYNC_FLAGS[@]}" "$SRC_ABS/" "$DEST_ABS/"
echo "Done. Load $DEST_ABS as an unpacked extension (or reload it)."
