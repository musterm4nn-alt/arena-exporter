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

## Optional archive encryption

Archive encryption is an explicit local preference. A random salt, iteration count, and a verifier derived from a separate PBKDF2 output are persisted; the persisted verifier is not the AES-GCM key, and the password plus non-extractable derived key remain in memory only. A service-worker restart intentionally returns the feature to a locked state and blocks new plaintext writes. Disabling encryption requires the current password. Existing indexed plaintext archive siblings cause new writes to pause until the user migrates or removes that archive; the extension never silently mixes a new sealed bundle with known old plaintext files. The local index is authoritative because the Downloads API cannot enumerate arbitrary files. The current bundle format is version 2 (PBKDF2-SHA-256 with separate 256-bit key/verifier outputs); the recovery path also accepts the short-lived experimental version 1 bundle format for local recovery. The `conversation.enc` bundle contains the conversation JSON, Markdown, and attachment payloads; local index metadata is not hidden by the bundle format.

Recovery is explicit through `tools/decrypt-archive.mjs`. A lost password cannot be recovered from the verifier.

## Host and path boundaries

Archive paths are normalized and traversal segments are rejected before Downloads or native writes. The optional native host receives only bounded `hello`/`write` operations, validates every relative path again, and batches large writes by both file count and encoded size. The host implementation is built from `macos/ArenaArchive` and installed locally with `tools/install-native-host.mjs`; it never contacts a remote service.
