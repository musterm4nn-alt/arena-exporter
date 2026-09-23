# Security and privacy model

Arena Exporter intentionally captures conversation content. Its privacy boundary is preventing unrelated credentials and transport secrets from becoming durable archive data.

## Redaction

`src/lib/privacy.js` performs structural filtering before persistence and again before export:

- secret-named object properties and header-pair arrays are removed;
- nested JSON strings are parsed and filtered;
- JWTs, Bearer/Basic credentials, common API keys, GitHub token forms, and PEM/OpenSSH private keys are redacted;
- URL usernames/passwords and credential query/fragment parameters are removed;
- prototype-pollution property names are discarded;
- only `x-session-settled`, `x-stream-version`, and `x-arena-chat-id` are retained as transport headers;
- harmless URLs are returned byte-for-byte unchanged so raw Arena stream grammar remains parseable.

Conversation exports still intentionally contain prompts, answers, reasoning/tool evidence, file metadata/content, and source URLs. Redaction is not anonymization.

## Credentials and backups

GitHub credentials remain in trusted extension local storage and are not copied into exports, diagnostics, archive indexes, or the IndexedDB outbox. Backup requests omit ambient cookies, reject redirects, and update refs without force-pushing. Disconnecting removes the saved token while preserving local archives and queued snapshots for an explicitly reconnected destination.

## Diagnostics

The diagnostics view contains counts, limits, storage mode, and controlled issue codes. It excludes conversation text, titles, URLs, and credentials. Page diagnostics are a separate redacted DOM-shape report intended for selector troubleshooting.

## Host and path boundaries

Archive paths are normalized and traversal segments are rejected before Downloads or native writes. The optional native host receives only bounded `hello`/`write` operations. The native helper itself is an external installation dependency and is not bundled in this repository.
