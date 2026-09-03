/* Options page: archive location self-test, silent-write toggle, and a view of
 * what has been archived so far. */
"use strict";

const $ = (id) => document.getElementById(id);

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      void chrome.runtime.lastError;
      resolve(res || null);
    });
  });
}

$("btn-selftest").addEventListener("click", async () => {
  const el = $("selftest-result");
  el.textContent = "writing…";
  const res = await send({ type: "AE_TEST_ARCHIVE" });
  if (!res) { el.textContent = "no response from the service worker"; return; }
  if (res.ok) {
    el.textContent = "PASS — wrote " + (res.resolved || res.path);
    $("archive-path").textContent = (res.resolved || "").replace(/[^/\\]+$/, "");
  } else {
    el.textContent = "FAIL — " + (res.error || "unknown") +
      (res.resolved ? " (landed at " + res.resolved + ")" : "");
  }
});

function canSilentWrites() {
  return !!(typeof chrome !== "undefined" && chrome.downloads &&
    typeof chrome.downloads["setUiOptions"] === "function");
}

function requestDownloadsUi() {
  return new Promise((resolve) => {
    if (!chrome.permissions || typeof chrome.permissions.request !== "function") {
      resolve(false);
      return;
    }
    try {
      chrome.permissions.request({ permissions: ["downloads.ui"] }, (granted) => {
        void chrome.runtime.lastError;
        resolve(!!granted);
      });
    } catch (e) {
      resolve(false);
    }
  });
}

$("chk-silent").addEventListener("change", async (e) => {
  const enabled = e.target.checked;
  const note = $("silent-note");
  if (note) note.textContent = "";
  if (enabled) await requestDownloadsUi();
  const res = await send({ type: "AE_SET_SILENT", enabled: enabled });
  if (enabled && (!res || res.suppressed !== true)) {
    e.target.checked = false;
    if (note) note.textContent = "Could not suppress the download UI in this browser.";
  }
});


function renderNativeStatus(st) {
  const el = $("native-status");
  if (!el) return;
  if (!st) { el.textContent = "Arena Archive host: unknown"; return; }
  if (st.state === "ok") el.textContent = "Arena Archive host detected.";
  else if (st.state === "no-root") el.textContent = "Arena Archive host detected — no folder chosen. Open Arena Archive and pick a folder.";
  else if (st.state === "missing") el.textContent = "Arena Archive host missing — using Downloads.";
  else el.textContent = "Arena Archive host: " + (st.error || "error") + " — using Downloads.";
}

async function loadIndex() {
  const res = await send({ type: "AE_ARCHIVE_INDEX" });
  const index = (res && res.index) || {};
  const keys = Object.keys(index);
  const list = $("index-list");
  list.textContent = "";
  if (!keys.length) {
    $("index-summary").textContent = "Nothing archived yet.";
    return;
  }
  const pending = keys.filter((k) => index[k].models_pending).length;
  $("index-summary").textContent =
    `${keys.length} conversation(s) archived` + (pending ? ` — ${pending} still awaiting model names` : "");
  keys
    .sort((a, b) => String(index[b].updated_at || "").localeCompare(String(index[a].updated_at || "")))
    .slice(0, 40)
    .forEach((k) => {
      const e = index[k];
      const li = document.createElement("li");
      const models = (e.models || []).length ? (e.models || []).join(" vs ") : "models pending";
      li.textContent = `${e.rel} — ${e.turns || 0} turn(s) — ${models}`;
      list.appendChild(li);
    });
}

(async () => {
  if (!canSilentWrites()) {
    $("chk-silent").disabled = true;
    const note = $("silent-note");
    if (note) note.textContent = "Not available in this browser (Chrome-only).";
  }
  chrome.storage.local.get(["ae_silent_writes"], (r) => {
    void chrome.runtime.lastError;
    $("chk-silent").checked = !!(r && r.ae_silent_writes) && canSilentWrites();
  });
  await loadIndex();
  renderNativeStatus(await send({ type: "AE_NATIVE_STATUS" }));
})();
