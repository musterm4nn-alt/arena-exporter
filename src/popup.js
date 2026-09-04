/* Popup controller: context detection, capture status, export actions. */
"use strict";

const $ = (id) => document.getElementById(id);

const ARENA_URL_RE = /^https:\/\/([^/]+\.)?(arena\.ai|lmarena\.ai)\//i;

/* Show the active build version in the popup header (read live from the
 * manifest so it always matches what chrome://extensions reports). */
try {
  $("version-badge").textContent = "v" + chrome.runtime.getManifest().version;
} catch (e) { /* badge stays "v?" */ }

function setDot(cls) {
  const dot = $("status-dot");
  dot.className = "dot " + cls;
}

function isBusyStatus(text) {
  const t = String(text || "");
  if (/…$/.test(t) || /\.\.\.$/.test(t)) return true;
  return /^(Listing|Fetching|Writing|Exporting|Archiving|Collecting|Saved DOM)/i.test(t);
}

function showProgress(text, grade) {
  const msg = $("progress-msg");
  const card = $("progress");
  if (!msg || !card) return;
  msg.textContent = "";
  msg.appendChild(document.createTextNode(text || "Idle"));
  if (grade) {
    const g = String(grade).toLowerCase();
    const span = document.createElement("span");
    span.className = "grade-" + (g === "green" || g === "full" ? "green"
      : g === "amber" || g === "partial" ? "amber"
      : g === "red" ? "red" : "amber");
    span.textContent = " [" + String(grade).toUpperCase() + "]";
    msg.appendChild(span);
  }
  card.classList.toggle("busy", isBusyStatus(text));
}

function hideProgress() {
  showProgress("Idle");
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


function renderSinkStatus(st) {
  const el = $("sink-status");
  if (!el) return;
  const n = st && st.nativeSink;
  if (n && n.state === "ok") {
    el.textContent = "Writing via Arena Archive app";
  } else if (n && n.state === "no-root") {
    el.textContent = "Open Arena Archive and pick a folder — using Downloads until then";
  } else {
    el.textContent = "Archive: Downloads/arena-archive/";
  }
}

function ledClass(st, onArena) {
  if (st.lastSync && st.lastSync.ok === false) return "error";
  if (st.captureHealthCritical) return "error";
  if (st.streaming) return "stream";
  if (!onArena) return "idle";
  if (st.nativeSink && st.nativeSink.state === "ok") return "ok";
  return "warn";
}

let popupOnArena = false;

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

  const nativeOk = !!(st.nativeSink && st.nativeSink.state === "ok");
  setDot(ledClass(st, popupOnArena));
  $("status-dot").title = (st.lastSync && st.lastSync.ok === false) ? "Last archive write failed"
    : st.captureHealthCritical ? "Capture health failure"
    : st.streaming ? "Agent response streaming…"
    : nativeOk ? "Archive connected"
    : popupOnArena ? "Archive app not connected — using Downloads"
    : "Idle";
  if (st.lastSync && st.lastSync.rel) {
    showProgress(
      "Last archive: " + st.lastSync.rel + (st.lastSync.ok ? "" : " (failed)"),
      st.lastSync.completeness
    );
  }

  const warnList = $("warning-list");
  warnList.textContent = "";
  const warnings = (st.warnings || []).slice();
  if (st.requestOutcome && /error|rejected|aborted/.test(st.requestOutcome.outcome || "")) {
    warnings.push("Latest request: " + st.requestOutcome.outcome.replace(/_/g, " ") + (st.requestOutcome.error ? " — " + st.requestOutcome.error : ""));
  }
  if (warnings.length) {
    $("warnings").classList.remove("hidden");
    warnings.forEach((w) => {
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
  renderSinkStatus(st);
}

/* ---------- export flow ---------- */

let lastExport = null; // { json, filename }

async function doExport(mode) {
  const tab = await activeTab();
  $("btn-full").disabled = $("btn-last").disabled = true;
  showProgress(mode === "last_message" ? "Exporting last message…" : "Exporting full chat…");
  try {
    let snapshot = null;
    if (tab && ARENA_URL_RE.test(tab.url || "")) {
      snapshot = await sendTab(tab.id, { type: "AE_DOM_SNAPSHOT" });
    }
    const res = await sendBg(Object.assign({
      type: "AE_EXPORT", mode: mode, snapshot: snapshot, save: true
    }, tabRequestContext(tab)));
    if (!res || !res.ok) {
      showProgress((res && res.error) ? ("Export failed: " + res.error) : "Export failed — try reloading the extension.");
      return;
    }
    lastExport = { json: res.json, filename: res.filename };
    showProgress(res.savedCount
      ? "Saved " + res.filename + " + " + res.savedCount + " attachment(s)"
      : "Saved " + res.filename);
  } catch (e) {
    showProgress("Export failed: " + e);
  } finally {
    $("btn-full").disabled = $("btn-last").disabled = false;
  }
}

function collectArtifactUrls(payload) {
  if (typeof AE !== "undefined" && AE.collectArtifactUrls) return AE.collectArtifactUrls(payload, 50);
  const seen = new Set();
  const out = [];
  (payload.messages || []).forEach((m) => (m.content || []).forEach((b) => {
    if (b.type !== "artifact" || typeof b.content_or_url !== "string") return;
    const u = b.content_or_url;
    if (!/^(https?:|blob:)/i.test(u) || seen.has(u)) return;
    if (/^https?:/i.test(u) && !/^https:\/\/([^/]+\.)?(arena\.ai|lmarena\.ai)\//i.test(u)) return;
    seen.add(u);
    if (out.length < 50) out.push(u);
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
  return sendBg({ type: "AE_SAVE_TEXT", filename: filename, text: json, mime: "application/json;charset=utf-8", saveAs: true });
}

/* ---------- init ---------- */

async function init() {
  const tab = await activeTab();
  const onArena = tab && ARENA_URL_RE.test(tab.url || "");
  if ($("btn-folder")) $("btn-folder").disabled = !(onArena && conversationKeyFromHref(tab.url));
  refreshBackupStatus();
  let snapshot = null;
  if (onArena) snapshot = await sendTab(tab.id, { type: "AE_DOM_SNAPSHOT" });
  const res = await sendBg(Object.assign({ type: "AE_GET_STATE", snapshot }, tabRequestContext(tab)));

  popupOnArena = onArena;
  if (!onArena) {
    if (res && res.ok && res.state && res.state.messageCount > 0) {
      $("context-msg").textContent = "Not on arena.ai — showing the last captured session. Export still works.";
      renderState(res.state);
      setDot(ledClass(res.state, false));
    } else {
      setDot("idle");
      $("context-msg").textContent = "Open an arena.ai Agent or Battle chat to start capturing.";
      if (res && res.state) renderSinkStatus(res.state);
    }
    return;
  }

  const ping = await sendTab(tab.id, { type: "AE_PING" });
  if (!ping) {
    $("context-msg").textContent = "Content script not injected yet — reload this page once, then reopen the popup.";
    if (res && res.ok && res.state) renderState(res.state);
    setDot("error");
    return;
  }

  $("context-msg").textContent = "Capturing on: " + (tab.url || "").replace(/^https:\/\//, "").slice(0, 48);

  if (res && res.ok) renderState(res.state);

  const hist = await sendBg({ type: "AE_HISTORY_STATUS" });
  if (hist && hist.backfill && hist.backfill.running) watchBackfill();
}

function conversationKeyFromHref(href) {
  const m = /\/(?:c|agent)\/([A-Za-z0-9_-]+)/.exec(String(href || ""));
  return m ? "c:" + m[1] : null;
}

function tabRequestContext(tab) {
  return {
    tabId: tab && tab.id != null ? tab.id : null,
    sessionKey: tab ? conversationKeyFromHref(tab.url) : null
  };
}


function formatBackfill(b) {
  if (!b) return "History backfill…";
  if (b.error && !b.running) return "History backfill failed: " + b.error;
  if (b.stage === "list") return "Listing history… page " + (b.page || "?") + " (" + (b.count || 0) + ")";
  if (b.stage === "fetch") return "Fetching " + (b.index || 0) + "/" + (b.total || "?") + (b.title ? " — " + String(b.title).slice(0, 40) : "");
  if (b.stage === "write") return "Writing " + (b.index || 0) + "/" + (b.total || "?") + " (" + (b.written || 0) + " saved)";
  if (b.stage === "done" || (!b.running && (b.written != null))) {
    return "History: " + (b.written || 0) + " written, " + (b.skipped || 0) + " already archived, " + (b.failed || 0) + " failed.";
  }
  return "Archiving history… keep this tab on arena.ai.";
}

async function watchBackfill() {
  if ($("btn-history")) $("btn-history").disabled = true;
  showProgress("Archiving history… keep this tab on arena.ai.");
  for (;;) {
    const st = await sendBg({ type: "AE_HISTORY_STATUS" });
    const b = st && st.backfill;
    showProgress(formatBackfill(b));
    if (!b || !b.running) {
      if ($("btn-history")) $("btn-history").disabled = false;
      return b;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

if ($("btn-history")) $("btn-history").addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab || !ARENA_URL_RE.test(tab.url || "")) {
    showProgress("Open arena.ai first (any page, logged in).");
    return;
  }
  $("btn-history").disabled = true;
  showProgress("Listing history… keep this tab on arena.ai.");
  sendBg({ type: "AE_HISTORY_BACKFILL", tabId: tab.id });
  await watchBackfill();
});

if ($("btn-sync")) $("btn-sync").addEventListener("click", async () => {
  showProgress("Writing to archive…");
  const tab = await activeTab();
  const res = await sendBg({
    type: "AE_SYNC",
    tabId: tab && tab.id,
    sessionKey: tab && conversationKeyFromHref(tab.url)
  });
  if (res && res.ok && res.sync && res.sync.rel) showProgress("Wrote → " + res.sync.rel);
  else showProgress((res && res.sync && res.sync.error) || "Archive write failed — JSON export still works.");
  if (res && res.state) renderState(res.state);
});
async function refreshBackupStatus() {
  if (!$("backup-status")) return;
  const st = await sendBg({ type: "AE_GITHUB_STATUS" });
  $("backup-status").textContent = !st || !st.ok ? "GitHub backups: open Settings to check." :
    st.error ? "GitHub backup: " + st.error :
    !st.enabled ? "GitHub backups: " + (st.connected ? "paused" : "set up in Settings") :
    st.running ? "GitHub backup uploading…" : st.pending ? "GitHub: " + st.pending + " conversation(s) waiting for backup" :
    st.lastSuccess ? "GitHub backed up " + new Date(st.lastSuccess).toLocaleString() : "GitHub connected — ready for new archives";
}
if ($("btn-settings")) $("btn-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
if ($("btn-folder")) $("btn-folder").addEventListener("click", async () => {
  $("btn-folder").disabled = true;
  showProgress("Opening conversation folder…");
  const tab = await activeTab();
  const res = await sendBg(Object.assign({ type: "AE_OPEN_FOLDER" }, tabRequestContext(tab)));
  showProgress(res && res.ok ? "Opened conversation folder." : ((res && res.error) || "Could not open folder.") + (res && res.path ? " " + res.path : ""));
  $("btn-folder").disabled = !(tab && ARENA_URL_RE.test(tab.url || "") && conversationKeyFromHref(tab.url));
});
setInterval(refreshBackupStatus, 5000);
if ($("btn-full")) $("btn-full").addEventListener("click", () => doExport("full_history"));
$("btn-last").addEventListener("click", () => doExport("last_message"));

/* Manual vote override (ported from v1.4.0). */
async function setManualVote(choice) {
  const tab = await activeTab();
  const res = await sendBg(Object.assign({
    type: "AE_SET_MANUAL_VOTE", choice: choice, url: (tab && tab.url) || ""
  }, tabRequestContext(tab)));
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
  const res = await sendBg(Object.assign({
    type: "AE_EXPORT", mode: "full_history", snapshot: snapshot
  }, tabRequestContext(tab)));
  if (!res || !res.ok) return;
  try {
    await navigator.clipboard.writeText(res.json);
    showProgress("Copied full-history JSON to clipboard.");
  } catch (e) {
    showProgress("Clipboard write blocked — use Download instead.");
  }
});

$("btn-clear").addEventListener("click", async () => {
  const tab = await activeTab();
  const context = tabRequestContext(tab);
  await sendBg(Object.assign({ type: "AE_CLEAR" }, context));
  showProgress("Capture buffer reset.");
  const res = await sendBg(Object.assign({ type: "AE_GET_STATE" }, context));
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
  showProgress("Saved DOM debug dump with text removed and structural attributes retained.");
});

init();
setInterval(async () => {
  if ($("btn-full") && $("btn-full").disabled) return;
  if ($("progress") && $("progress").classList.contains("busy")) return;
  const tab = await activeTab();
  popupOnArena = !!(tab && ARENA_URL_RE.test(tab.url || ""));
  const res = await sendBg(Object.assign({ type: "AE_GET_STATE" }, tabRequestContext(tab)));
  if (res && res.ok && res.state) renderState(res.state);
}, 1000);
