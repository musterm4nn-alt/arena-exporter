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

/* Confirms the production write path is silent and lands where requested.
 *
 * Established by earlier runs of this probe:
 *  - nested real directories under the Downloads root work, silently
 *  - a directory symlinked OUT of Downloads is refused: Chrome pops a Save As
 *    dialog, then reports state "complete" while having silently dropped the
 *    directory and written to the Downloads root. It creates the directory
 *    during path reservation first, so a created folder proves nothing.
 *  - erasing an in_progress record can strand the write; only erase terminal
 *    items. */
function downloadProbe(relPath, text) {
  const url = "data:text/plain;charset=utf-8," + encodeURIComponent(text);
  return new Promise((resolve) => {
    chrome.downloads.download({ url, filename: relPath, conflictAction: "overwrite", saveAs: false }, (id) => {
      const err = chrome.runtime.lastError;
      if (err || id == null) { resolve({ requested: relPath, ok: false, error: (err && err.message) || "no id" }); return; }
      let tries = 0;
      const poll = () => {
        chrome.downloads.search({ id }, (items) => {
          const it = items && items[0];
          if (!it) { resolve({ requested: relPath, ok: false, id, error: "record vanished" }); return; }
          const terminal = it.state === "complete" || it.state === "interrupted";
          if (!terminal && tries++ < 150) { setTimeout(poll, 100); return; } // up to 15s
          resolve({
            requested: relPath, id, ok: it.state === "complete", state: it.state,
            danger: it.danger, paused: it.paused, error: it.error || null,
            bytes: it.bytesReceived, resolved: it.filename || null
          });
        });
      };
      poll();
    });
  });
}

function fmt(label, r) {
  const parts = [label + ":", r.state || (r.error ? "no-start" : "?")];
  if (r.danger && r.danger !== "safe") parts.push("danger=" + r.danger);
  if (r.paused) parts.push("PAUSED");
  if (r.error) parts.push("err=" + r.error);
  if (r.bytes != null) parts.push(r.bytes + "B");
  if (r.resolved) parts.push("-> " + r.resolved);
  return parts.join(" ");
}

$("btn-dl-probe").addEventListener("click", async () => {
  const el = $("dl-result");
  el.textContent = "running (up to 30s)…";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const lines = [];

  let silent = "unavailable";
  try {
    if (chrome.downloads.setUiOptions) {
      await new Promise((r) => chrome.downloads.setUiOptions({ enabled: false }, () => { void chrome.runtime.lastError; r(); }));
      silent = chrome.runtime.lastError ? "error: " + chrome.runtime.lastError.message : "suppressed";
    }
  } catch (e) { silent = "error: " + ((e && e.message) || e); }
  lines.push("download UI: " + silent);

  const control = await downloadProbe("arena-probe-control/probe-" + stamp + ".txt", "control write " + stamp + "\n");
  lines.push(fmt("CONTROL (Downloads root)", control));

  const linked = await downloadProbe("arena-archive/_probe/probe-" + stamp + ".txt", "symlink write " + stamp + "\n");
  lines.push(fmt("ARCHIVE PATH", linked));

  // only now, and only terminal items
  for (const r of [control, linked]) {
    if (r.id != null && r.state && r.state !== "in_progress") {
      await new Promise((res) => chrome.downloads.erase({ id: r.id }, () => { void chrome.runtime.lastError; res(); }));
    }
  }
  try { if (chrome.downloads.setUiOptions) chrome.downloads.setUiOptions({ enabled: true }, () => { void chrome.runtime.lastError; }); } catch (e) {}

  el.textContent = lines.join("  ||  ");
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
