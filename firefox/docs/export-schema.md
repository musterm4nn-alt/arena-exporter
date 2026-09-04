# Export metadata in schema 2.1

Schema 2.1 adds provenance and transport evidence without removing the schema 2.0 conversation structures. A consumer can continue to use `messages[]`, `battles[]`, and `attribution_samples[]` while adopting the fields below incrementally.

## Mode and shape

`export.source.mode` preserves the observed Arena mode instead of mapping every evaluation to Battle.

| Mode | Main output | Lanes | Outcome |
| --- | --- | ---: | --- |
| `agent` | `messages[]` | — | — |
| `battle` | `battles[]` | A and B | `pending`, `a_wins`, `b_wins`, `both_good`, or `neither_good` |
| `direct` / `direct-battle` | `battles[]` | A only | `not_applicable` |
| `side-by-side` | `battles[]` | A and B | `not_applicable` |

The existing `battles` name remains the compatibility container for selected-model evaluation turns. `mode` on each round identifies its actual semantics.

History API backfill can retain a single Direct answer as a user/assistant pair in `messages[]`; its observed mode and separately stored model ID are still preserved.

## Model fields

The extension does not infer identity from a field merely named `model`.

| Field | Meaning |
| --- | --- |
| `requested_model_id` | UUID sent for the lane in the captured request |
| `catalog_model_id` | Matching row ID from the public page catalog |
| `model` | Human-readable label when one is available |
| `model_source` | Evidence that supplied the label, such as `request_catalog` or `arena_reveal` |
| `model_identity_verified` | `true` only when Arena revealed the Battle identity, otherwise `false` |
| `catalog_*` / `catalog_entry` | Public selection metadata preserved separately from serving identity |

`session.orchestrator_model` is `null` and `session.orchestrator_model_source` is `not_revealed` for Agent unless Arena explicitly publishes a reveal. This is a valid result, not a capture failure. `meta.model_hints` can retain bounded incidental names for diagnostics; entries there are unverified and must not be used for attribution.

`attribution_samples[]` repeats the relevant label, source, requested/catalog IDs, and verification flag beside each output. Empty and failed responses do not become samples.

## Request attempts

`meta.request_attempts[]` has one entry per request ID. Useful fields include:

- `request_id`, `url`, `method`, `started_at`, `responded_at`, and `completed_at`
- `evaluation_id` and `turn_id`
- `requested_model_a_id`, `requested_model_b_id`, `requested_agent_model_id`, and `requested_harness_id`
- `retry_of` for an earlier attempt at the same turn
- `status`, bounded safe `response_headers`, `error`, and `transport_error`
- `outcome`: `pending`, `streaming`, `completed`, `http_error`, `selection_rejected`, `captcha_rejected`, `network_error`, `stream_error`, or `aborted`
- `selection_rejected: true` when the server explicitly reports that the selected model is unavailable for user selection

An observed `userSelectable: false` catalog flag is descriptive. Only the server response determines whether the request was accepted.

## Page and transport metadata

`meta.transcript` retains page metadata including pagination, transcript read strategy, product mode, feedback type, and a sanitized session record. Assistant node/feedback metadata appears on each message. If `pagination.hasMore` is true, completeness remains amber and a warning explains that earlier messages may be absent. The exporter does not invent a pagination endpoint.

`meta.model_catalog` records the catalog source URL, capture time, and row count. Catalog rows used by a contestant appear on that contestant rather than as an unbounded copy in export metadata.

`meta.transport` records selected response headers, event counts, and logical completion evidence. Only `x-session-settled`, `x-stream-version`, and `x-arena-chat-id` are eligible response headers.

`meta.evaluation_streams` contains only bounded streams that were not parsed into lanes. Known, completed streams are represented by their structured outputs and are not duplicated as raw text.

## Privacy and completeness

The exporter filters known credential keys, nested JSON strings, query parameters, header pairs, JWT patterns, and raw authorization syntax before storage and again before final serialization. A sanitized request attempt is diagnostic capture data, not a replayable authenticated request.

`meta.completeness_detail.status` remains amber for unresolved pagination, unparsed or interrupted streams, missing expected files, DOM/history fallback, and unknown model labels where labels are expected. Agent's intentionally undisclosed orchestrator does not by itself mean the transcript is incomplete.
