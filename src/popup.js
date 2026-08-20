/* Popup controller: context detection, capture status, export actions. */
"use strict";

const $ = (id) => document.getElementById(id);

const ARENA_URL_RE = /^https:\/\/([^/]+\.)?arena\.ai\//i;

/* Show the active build version in the popup header (read live from the
 * manifest so it always matches what chrome://extensions reports). */
try {
  $("version-badge").textContent = "v" + chrome.runtime.getManifest().version;
} catch (e) { /* badge stays "v?" */ }

function setDot(cls) {
  const dot = $("status-dot");
  dot.className = "dot " + cls;
}

function showProgress(text) {
  const card = $("progress");
  card.classList.remove("hidden");
  $("progress-msg").textContent = text;
}

function hideProgress() {
  $("progress").classList.add("hidden");
}

function sendBg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      void chrome.runtime.lastError;
      resolve(res || null);
    });
  });
}

function sendTab(tabId, msg) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (res) => {
        void chrome.runtime.lastError;
        resolve(res || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

/* ---------- rendering ---------- */

function renderState(st) {
  $("stats").classList.remove("hidden");
  $("actions").classList.remove("hidden");
  $("stat-messages").textContent = st.messageCount;
  $("stat-thinking").textContent = st.blockCounts.thinking || 0;
  $("stat-tools").textContent = st.blockCounts.tool_call || 0;
  $("stat-commands").textContent = st.blockCounts.command || 0;
  $("stat-actions").textContent = st.blockCounts.action || 0;
  $("stat-artifacts").textContent = st.blockCounts.artifact || 0;
  $("stat-endpoints").textContent = st.endpointCount;
  const voteLabels = { A: "A", B: "B", both_good: "Both good", neither_good: "Both bad" };
  $("stat-vote").textContent = st.lastBattleVote ? (voteLabels[st.lastBattleVote.choice] || st.lastBattleVote.choice || "—") : "—";
  $("stat-streamchunks").textContent = st.streamChunkCount || 0;
  document.getElementById("row-streamchunks").classList.toggle("hidden", !(st.streamChunkCount > 0));

  setDot(st.streaming ? "streaming" : "live");
  $("status-dot").title = st.streaming ? "Agent response streaming…" : "Capture active";
  if (st.lastSync && st.lastSync.rel) {
    showProgress("Last archive: " + st.lastSync.rel + (st.lastSync.ok ? "" : " (failed)"));
  }

  const warnList = $("warning-list");
  warnList.textContent = "";
  if (st.warnings && st.warnings.length) {
    $("warnings").classList.remove("hidden");
    st.warnings.forEach((w) => {
      const li = document.createElement("li");
      li.textContent = w;
      warnList.appendChild(li);
    });
  } else {
    $("warnings").classList.add("hidden");
  }

  const list = $("endpoint-list");
  list.textContent = "";
  if (st.endpoints && st.endpoints.length) {
    $("endpoints").classList.remove("hidden");
    st.endpoints.forEach((e) => {
      const li = document.createElement("li");
      li.textContent = e.url;
      if (e.tier === "agent") li.className = "ep-agent";
      list.appendChild(li);
    });
  }
}

/* ---------- export flow ---------- */

let lastExport = null; // { json, filename }

async function doExport(mode) {
  const tab = await activeTab();
  $("btn-full").disabled = $("btn-last").disabled = true;
  showProgress(mode === "last_message" ? "Exporting last message…" : "Exporting full history…");

  // 1. Ask the page for a DOM snapshot (fallback/backfill + completeness check).
  let snapshot = null;
  if (tab && ARENA_URL_RE.test(tab.url || "")) {
    snapshot = await sendTab(tab.id, { type: "AE_DOM_SNAPSHOT" });
  }

  // 2. Build the merged export in the service worker.
  const res = await sendBg({ type: "AE_EXPORT", mode: mode, snapshot: snapshot });
  if (!res || !res.ok) {
    showProgress("Export failed — try reloading the extension.");
    $("btn-full").disabled = $("btn-last").disabled = false;
    return;
  }

  lastExport = { json: res.json, filename: res.filename };

  // 3. Fetch + save attachment bytes beside the JSON (ported from v1.4.0).
  let payload = null;
  try { payload = JSON.parse(res.json); } catch (e) { payload = null; }
  const stamp = stampNow();
  const dir = "arena-exporter-attachments/" + stamp + "/";
  const downloads = [];
  const failed = [];
  const inlineWarnings = [];
  let savedCount = 0;

  if (payload) {
    const urls = collectArtifactUrls(payload);
    if (urls.length && tab && ARENA_URL_RE.test(tab.url || "")) {
      showProgress("Fetching " + urls.length + " attachment(s)…");
      const fetched = await sendTab(tab.id, { type: "AE_FETCH_ATTACHMENTS", urls });
      const results = (fetched && fetched.results) || [];
      const titleByUrl = new Map();
      (payload.messages || []).forEach((m) => (m.content || []).forEach((b) => {
        if (b.type === "artifact" && b.content_or_url) titleByUrl.set(b.content_or_url, b.title || null);
      }));
      results.forEach((r) => { if (r && r.url && !r.title) r.title = titleByUrl.get(r.url) || null; });
      const att = AE.decorateAttachments(payload, results, dir);
      savedCount += att.saved.length;
      att.saved.forEach((s) => {
        const f = results.find((r) => r && r.ok && r.url === s.url);
        if (f && f.dataUrl) downloads.push({ dataUrl: f.dataUrl, path: s.path });
      });
      failed.push(...att.failed);
    }
    const inline = AE.decorateInlineArtifacts(payload, dir);
    savedCount += inline.saved.length;
    inline.saved.forEach((s) => downloads.push({ dataUrl: s.dataUrl, path: s.path }));
    inlineWarnings.push(...inline.warnings);
    payload.meta.attachments = { dir: dir, saved: savedCount, failed: failed, warnings: inlineWarnings };
    if (savedCount) payload.meta.warnings.push("Saved " + savedCount + " attachment(s) to Downloads/" + dir);
  }

  const finalJson = payload ? JSON.stringify(payload, null, 2) : res.json;
  lastExport = { json: finalJson, filename: res.filename };

  // 4. Save attachments (silent) first, then the JSON with its save dialog.
  for (const d of downloads) await downloadDataUrl(d.dataUrl, d.path);
  await downloadJson(finalJson, res.filename);
  showProgress(savedCount
    ? "Saved " + res.filename + " + " + savedCount + " attachment(s) → " + dir
    : "Saved " + res.filename);
  $("btn-full").disabled = $("btn-last").disabled = false;
}

function collectArtifactUrls(payload) {
  const seen = new Set();
  const out = [];
  (payload.messages || []).forEach((m) => (m.content || []).forEach((b) => {
    if (b.type !== "artifact" || typeof b.content_or_url !== "string") return;
    const u = b.content_or_url;
    if (!/^(https?:|blob:)/i.test(u) || seen.has(u)) return;
    seen.add(u);
    if (out.length < 30) out.push(u);
  }));
  return out;
}

function downloadDataUrl(dataUrl, filename) {
  return new Promise((resolve) => {
    chrome.downloads.download({ url: dataUrl, filename: filename, conflictAction: "overwrite", saveAs: false }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function stampNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function downloadJson(json, filename) {
  const url = "data:application/json;charset=utf-8," + encodeURIComponent(json);
  return new Promise((resolve) => {
    chrome.downloads.download({ url: url, filename: filename, saveAs: true }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

/* ---------- init ---------- */

async function init() {
  const tab = await activeTab();
  const onArena = tab && ARENA_URL_RE.test(tab.url || "");
  const res = await sendBg({ type: "AE_GET_STATE" });

  if (!onArena) {
    if (res && res.ok && res.state && res.state.messageCount > 0) {
      $("context-msg").textContent = "Not on arena.ai — showing the last captured session. Export still works.";
      renderState(res.state);
      setDot(res.state.streaming ? "streaming" : "live");
    } else {
      setDot("off");
      $("context-msg").textContent = "Open an arena.ai Agent or Battle chat to start capturing.";
    }
    return;
  }

  const ping = await sendTab(tab.id, { type: "AE_PING" });
  if (!ping) {
    $("context-msg").textContent = "Content script not injected yet — reload this page once, then reopen the popup.";
    if (res && res.ok && res.state) renderState(res.state);
    setDot("off");
    return;
  }

  $("context-msg").textContent = "Capturing on: " + (tab.url || "").replace(/^https:\/\//, "").slice(0, 48);

  if (res && res.ok) renderState(res.state);
}

if ($("btn-sync")) $("btn-sync").addEventListener("click", async () => {
  showProgress("Syncing to Arena Archive…");
  const res = await sendBg({ type: "AE_SYNC" });
  if (res && res.ok && res.sync && res.sync.rel) showProgress("Synced → " + res.sync.rel);
  else showProgress((res && res.sync && res.sync.error) || "Archive app not installed — JSON export still works.");
  if (res && res.state) renderState(res.state);
});
if ($("btn-full")) $("btn-full").addEventListener("click", () => doExport("full_history"));
$("btn-last").addEventListener("click", () => doExport("last_message"));

/* Manual vote override (ported from v1.4.0). */
async function setManualVote(choice) {
  const tab = await activeTab();
  const res = await sendBg({ type: "AE_SET_MANUAL_VOTE", choice: choice, url: (tab && tab.url) || "" });
  if (res && res.state) renderState(res.state);
  showProgress(choice === "clear" ? "Manual vote cleared." : "Manual vote set: " + choice);
}
$("vote-a").addEventListener("click", () => setManualVote("A"));
$("vote-b").addEventListener("click", () => setManualVote("B"));
$("vote-tie").addEventListener("click", () => setManualVote("both_good"));
$("vote-bad").addEventListener("click", () => setManualVote("neither_good"));
$("vote-clear").addEventListener("click", () => setManualVote("clear"));

$("btn-copy").addEventListener("click", async () => {
  const tab = await activeTab();
  let snapshot = null;
  if (tab && ARENA_URL_RE.test(tab.url || "")) snapshot = await sendTab(tab.id, { type: "AE_DOM_SNAPSHOT" });
  const res = await sendBg({ type: "AE_EXPORT", mode: "full_history", snapshot: snapshot });
  if (!res || !res.ok) return;
  try {
    await navigator.clipboard.writeText(res.json);
    showProgress("Copied full-history JSON to clipboard.");
  } catch (e) {
    showProgress("Clipboard write blocked — use Download instead.");
  }
});

$("btn-clear").addEventListener("click", async () => {
  await sendBg({ type: "AE_CLEAR" });
  showProgress("Capture buffer reset.");
  const res = await sendBg({ type: "AE_GET_STATE" });
  if (res && res.ok) renderState(res.state);
});

$("btn-domdebug").addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab || !ARENA_URL_RE.test(tab.url || "")) {
    showProgress("Open an arena.ai chat first.");
    return;
  }
  showProgress("Collecting DOM diagnostics…");
  const res = await sendTab(tab.id, { type: "AE_DOM_DEBUG" });
  if (!res) {
    showProgress("No response from content script — reload the page and retry.");
    return;
  }
  const payload = Object.assign({ exported_at: new Date().toISOString(), url: tab.url }, res);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  await downloadJson(JSON.stringify(payload, null, 2), "arena_dom_debug_" + stamp + ".json");
  showProgress("Saved DOM debug dump (redacted: structure kept, message text removed) — safe to share for selector tuning.");
});

init();

