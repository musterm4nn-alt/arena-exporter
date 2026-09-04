/* Options page: archive location self-test, silent-write toggle, and a view of
 * what has been archived so far. */
"use strict";

const $ = (id) => document.getElementById(id);

function renderGithub(st, populate) {
  if (!st || !st.ok) { $("github-status").textContent = st && st.error || "Could not read backup status."; return; }
  if (populate) {
    $("github-repo").value = st.repo || "";
    $("github-branch").value = st.branch || "";
    $("github-folder").value = st.folder || "arena-archive";
  }
  $("github-now").disabled = !st.enabled || st.running;
  $("github-pause").disabled = !st.enabled;
  $("github-disconnect").disabled = !st.connected;
  $("github-import").disabled = !st.enabled;
  const state = st.running ? "Uploading…" : st.enabled ? "Automatic backups enabled." : st.connected ? "Backups paused." : "Not connected.";
  $("github-status").textContent = state + " " + st.pending + " conversation(s) queued." +
    (st.lastSuccess ? " Last successful backup: " + new Date(st.lastSuccess).toLocaleString() + "." : "") +
    (st.error ? " " + st.error : "") +
    (st.nextRetry ? " Next retry: " + new Date(st.nextRetry).toLocaleTimeString() + "." : "") +
    (st.otherPending ? " " + st.otherPending + " queued conversation(s) belong to a previous destination; reconnect that destination to upload them." : "");
}

$("github-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  // Request optional host access directly inside the user's gesture.
  const permission = typeof browser !== "undefined" ? browser.permissions.request({
    origins: ["https://api.github.com/*"], data_collection: ["personalCommunications", "websiteContent", "authenticationInfo"]
  }) : new Promise((resolve) => {
    chrome.permissions.request({ origins: ["https://api.github.com/*"] }, (granted) => {
      void chrome.runtime.lastError;
      resolve(granted);
    });
  });
  $("github-connect").disabled = true;
  $("github-status").textContent = "Connecting…";
  try {
    if (!await permission) throw new Error("Allow access to api.github.com to enable backups.");
    const res = await send({ type: "AE_GITHUB_CONFIGURE", config: {
      repo: $("github-repo").value, branch: $("github-branch").value,
      folder: $("github-folder").value, token: $("github-token").value
    } });
    if (res && res.ok) $("github-token").value = "";
    renderGithub(res, !!(res && res.ok));
  } catch (error) { $("github-status").textContent = error.message; }
  finally { $("github-connect").disabled = false; }
});
$("github-now").addEventListener("click", async () => {
  $("github-now").disabled = true;
  $("github-status").textContent = "Uploading queued conversations…";
  let st;
  do {
    st = await send({ type: "AE_GITHUB_FLUSH" });
    renderGithub(st);
  } while (st && st.ok && st.enabled && st.pending && !st.error);
});
$("github-pause").addEventListener("click", async () => renderGithub(await send({ type: "AE_GITHUB_PAUSE" })));
$("github-disconnect").addEventListener("click", async () => {
  $("github-token").value = "";
  renderGithub(await send({ type: "AE_GITHUB_PAUSE", forget: true }));
});

async function importArchive(selected) {
  const files = Array.from(selected);
  const roots = files.filter(file => /^[^/]+\/(?:agent\/[^/]+|(?:battle|direct|side-by-side)\/[^/]+\/[^/]+)\/conversation\.json$/.test(file.webkitRelativePath));
  if (!roots.length) throw new Error("Select the whole arena-archive folder containing conversation.json files.");
  const indexFile = files.find(file => /^[^/]+\/_index\.json$/.test(file.webkitRelativePath));
  let index = {};
  if (indexFile) { try { index = JSON.parse(await indexFile.text()).chats || {}; } catch (_) { /* reconstruct entries below */ } }
  let count = 0;
  for (const root of roots) {
    const prefix = root.webkitRelativePath.replace(/conversation\.json$/, "");
    const rel = prefix.split("/").slice(1).join("/").replace(/\/$/, "");
    const payload = JSON.parse(await root.text());
    const session = payload.session || {};
    const key = session.conversation_key || session.session_id;
    if (!key) throw new Error("A selected conversation has no conversation identifier: " + rel);
    const group = files.filter(file => file.webkitRelativePath.startsWith(prefix));
    if (group.reduce((size, file) => size + file.size, 0) > 32 * 1024 * 1024) {
      throw new Error("This conversation exceeds the 32 MiB folder-import limit: " + rel);
    }
    const content = [];
    for (const file of group) {
      if (file.size > 32 * 1024 * 1024) throw new Error("A file exceeds the 32 MiB backup limit: " + file.name);
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      content.push({ path: file.webkitRelativePath.slice(prefix.length), encoding: "base64", content: btoa(binary) });
    }
    const entry = Object.assign({}, index[key] || {}, { rel,
      title: (index[key] && index[key].title) || session.title || "",
      updated_at: (index[key] && index[key].updated_at) || new Date(root.lastModified).toISOString() });
    const res = await send({ type: "AE_GITHUB_IMPORT", key, rel, files: content, entry });
    if (!res || !res.ok) throw new Error(res && res.error || "Could not queue imported files.");
    $("github-import-status").textContent = ++count + " of " + roots.length + " conversation(s) queued.";
  }
  $("github-import-status").textContent = count + " conversation(s) queued. Backups will upload automatically; use Back up now to start immediately.";
}
$("github-import").addEventListener("change", async (event) => {
  $("github-import").disabled = true;
  try { await importArchive(event.target.files); }
  catch (error) { $("github-import-status").textContent = error.message + " Any conversations already queued will still be backed up."; }
  finally { event.target.value = ""; renderGithub(await send({ type: "AE_GITHUB_STATUS" })); }
});
send({ type: "AE_GITHUB_STATUS" }).then(st => renderGithub(st, true));
setInterval(async () => {
  if (!$("github-connect").disabled) renderGithub(await send({ type: "AE_GITHUB_STATUS" }));
}, 5000);

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
