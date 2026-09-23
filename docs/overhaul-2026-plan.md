# Arena Exporter 2.2 local overhaul plan

## Objective

Modernize the extension without replacing the proven capture engine with a speculative rewrite. Keep the existing public contracts while making privacy, capture correctness, archive reliability, and the operator experience substantially stronger.

## Compatibility contract

Preserve:

- Chrome manifest key and unpacked extension identity
- Firefox add-on ID `arena-agent-exporter@local`
- export schema `2.1`
- `ae_store_v2` and legacy `ae_state_v1` loading
- archive folder taxonomy and `_index.json`
- destination-specific archive hashes
- public message names used by the popup, workspace, and content bridge
- local-only operation and no runtime network dependencies

Additive changes may introduce runtime state and UI metadata, but existing JSON consumers must continue to work.

## Workstreams

### 1. Capture and privacy hardening

- Make semantic replay suppression message-scoped.
- Replace the session-wide artifact/action dedupe that can remove valid later turns.
- Harden structural redaction for nested JSON, URL credentials/fragments, GitHub tokens, and PEM/OpenSSH private keys.
- Preserve harmless URL bytes inside raw Arena stream grammars.
- Normalize Battle outcomes around the documented `neither_good` value while accepting legacy `both_bad` input.
- Add regression tests for multi-turn modes, retry outcomes, replay scope, redaction, and URL preservation.

### 2. Runtime reliability

- Keep explicit session routing and serialized persistence.
- Improve archive error reporting and destination switching.
- Make the Downloads/native size limits explicit in the UI and diagnostics.
- Preserve failed writes in the retry path and keep GitHub credentials out of exports, outbox data, and diagnostics.
- Add an explicit runtime compatibility/health summary rather than relying only on popup text.

### 3. Visual overhaul

- Replace the compressed/minified visual layer with a readable design system.
- Give the popup a clear capture-health rail, conversation summary, export actions, archive state, and backup state.
- Give the workspace a responsive library-first layout with stronger hierarchy, status chips, empty/error states, and accessible controls.
- Keep existing DOM IDs and message contracts where practical so current tests and integrations remain useful.
- Add reduced-motion, keyboard-focus, narrow-window, and high-contrast-friendly treatments.

### 4. Documentation and delivery

- Add architecture and security documents.
- Update README, verification notes, changelog, and generated Firefox documentation.
- Add local verification scripts and a reproducible release build.
- Do not push, publish, or modify GitHub state.

## Acceptance gates

- `npm test` passes on a clean checkout after the build step.
- `npm run build` produces Chrome and Firefox packages.
- Privacy tests prove secrets are removed without corrupting harmless raw URLs.
- Multi-turn Agent/Battle/Direct/Side-by-Side tests preserve turns and outcomes.
- UI harnesses exercise the redesigned popup and workspace controllers.
- The main source tree remains the source of truth; generated Firefox files are regenerated rather than hand-maintained.
- No live-browser or native-host claim is made without an actual acceptance run.
