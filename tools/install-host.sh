#!/usr/bin/env bash
# Build the Swift native host and register it with Chrome (and Chromium-family browsers if present).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/macos/ArenaArchive"
cd "$PKG"
swift build -c release --product arena-archive-host
HOST="$(swift build -c release --show-bin-path)/arena-archive-host"
chmod +x "$HOST"

# Stable unpacked-extension id is not known until Chrome loads the key.
# Register with a wildcard of local unpacked ids by rewriting after the user
# copies chrome://extensions id into ARENA_EXTENSION_ID if set.
EXT_ID="${ARENA_EXTENSION_ID:-}"
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$MANIFEST_DIR"
OUT="$MANIFEST_DIR/com.arenaexporter.host.json"
python3 - "$HOST" "$OUT" "$EXT_ID" <<'PY'
import json, sys, os
host, out, ext = sys.argv[1], sys.argv[2], sys.argv[3]
origins = []
if ext:
    origins.append("chrome-extension://%s/" % ext.strip())
else:
    # Chrome requires an explicit id. Use a documented placeholder the user can
    # overwrite; also include the common unpacked-id env if later set.
    origins.append("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/")
doc = {
    "name": "com.arenaexporter.host",
    "description": "Arena Archive native host",
    "path": host,
    "type": "stdio",
    "allowed_origins": origins,
}
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
print("Wrote", out)
print("Host", host)
if not ext:
    print("Set ARENA_EXTENSION_ID to your chrome://extensions ID and re-run for a matching origin.")
PY

for extra in \
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts" \
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
do
  if [ -d "$(dirname "$extra")" ]; then
    mkdir -p "$extra"
    cp "$OUT" "$extra/com.arenaexporter.host.json"
  fi
done

echo "Done. Load the unpacked extension, copy its ID, then:"
echo "  ARENA_EXTENSION_ID=<id> bash tools/install-host.sh"
