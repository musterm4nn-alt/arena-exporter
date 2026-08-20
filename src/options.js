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

$("chk-silent").addEventListener("change", async (e) => {
  await send({ type: "AE_SET_SILENT", enabled: e.target.checked });
});

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
  chrome.storage.local.get(["ae_silent_writes"], (r) => {
    void chrome.runtime.lastError;
    $("chk-silent").checked = !r || r.ae_silent_writes !== false;
  });
  await loadIndex();
})();
