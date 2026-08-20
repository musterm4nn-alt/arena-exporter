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

/* Does chrome.downloads follow a symlinked subdirectory, and can the write be
 * made silent? chrome.downloads.search reports the path Chrome actually used,
 * which is the only reliable way to find out. */
function downloadAndResolve(relPath, text) {
  const url = "data:text/plain;charset=utf-8," + encodeURIComponent(text);
  return new Promise((resolve) => {
    chrome.downloads.download({ url, filename: relPath, conflictAction: "overwrite", saveAs: false }, (id) => {
      const err = chrome.runtime.lastError;
      if (err || id == null) { resolve({ ok: false, error: (err && err.message) || "no download id" }); return; }
      let tries = 0;
      const poll = () => {
        chrome.downloads.search({ id }, (items) => {
          const it = items && items[0];
          if (!it) { resolve({ ok: false, error: "download vanished", id }); return; }
          if (it.state === "in_progress" && tries++ < 40) { setTimeout(poll, 100); return; }
          resolve({ ok: it.state === "complete", id, state: it.state, resolved: it.filename, error: it.error || null });
        });
      };
      poll();
    });
  });
}

$("btn-dl-probe").addEventListener("click", async () => {
  const el = $("dl-result");
  el.textContent = "running…";
  const bits = [];

  // 1. can the download UI be suppressed?
  let silent = "unavailable";
  try {
    if (chrome.downloads.setUiOptions) {
      await new Promise((r) => chrome.downloads.setUiOptions({ enabled: false }, () => { void chrome.runtime.lastError; r(); }));
      silent = chrome.runtime.lastError ? ("error: " + chrome.runtime.lastError.message) : "suppressed";
    }
  } catch (e) { silent = "error: " + ((e && e.message) || e); }
  bits.push("download UI: " + silent);

  // 2. write through the symlinked subdirectory
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const res = await downloadAndResolve("arena-archive/_probe/chrome-probe-" + stamp + ".txt",
    "written by chrome.downloads at " + new Date().toISOString() + "\n");
  bits.push("state: " + (res.state || "n/a"));
  if (res.resolved) bits.push("resolved path: " + res.resolved);
  if (res.error) bits.push("error: " + res.error);

  // 3. can the history entry be erased?
  if (res.id != null) {
    const erased = await new Promise((r) => chrome.downloads.erase({ id: res.id }, (ids) => { void chrome.runtime.lastError; r(ids || []); }));
    bits.push("history erased: " + (erased.length ? "yes" : "no"));
  }

  // restore the UI so normal downloads are unaffected
  try { if (chrome.downloads.setUiOptions) chrome.downloads.setUiOptions({ enabled: true }, () => { void chrome.runtime.lastError; }); } catch (e) {}

  el.textContent = (res.ok ? "PASS — " : "FAIL — ") + bits.join(" | ");
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
