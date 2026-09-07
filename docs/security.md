# Security and privacy model

Arena Exporter deliberately captures conversation content, so the privacy boundary is about preventing unrelated credentials and sensitive transport material from becoming durable archive data.

## Redaction before storage and export

`src/lib/privacy.js` performs recursive structural filtering. It:

- removes secret-named object properties such as authorization, cookie, CAPTCHA, API-key, password, token/JWT and private-key fields;
- recognizes secret header-pair arrays;
- recursively parses JSON embedded inside strings;
- redacts Bearer/Basic credentials, JWTs, common OpenAI/GitHub token forms and PEM/OpenSSH private keys;
- removes URL username/password credentials and redacts credential query/fragment parameters;
- rejects prototype-pollution property names while cloning captured objects;
- allowlists only `x-session-settled`, `x-stream-version` and `x-arena-chat-id` response headers for transport diagnostics.

This filtering is applied at interception, persistence hydration and export boundaries. A bounded sample is never intentionally taken from an unfiltered JSON body first.

## GitHub credentials

GitHub backup is optional and requires a private repository. The personal access token stays in extension local storage, is not copied into the durable backup outbox, and is not included in archive index entries, exports or diagnostics. On supported Chromium storage APIs, local extension storage is restricted to trusted extension contexts.

Backup HTTP requests use `credentials: "omit"` and redirects are rejected. Git ref updates are non-forced. Queue failures retain archive data locally and retry with backoff.

## DOM diagnostics

Page diagnostics are for selector/capture troubleshooting, not content export. The DOM diagnostic path redacts non-empty text, text-bearing attributes, URL query strings and comments while preserving bounded structural information.

## What redaction does not mean

Conversation exports intentionally contain prompts, answers, model labels that Arena actually exposed, file metadata/content and source URLs needed to preserve the conversation. The privacy filter is not an anonymizer and should not be treated as one.
