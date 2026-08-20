/* Options page. Currently hosts the File System Access spike: can the service
 * worker keep writing to a user-chosen folder after a full browser restart? */
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

function renderLog(log) {
  const ol = $("fs-log");
  ol.textContent = "";
  (log || []).slice().reverse().forEach((entry) => {
    const li = document.createElement("li");
    const verdict = entry.ok ? "wrote" : entry.stage;
    li.textContent = `${entry.at.replace("T", " ").slice(0, 19)} — ${verdict}` +
      (entry.permission ? ` (permission: ${entry.permission})` : "");
    ol.appendChild(li);
  });
  if (!ol.children.length) ol.textContent = "no runs yet";
}

async function refresh() {
  $("fs-support").textContent = AE.fsSupported()
    ? "showDirectoryPicker() available — Chromium path active."
    : "showDirectoryPicker() NOT available in this browser (expected on Firefox/Safari; the Downloads sink would be used there).";

  const root = await AE.fsLoadRoot();
  $("fs-root").textContent = root ? (root.name || "(unnamed)") : "none chosen";
  $("fs-perm").textContent = await AE.fsPermission(root);
  return root;
}

/* No user gesture here on purpose — this is the condition a real sync faces. */
async function autoTest() {
  const res = await send({ type: "AE_FSA_TEST" });
  if (!res) { $("fs-result").textContent = "no response from the service worker"; return; }
  const bits = [`stage: ${res.stage}`];
  if (res.permission) bits.push(`permission: ${res.permission}`);
  if (res.path) bits.push(`wrote ${res.path}`);
  if (res.error) bits.push(`error: ${res.error}`);
  $("fs-result").textContent = (res.ok ? "PASS — " : "not yet — ") + bits.join(", ");
  renderLog(res.log);
}

$("btn-pick").addEventListener("click", async () => {
  if (!AE.fsSupported()) { $("fs-result").textContent = "not supported in this browser"; return; }
  try {
    const dir = await self.showDirectoryPicker({ mode: "readwrite", startIn: "documents" });
    if (dir.requestPermission) await dir.requestPermission({ mode: "readwrite" });
    await AE.fsSaveRoot(dir);
    await refresh();
    await autoTest();
  } catch (e) {
    $("fs-result").textContent = "picker cancelled or failed: " + ((e && e.message) || e);
  }
});

$("btn-test").addEventListener("click", async () => { await refresh(); await autoTest(); });

$("btn-forget").addEventListener("click", async () => {
  await AE.fsClearRoot();
  await refresh();
  $("fs-result").textContent = "folder forgotten";
});

$("btn-ping").addEventListener("click", pingHost);

function pingHost() {
  const el = $("host-status");
  el.textContent = "Pinging…";
  chrome.runtime.sendMessage({ type: "AE_PING_HOST" }, (res) => {
    void chrome.runtime.lastError;
    el.textContent = res && res.ok
      ? "Host ok. root=" + (res.root || "?")
      : "Host not installed (expected — the host-free path replaces it).";
  });
}

(async () => {
  await refresh();
  await autoTest();   // runs with zero user activation
  pingHost();
})();
