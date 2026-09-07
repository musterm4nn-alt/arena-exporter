# 2.1.2 verification

The September 7 permissions fix was verified with Chrome's `browser` namespace present, Firefox data-consent enforcement, and thrown permission requests. It preserves the 2.1.1 capture and icon fixes. Chrome's retained error list included the old standalone `src/content.js:184` implementation; 2.1.1 and later load `src/injected-content.js` instead. Old error entries alone do not establish a new failure.

References: [Chrome browser namespace](https://developer.chrome.com/docs/extensions/develop/concepts/browser-namespace), [Firefox permissions.request](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/permissions/request).

## Automated checks

Run `npm test` or `node tools/run-tests.mjs` with Node 20 or newer. The runner builds both browser packages and runs all 20 JavaScript suites. All 20 passed on September 7, 2026.

Coverage includes network streaming, tab/request isolation, multiple turns, DOM fallback, model provenance, scoped exports, cancelled downloads, archive writes, native fallback, GitHub retries/privacy, Firefox background loading, serialized persistence, popup/workspace controls and preferences. New injection regressions load each packaged execution-world bundle independently, including a browser-style shared-URL deduplication simulation, and verify capture bridging, redaction and snapshot error responses.

The UI harness exercises production controllers with a lightweight document fixture. It does not provide a rendering engine or full accessibility validation.

## Chrome checks, September 5–6

- Reproduced the 2.1.0 popup stuck on loading, missing toolbar icons and the broken page-to-extension bridge. Loaded 2.1.1 into the existing unpacked Chrome installation and verified that the popup opened and capture resumed.
- Visually inspected the Departure Mono popup, scope controls, format menu and archive status.
- Saved a three-round Battle through the native archive app and inspected its JSON and Markdown on disk. The archive contained three prompts, six replies, 165 tool-call records and file data. This does not establish complete capture: a stream-completeness warning was present.
- Downloaded Last answer JSON and full-conversation Markdown through the actual popup. Chrome reported both downloads complete. The scoped JSON contained one Battle round, one request and no raw stream samples.
- Found that the native host cannot reveal folders. The revised interface displays the actual native folder path instead of reporting an opened folder. Downloads-based folder reveal remains separately covered by tests.

## Remaining limitations

The Battle already running before the bridge repair was only partially recoverable from the page. Missing historical prompts, hidden reasoning and tool bodies cannot be assumed recovered. The newer archive contained no reasoning text.

Model labels in the newer export did not match the model tabs visible in the current Arena preview. Attribution across rounds and the current page layout needs further investigation. Do not treat those labels as verified training-data attribution solely because a provenance field is present.

The final auxiliary-data filtering, placeholder-label and native-folder-path adjustments passed automated checks but have not all been re-exercised after a browser reload. Installed Firefox behavior, macOS native behavior and a real extension-initiated GitHub backup were not exercised in these checks.

`npm run preview` serves explicitly labeled synthetic fixtures. These fixtures are excluded from the packages and are not evidence of live capture.

## Browser API references

- [MDN background manifest](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background)
- [Chrome downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads)
