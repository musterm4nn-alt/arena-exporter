# 2.2.0 verification

The local 2.2 overhaul is verified with the repository's deterministic JavaScript harness and project checks. The harness uses synthetic browser APIs; it is not evidence of live Arena capture.

## Automated checks

Run with Node.js 20 or newer:

```bash
npm run verify
```

This command:

1. regenerates the Chrome and Firefox packages;
2. runs every `tests/*.test.js` suite;
3. validates manifest versions, local asset references, keyboard focus treatment, reduced-motion treatment, and required generated entry points.

The current local run passes **21 JavaScript suites** plus the project check. Coverage includes:

- Agent, Battle, Direct, and Side-by-Side multi-turn reconstruction;
- failed retry → successful retry metadata;
- request/tab/session isolation;
- message-scoped semantic replay suppression;
- nested credential, token, URL, and private-key redaction;
- raw URL preservation;
- stream framing, completion signals, and bounded capture buffers;
- Downloads/native archive fallback and path safety;
- GitHub queue durability, retry, privacy, and destination switching;
- popup/workspace actions, diagnostics, and browser permission boundaries;
- Firefox ordered background loading and packaged manifest integrity.

## UI verification

The popup and workspace are dependency-free HTML/CSS/JavaScript and use only bundled assets. The local preview command serves synthetic browser data:

```bash
npm run preview
```

The preview is explicitly labeled and is not live capture. The automated UI harness verifies controller behavior, not a full accessibility audit or pixel-perfect rendering on every browser.

## Verification limits

This environment did not provide:

- a live signed-in Arena browser session;
- an installed Chrome/Firefox extension profile for a real capture run;
- the optional native macOS messaging host;
- a real GitHub repository/network transaction;
- a Swift toolchain for the optional macOS package.

Those limitations are intentional and must not be converted into product claims without a separate acceptance run.
