# 3.0.0 verification

The local 3.0 overhaul is verified with the repository's deterministic JavaScript harness, a synthetic IndexedDB, and project checks. The harness uses synthetic browser APIs; it is not evidence of live Arena capture.

## Automated checks

Run with Node.js 20 or newer:

```bash
npm run verify
```

This command:

1. regenerates the Chrome and Firefox packages;
2. runs every `tests/*.test.js` suite;
3. validates manifest versions, local asset references, keyboard focus treatment, reduced-motion treatment, required generated entry points, the pinned UI control inventory, and the export-schema fixture;
4. runs the static lint gate.

The current local run passes **35 JavaScript suites** plus the project check, schema check, and lint gate. Coverage includes:

- Agent, Battle, Direct, and Side-by-Side multi-turn reconstruction;
- failed retry → successful retry metadata;
- request/tab/session isolation;
- message-scoped semantic replay suppression;
- nested credential, token, URL, and private-key redaction;
- raw URL preservation;
- stream framing, completion signals, and bounded capture buffers;
- Downloads/native archive fallback and path safety;
- GitHub queue durability, retry, privacy, and destination switching;
- popup/workspace actions, diagnostics, encryption settings, browser permission boundaries, and message authorization;
- native-host batch/path safety, installer manifest allowlists, and local release tooling;
- encrypted archive verifier/key separation, unlock/decrypt behavior, migration refusal, and restart locking;
- JSONL record generation and Markdown chunk streaming;
- versioned export-schema contract validation;
- Firefox ordered background loading and packaged manifest integrity;
- transcript projection bounds and model/Battle/file extraction;
- local search with AND terms, quoted phrases, exclusions, filters, scores, snippets, and limits;
- local library indexing, replacement, byte accounting, hash verification states, folder import, removal, clear, and the encryption gate;
- archive-folder import path mapping, six-file batching, 4 MiB skips, progress, and failure propagation;
- Insights totals, activity buckets, votes, models, completeness, and tool usage;
- deterministic ZIP structure, CRC-32, stored entries, UTF-8 flags, and bulk-manifest paths;
- workspace pagination, debounced search, reader rendering, JSON/copy export, health findings, and bulk ZIP export;
- local library clearing when archive encryption is enabled.

## UI verification

The popup and workspace are dependency-free HTML/CSS/JavaScript and use only bundled assets. The local preview command serves synthetic browser data:

```bash
npm run preview
```

The preview is explicitly labeled and is not live capture. It synthesises library records, search results, Insights, a verification report, and bulk-export payloads so the seven-view workspace can be reviewed without an Arena session. The automated UI harness verifies controller behavior, not a full accessibility audit or pixel-perfect rendering on every browser.

## Browser acceptance

Run the dependency-free smoke check with:

```bash
npm run acceptance:preview
```

It starts the synthetic preview, checks all local assets, and verifies the new workspace landmarks. If Playwright and Chromium are available locally, the same command also exercises navigation, diagnostics, and mobile overflow. Use `--require-browser` when a missing browser must fail the release gate:

```bash
node tools/acceptance.mjs --require-browser
```

A real unpacked Chrome package check is available after building:

```bash
node tools/acceptance.mjs --extension --require-browser
```

This mode is intentionally opt-in and must not be confused with live Arena capture. It requires a Chromium build that supports unpacked extensions and may require a headed browser on some platforms.

## Verification limits

This environment did not provide:

- a live signed-in Arena browser session;
- an installed Chrome/Firefox extension profile for a real capture run;
- a Swift toolchain for the optional macOS package;
- a real GitHub repository/network transaction;
- Playwright/Chromium in the local Node installation;
- real IndexedDB quota, eviction, or multi-profile behavior.

Those limitations are intentional and must not be converted into product claims without a separate acceptance run.
