# Arena Agent Exporter (Firefox)

**Version 1.16.1** — Firefox MV3 tree. Gecko id: `arena-agent-exporter@local`.

## Load

Load this folder as a temporary add-on, or install the AMO unlisted zip.

1. Firefox → `about:debugging#/runtime/this-firefox` → **This Firefox**
2. **Load Temporary Add-on…**
3. Select this folder's `manifest.json`
4. Reload the Arena tab

Temporary add-ons **die when Firefox quits** — load again after restart.

See the [repository README](../README.md) for capture behaviour, archive layout, the native Arena Archive app (Windows writer under `Documents\arena-archive` with Downloads fallback), tests, and the macOS reader.
