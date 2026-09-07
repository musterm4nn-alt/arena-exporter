# 2.2.0 verification

Arena Exporter 2.2 keeps the 2.1 capture engine and compatibility contract, then adds message-scoped semantic deduplication, stronger structural credential redaction, additive capture-health UI state, explicit production regressions, and the separate static presentation site.

## Automated gate

Run:

    npm test
    npm run site:check

`npm test` first runs the release builder, which regenerates distinct Chrome MAIN/ISOLATED content-script entry points, the complete Firefox tree, unpacked release folders and reproducible ZIPs. It then runs every `tests/*.test.js` suite.

The production-overhaul regression adds explicit coverage for:

- multi-turn Agent;
- multi-turn Battle;
- multi-turn Direct;
- multi-turn Side-by-Side;
- a failed request followed by a successful retry;
- message-scoped semantic replay dedupe;
- model attribution/provenance refusing hidden identity inference;
- nested JSON, credential-bearing URL, GitHub-token and private-key redaction;
- preservation of the Firefox ID and schema 2.1.

Inherited suites continue to cover concurrent tabs, late responses after navigation, realtime record replay, archive destination switching, concurrent archive index writes, GitHub backup retry/concurrency/privacy, history/backfill behavior, Chrome/Firefox manifests and generated Firefox background loading.

`npm run site:check` verifies that the presentation site is self-contained, contains the required product/mode/platform material, has no remote runtime script/stylesheet dependency, references existing local assets, and has syntactically valid JavaScript.

## Live-browser scope

Automated browser API fixtures do not prove the current Arena website has not changed. A release maintainer should still perform a live acceptance pass in Chrome and Firefox covering all four Arena modes, a multi-turn Battle reveal/vote, a failed/retried request, an archive write, a GitHub upload, and a browser restart with queued data.

No installed-browser, native-host or real GitHub-network check is claimed by this document unless it is recorded separately with the exact build and date.
