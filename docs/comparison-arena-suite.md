# Arena Exporter vs. Arena Suite

Comparison of this repository (`musterm4nn-alt/arena-exporter`) with
[`musterm4nn-alt/arena-suite`](https://github.com/musterm4nn-alt/arena-suite), 2026-10-21.
The baseline is AE v2.2.2 (`1168227`); the 3.0 delta is noted below and in the affected rows.

> **3.0 update (2026-10-21):** AE now has an offline local library, full-text search over
> indexed conversations, a transcript reader, Insights, library-health verification, and
> bulk ZIP export with a SHA-256 manifest. This closes the reading/search/insights/bulk
> gaps in the baseline table. AE still has no FTS5-scale native index, datasets, MCP server,
> multi-account isolation, or native journal durability; AS still has no live capture.

| | Arena Exporter (AE) | Arena Suite (AS) |
| --- | --- | --- |
| Compared at | `1168227`, tag `v2.2.2` | `14d4c7c` (`main`, 2026-10-21) |
| Kind | Manifest V3 browser extension (Chrome/Chromium, Firefox 140+) plus an optional macOS native host | Native macOS 14+ (Apple Silicon) SwiftUI application, plus a read-only MCP server |
| Core job | Capture Arena traffic live, reconstruct each turn, archive it, and read/search it offline in the workspace | Sign in natively, sync history into a durable journal, browse, search, research, export |
| Storage | Browser session store + `Downloads/arena-archive/` (or a chosen folder via native host) + `_index.json` | Append-only `ASJ1` journal per account + rebuildable SQLite/GRDB index + content-addressed attachment store |
| Written in | JavaScript, zero runtime dependencies; 702 lines of optional Swift | Swift 6.1, one pinned dependency (GRDB 7.11.1) |
| Status | Feature-complete snapshot (single squashed commit, 2026-09-24) | Actively developed (44 commits, 2026-09-24 → 2026-10-21), no release tags yet |

Both are local-first, single-user, no server, no analytics. Both export JSON, Markdown and
JSONL, both encrypt local data optionally, and both are explicit in their docs that their
automated tests do not prove live Arena compatibility.

The short version: **AE is a capture instrument, AS is an archive application.** AE records
evidence AS structurally cannot (live streams, failed sends, transport headers, requested
model IDs); AS does native, whole-archive reading, searching, analysing, and long-term
storage at a depth AE's bounded browser library does not attempt. They overlap at "keep my
Arena conversations", and they do not read each other's archive formats.

## 1. Feature matrix

### Capture and evidence

| Capability | AE | AS | Note |
| --- | --- | --- | --- |
| Live stream capture (Fetch/XHR/WebSocket/beacon) | Yes, MAIN-world interceptor at `document_start` | **No, by design** | AS never scripts or reads the page (ADR 0006), so it cannot see traffic |
| Failed, rejected and retried sends | Yes — `meta.request_attempts[]` with `retry_of` and outcomes such as `captcha_rejected`, `selection_rejected`, `network_error`, `stream_error`, `aborted` | No | A send that never became a message is invisible in history |
| Response headers | 3 allowlisted (`x-session-settled`, `x-stream-version`, `x-arena-chat-id`) | None | |
| Requested model IDs + page catalog snapshot | Yes (`requested_model_*`, `meta.model_catalog`) | Only model claims Arena's history/reveal returns | AS preserves conflicting claims with provenance (ledger N-016/N-017) |
| Agent conversations | Live stream + workspace output; `/agent/` page fallback | `/agent/{id}` page transcript, first 20 messages, flagged `agent_transcript_partial` | AS does not fetch later pages, the realtime stream or workspace files |
| Attachments and files | Downloaded into `files/` and battle `A/`–`B/` folders | Downloaded from signed `*.r2.cloudflarestorage.com` URLs into a content-addressed store | Both fetch files; AS verifies the signed lifetime first |
| Battle vote correction | Local manual vote; **can override the exported outcome** with `vote.source: "manual"`; never sent to Arena | Local note beside Arena's vote; exports and Insights still count only Arena's vote | Different philosophy: AE repairs the record, AS annotates it |
| Archive automatically per completed turn | Yes | No — sync and per-conversation Refresh are user-initiated | AS's traffic policy (one request in flight, rate limits) rules out a background loop |
| Multiple accounts | No account concept (uses the browser's session) | Yes — isolated accounts, Keychain sessions, per-account web profile | AS verified 3 accounts live |

### Archive, durability and encryption

| Capability | AE | AS | Note |
| --- | --- | --- | --- |
| Readable archive tree | `agent/`, `battle/`, `direct/`, `side-by-side/` folders with JSON, MD, files | Journal + index; exports are separate files | AE's archive is human-navigable by default |
| Metadata index | `_index.json` with per-destination content hashes | SQLite index, FTS5, rebuildable from the journal | AS's index is a projection, never the source of truth |
| Raw evidence guarantees | Bounded raw streams retained in export metadata; credential filtering at capture | Append-only journal with record digests, seals, quarantine for torn tails, 32 MiB payload cap, `0700`/`0600` permissions | AS's journal is designed as the authoritative evidence store; AE's is a working capture buffer plus archive |
| Encryption | Opt-in per-conversation `conversation.enc`, AES-GCM with PBKDF2-SHA-256 key/verifier separation, CLI recovery | Opt-in whole-backup `.aea` (Apple Encrypted Archive: scrypt, AES-CTR, HMAC-SHA256) | Different granularity: AE seals each conversation, AS seals a backup |
| Cloud backup | GitHub (private repo, durable IndexedDB outbox, non-forced updates) | None (decision outstanding; encryption and local backup only) | AE is the only one that leaves the machine on purpose |
| Import of existing archives | Yes, own folder layout + GitHub | Skipped by user decision (2026-10-20) | Neither reads the other's format |
| Verify / rebuild | Per-destination hashes, native write self-test | Verify job over every journal record, index rebuild, restore checks, SIGKILL crash gate | AS's failure testing is considerably deeper |

### Reading, search and research

| Capability | AE | AS | Note |
| --- | --- | --- | --- |
| Browser/interface | Popup + seven-view archive workspace (library, reader, insights, health, backup, preferences, diagnostics) | Full app: sidebar, transcript with lanes, insights, maintenance | |
| Conversation reading | 3.0 workspace reader renders messages, reasoning, tools, Battle lanes and file metadata from the bounded local library; the optional macOS reader still shows one Markdown file | Native transcript with prompt bubbles, response cards, expandable reasoning/tools, inline images | AS remains richer for images and very large transcripts |
| Search | **Full-text over the local library** — AND terms, quoted phrases, exclusions, mode/model/vote/date filters, optional reasoning/tool scope (`AE.search`) | **Full-text over the whole archive** via FTS5, optionally including reasoning and tool blocks | AE search is bounded by what was indexed (4 MiB payload / 1 MiB text per conversation); AS searches the native index |
| Filters | Mode, model, vote outcome, update time, and reasoning/tool scope | Mode, votes, claimed model, update time, with removable chips and counts | |
| Insights | Yes — activity, modes, votes, model record, completeness, tools, from the local library | Yes — activity, modes, votes by outcome, per-model record | |
| Datasets | No | Yes — recipe-driven, evidence-tiered, audited splits (JSONL) | |
| MCP server | No | Yes — read-only `list_conversations`, `search`, `get`, `export` | |
| Bulk export of everything listed | Yes, in 3.0 — current filtered list as one stored-entry ZIP, per-file SHA-256, manifest, explicit omissions; 128 MiB cap | Yes — one folder, per-file SHA-256, manifest, every exclusion with a reason | AE exports library records; AS exports its native archive |

### Export

| Capability | AE | AS | Note |
| --- | --- | --- | --- |
| JSON | Schema 2.1, documented + machine-validated, stable across 2.x | Raw and Normalized JSON, own shapes | AE has a versioned compatibility contract; AS documents formats but has no schema file |
| Markdown | Yes | Yes | |
| JSONL | Yes, plus per-record streaming schema | Yes, per conversation | |
| Last answer scope | Yes | Yes, with its triggering prompt | |
| Clipboard | Yes | Yes | |
| Determinism | Export carries `exported_at`, so bytes differ between runs | No export timestamp; same snapshot yields the same bytes | AS pins byte-equality in tests for its formats |

### Platform and engineering

| Capability | AE | AS |
| --- | --- | --- |
| Platforms | Chrome/Chromium and Firefox 140+ on any OS; optional macOS helper | macOS 14+, Apple Silicon only |
| Runtime dependencies | None | GRDB.swift, pinned exactly to 7.11.1 |
| Code size | 12,784 lines of hand-written JavaScript in `src/`; the checked-in `firefox/` tree is a generated copy; 702 lines of optional Swift | 30,698 lines of Swift (app 5,523; protocol 8,137; core 12,540; MCP 1,110; tools 3,962) |
| Build | Node 20+, reproducible Chrome/Firefox ZIPs; `firefox/` is generated and checked in | Xcode, Swift 6.1, Python 3; build/package scripts, no releases |
| Tests | 35 JavaScript suites, 4,818 lines; browser APIs and IndexedDB simulated; project + schema + lint checks; optional Playwright smoke | 9,745 lines, 576 unique test function names, independent Python journal reader, SIGKILL crash gate |
| CI | None (`.github` absent) | None (`.github` absent) |
| Licence | None in repo | None in repo |
| Docs | 13 docs (820 lines) + README + changelog | 73 Markdown files under `Docs/` (82 repo-wide), including 22 dated reviews, ADRs 0001–0006, a protocol ledger, and a 33 KB master plan |

## 2. Where the difference is structural, not a backlog item

AE's premise is that the browser already has everything: the stream, the retries, the
headers, the requested models. It observes them and turns them into a transcript with
provenance. Its gaps are about what to do *after* capture — reading, searching, indexing.

AS's premise is that the archive must be authoritative, reproducible and safe to keep for
years. It therefore records server bytes with digests, rebuilds its index, and refuses
behaviour that could put the account at risk or corrupt the record. Its gap list is exactly
the evidence that only exists on the wire.

AS's own analysis (`Docs/arena-exporter-gaps-2026-10-19.md`) reached the same conclusion and
marked items 3, 4, 5 (failed retries, stream framing, requested models) as **unclosable
without reading the page live**, which ADR 0006 forbids. That is why the two tools are
complementary rather than competing: one can be right where the other is blind, and neither
can absorb the other's advantage without abandoning its design.

## 3. The reciprocity: AS has already measured AE

AS keeps a gap analysis that compared AE at exactly `1168227` (this repo's current HEAD).
Five of its nine items were closed in AS between 2026-10-19 and 2026-10-21:

- **Agent conversations** (item 1): AS now reads `/agent/{id}`, first 20 messages, partial flag.
- **Attachments** (item 2): AS downloads signed R2 files into a content-addressed store.
- **Vote correction** (item 6): local notes, never sent to Arena.
- **Archive features** (item 7): encryption done, import skipped, GitHub backup not built (left as a separate decision).
- **Export options** (item 8): last answer, clipboard, JSONL.

Two corrections to that document's framing, for the record:

- It says AE's popup "sends `AE_SET_MANUAL_VOTE`". That is an **extension-internal message**,
  not a network vote: `src/message-router.js` records it in local session state with
  `source: "manual"` and schedules a storage save. AE never votes on Arena either. The real
  difference is that AE lets that local record **replace** the exported outcome, while AS's
  note deliberately never changes Arena's vote in exports or Insights.
- Item 9 ("other platforms") is not a gap AS could close; it is the platform choice itself.

Reciprocally, AE 3.0 now has a bounded reader, full-text search, insights, health checks,
and bulk export, but still no dataset pipeline, MCP server, multi-account isolation, native
journal, or whole-archive index; its macOS reader remains small (a 134-line SwiftUI app over
a 210-line store, showing one Markdown file). AS has those deeper layers but no live capture.
AS also skipped importing AE archives, so running both produces two independent archives
that must be searched separately.

## 4. Strengths, honestly

**AE is stronger at:** evidence fidelity (retries, outcomes, headers, requested models),
portability (two browsers, three OS families), zero runtime dependencies, a documented
versioned export schema, automatic per-turn archiving, GitHub off-site backup, and a
human-browsable archive tree that needs no app to read.

**AS is stronger at:** whole-archive reading and FTS5 search, multi-account isolation,
durability engineering (journal seals, digests, crash recovery, rebuildable index), encrypted
backups, research features (datasets, recipe-driven splits), read-only MCP integration, and
process documentation (ADRs, protocol ledger, dated observations, reviews). AE has narrowed
the reading/search/insights gap with a browser-sized library, not a native index.

**Weaknesses worth naming:**

- AE's tests simulate the browser and IndexedDB; its own docs say they do not establish live
  Arena compatibility or real quota/eviction behavior. Its local library is bounded and
  plaintext, so it is disabled while archive encryption is on; its macOS reader is still a
  stub compared with AS.
- AS cannot be built or tested outside macOS; its live-capture claims are limited by design,
  and its status page is self-reported. It has no release tags and no CI, so "what works" is
  what `Docs/status.md` says works.
- Both ship without a licence file and without CI. Neither can import the other's data.

## 5. Bottom line

Choose **AE** if the point is to keep the *evidence* — what was sent, what failed, which
models were requested, what the stream actually said — and to search and read a practical
working set on any desktop browser, with off-site backup. Choose **AS** if the point is to
*use* a large Mac archive — native FTS5, filters, datasets, MCP, multi-account isolation,
and storage durable enough to delete the browser profile.

Using both is coherent, and together they cover all nine capabilities AS catalogued: AE
supplies the wire evidence (items 3–5 and per-turn saving) and the non-Mac platforms, AS
supplies the reader, research and durability layer. The cost is two archives with no bridge;
the benefit is that each side stays honest about what it can prove.

## Appendix: how this was checked

- Read both repositories in full tree form, including AE's `src/`, `tests/`, `docs/`,
  `schemas/`, `macos/`, and AS's `Packages/`, `App/`, `Docs/` (status, plan v3, ADRs 0001–0006,
  protocol ledger, dated observations and reviews).
- Ran `npm test` in AE at 3.0: **35/35 suites passed**, project check, export-schema
  validation, and lint passed (Node 22.22.3). The historical 2.2.2 baseline was 28/28.
- Could **not** build or test AS: the sandbox is Linux and has no Swift toolchain. AS
  statements above come from its source and documentation, including its own status page,
  and are not independently reproduced here.
- Line and file counts were measured with `wc`/`find` on both checkouts; AE's `firefox/` tree
  is generated output and was excluded from source counts. AS's test count is the number of
  distinct test function names, not executed cases.
