# 2.1.0 verification

The overhaul uses the 1.18.0 transport/archive components, with one capture engine, a refactored runtime and a new interface. It does not package the experimental 2.0.0 engine alongside the repaired implementation.

## Automated checks

Run `npm test` (or `node tools/run-tests.mjs`) with Node 20 or newer. This builds the two browser distributions before running every JavaScript suite.

Coverage includes network response cloning/streaming, request and tab isolation, multiple turns, metadata and model provenance, DOM fallback, last-answer export, delayed Firefox Blob consumption, interrupted/cancelled downloads, archive paths and index handling, native fallback, GitHub retry/concurrency/privacy, generated Firefox background loading, preferences after restart, serialized persistence, parse-cache invalidation, and popup/library controller interactions.

The UI harness runs the production HTML's scripts with a lightweight document and browser-API fixture. It exercises search, pagination, filters, links, format/scope selection, copy, reset confirmation, action failures and disabled/empty states. It does not provide a rendering engine or claim full accessibility validation.

## Live-check limitation

No browser was connected to the available browser-control tool during this implementation. The in-app browser was unavailable and the browser inventory was empty. Consequently the new screens were not visually inspected in a live browser, and live Arena capture, an installed Firefox add-on, native macOS behavior and a real extension-initiated GitHub backup were not exercised during this release work.

`npm run preview` serves the actual popup and workspace at `http://127.0.0.1:4178/src/popup.html` and `/src/options.html`, using explicitly labeled synthetic data. Add `?fixture=empty`, `?fixture=error`, or `?fixture=streaming` to inspect popup states. These fixtures are excluded from the extension ZIPs. No Arena/GitHub requests are made by the preview.

Before relying on a newly installed build, check a short Agent conversation and a Battle, export the last answer, open the resulting folder, and verify a private-backup commit if backups are configured. This is the outstanding browser smoke check, not a claim that it has already passed.

## Browser API references

- Firefox uses ordered background scripts; Chrome uses a service worker. [MDN background manifest](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background).
- Export success waits for download completion, rather than the start callback. [Chrome downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads).
