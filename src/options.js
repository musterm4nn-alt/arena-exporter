/* Archive workspace controller: library, backup, preferences, and diagnostics. */
(function () {
  "use strict";
  const U = AEUI, $ = U.$, pageSize = 20;
  let entries = [], mode = "all", page = 0, backup = null, diagnostic = null, encryption = null, importing = false;
  U.version();

  function navigate(view) {
    if (!["library", "backup", "preferences", "diagnostics"].includes(view)) view = "library";
    document.querySelectorAll(".view").forEach(function (element) { element.classList.toggle("hidden", element.id !== "view-" + view); });
    document.querySelectorAll("[data-view]").forEach(function (element) {
      if (element.dataset.view === view) element.setAttribute("aria-current", "page"); else element.removeAttribute("aria-current");
    });
    document.title = "Arena Exporter · " + view[0].toUpperCase() + view.slice(1);
    if (location.hash !== "#" + view) history.replaceState(null, "", "#" + view);
    U.feedback("");
    if (view === "diagnostics") loadDiagnostics();
    if (view === "preferences") loadArenaTabs();
  }
  document.querySelectorAll("[data-view]").forEach(function (element) { element.addEventListener("click", function () { navigate(element.dataset.view); }); });
  window.addEventListener("hashchange", function () { navigate(location.hash.slice(1)); });

  function openConversation(entry) {
    if (!AEView.arenaUrl(entry.url)) {
      U.feedback("This older archive has no Arena link. Use its folder button instead.", "error");
      return;
    }
    chrome.tabs.create({ url: entry.url });
  }

  function renderLibrary() {
    const filtered = AEView.filterEntries(entries, $("library-search").value, mode, $("library-sort").value);
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    page = Math.min(page, pages - 1);
    $("library-rows").replaceChildren();
    U.setText("total-chats", U.number(entries.length));
    U.setText("nav-count", U.number(entries.length));
    U.setText("total-turns", U.number(entries.reduce(function (total, entry) { return total + (entry.turns || 0); }, 0)));
    U.setText("result-count", filtered.length + " conversation" + (filtered.length === 1 ? "" : "s"));
    U.show("library-loading", false);
    U.show("library-table-wrap", filtered.length > 0);
    U.show("library-empty", filtered.length === 0);
    U.setText("empty-title", entries.length ? "No conversations match just yet." : "A home for your next great answer.");
    U.setText("empty-description", entries.length ? "Try another search or clear your filters." : "Open an Arena conversation and choose Save now in the extension. Completed turns can also be saved automatically.");
    U.show("empty-reset", entries.length > 0);
    U.show("empty-open-arena", entries.length === 0);

    filtered.slice(page * pageSize, (page + 1) * pageSize).forEach(function (entry) {
      const tr = U.element("tr");
      const titleCell = U.element("td");
      const title = U.element("button", "conversation-link", entry.title || "Untitled conversation");
      title.title = entry.rel || entry.title;
      title.addEventListener("click", function () { openConversation(entry); });
      titleCell.appendChild(title);
      const secondary = U.element("div", "conversation-secondary");
      secondary.appendChild(U.element("span", "mode-chip " + AEView.mode(entry.mode), AEView.modeLabel(entry.mode).toUpperCase()));
      const completeness = AEView.completeness(entry.completeness || (entry.completeness_detail && entry.completeness_detail.status));
      let completenessText = completeness.label;
      if (entry.subtype && entry.subtype !== "text") completenessText = entry.subtype + " · " + completenessText;
      secondary.appendChild(U.element("span", "completeness-label " + completeness.tone, completenessText));
      if (entry.encrypted) secondary.appendChild(U.element("span", "mode-chip", "Encrypted"));
      titleCell.appendChild(secondary);
      tr.appendChild(titleCell);

      const models = U.element("td");
      (entry.models && entry.models.length ? entry.models : [entry.models_pending ? "Awaiting reveal" : "Not revealed"]).forEach(function (name) { models.appendChild(U.element("span", "model-name", name)); });
      tr.appendChild(models);
      tr.appendChild(U.element("td", "", U.number(entry.turns)));
      const date = U.element("td", "date-cell", U.date(entry.updated_at));
      date.title = entry.updated_at || "";
      tr.appendChild(date);

      const actions = U.element("td"), row = U.element("div", "row-actions");
      const folder = U.element("button", "", "▱"), arena = U.element("button", "", "↗");
      folder.title = "Open folder: " + entry.title;
      folder.setAttribute("aria-label", folder.title);
      folder.addEventListener("click", async function () {
        folder.disabled = true;
        U.feedback("Opening conversation folder…");
        try { U.folderResult(await U.send({ type: "AE_OPEN_ARCHIVED_FOLDER", key: entry.key })); }
        catch (error) { U.feedback(error.message, "error"); }
        finally { folder.disabled = false; }
      });
      arena.title = "Open on Arena: " + entry.title;
      arena.setAttribute("aria-label", arena.title);
      arena.disabled = !AEView.arenaUrl(entry.url);
      arena.addEventListener("click", function () { openConversation(entry); });
      row.append(folder, arena);
      actions.appendChild(row);
      tr.appendChild(actions);
      $("library-rows").appendChild(tr);
    });
    U.setText("page-label", "Page " + (page + 1) + " / " + pages);
    $("page-prev").disabled = page === 0;
    $("page-next").disabled = page === pages - 1;
  }

  async function loadLibrary() {
    const result = U.require(await U.send({ type: "AE_LIBRARY" }));
    entries = result.entries || [];
    renderLibrary();
  }
  U.on("library-search", "input", function () { page = 0; renderLibrary(); });
  U.on("library-sort", "change", function () { page = 0; renderLibrary(); });
  document.querySelectorAll("[data-mode]").forEach(function (button) {
    button.addEventListener("click", function () {
      mode = button.dataset.mode;
      page = 0;
      document.querySelectorAll("[data-mode]").forEach(function (element) { element.setAttribute("aria-pressed", String(element === button)); });
      renderLibrary();
    });
  });
  U.on("empty-reset", "click", function () {
    $("library-search").value = "";
    mode = "all";
    page = 0;
    document.querySelectorAll("[data-mode]").forEach(function (element) { element.setAttribute("aria-pressed", String(element.dataset.mode === "all")); });
    renderLibrary();
  });
  U.on("page-prev", "click", function () { page--; renderLibrary(); });
  U.on("page-next", "click", function () { page++; renderLibrary(); });
  ["btn-open-arena", "empty-open-arena"].forEach(function (id) { U.on(id, "click", function () { chrome.tabs.create({ url: "https://arena.ai/" }); }); });
  U.on("btn-refresh", "click", function () { return U.run("btn-refresh", "Reading archive…", async function () { await loadLibrary(); U.feedback("Library is up to date."); }); });

  function renderBackup(status, populate) {
    backup = status;
    if (!status || !status.ok) {
      U.setText("github-status", status && status.error || "Unable to read backup status.");
      U.setText("backup-summary", "Offline");
      return;
    }
    if (populate) {
      $("github-repo").value = status.repo || "";
      $("github-branch").value = status.branch || "";
      $("github-folder").value = status.folder || "arena-archive";
    }
    U.setText("github-state-label", AEView.backupLabel(status));
    $("github-dot").className = "dot " + (status.error ? "warn" : status.enabled && status.lastSuccess ? "ok" : "idle");
    U.setText("github-status", (status.error || (status.running ? "Uploading queued conversations. Keep this browser open." : status.enabled ? "New archive writes are queued automatically." : status.connected ? "New saves stay local until you resume backup." : "Connect a private repository to begin.")) + (status.nextRetry ? " Retry: " + U.date(status.nextRetry, true) + "." : "") + (status.otherPending ? " " + status.otherPending + " items belong to a previous destination." : ""));
    U.setText("github-destination", status.repo || "Not connected");
    U.setText("github-pending", U.number(status.pending || 0) + " conversations");
    U.setText("github-last", U.date(status.lastSuccess, true));
    $("github-now").disabled = !status.enabled || status.running;
    $("github-pause").disabled = !status.connected || status.running;
    U.setText("github-pause", status.enabled ? "Pause" : "Resume");
    $("github-disconnect").disabled = !status.connected || status.running;
    $("github-import").disabled = !status.enabled || importing;
    U.setText("backup-summary", status.error ? "Check" : status.running ? "Syncing" : !status.connected ? "Off" : !status.enabled ? "Paused" : status.pending ? status.pending + " queued" : status.lastSuccess ? "Saved" : "Ready");
    U.setText("backup-summary-note", status.lastSuccess && !status.pending && !status.error ? "Last upload " + U.date(status.lastSuccess) : status.enabled ? "Your private repository" : "Connect in GitHub backup");
  }

  function renderEncryption(status, preferences) {
    encryption = status || null;
    const enabled = !!(encryption && encryption.enabled);
    const unlocked = !!(encryption && encryption.unlocked);
    $("archive-encryption").checked = enabled;
    U.show("encryption-settings", enabled);
    U.setText("btn-encryption-save", enabled ? (unlocked ? "Password active" : "Unlock archive") : "Enable encryption");
    $("btn-encryption-save").disabled = enabled && unlocked;
    U.show("btn-encryption-lock", enabled && unlocked);
    if (!enabled) {
      U.setText("encryption-status", "New archives are stored as ordinary local files.");
    } else if (unlocked) {
      U.setText("encryption-status", "Encryption is unlocked for this browser session. New bundles are sealed with AES-GCM.", "success");
    } else {
      U.setText("encryption-status", "Encryption is enabled but locked. Enter the password before saving a new archive.", "warning");
    }
    if (preferences && preferences.archiveEncryption) {
      $("archive-encryption").checked = !!preferences.archiveEncryption.enabled;
    }
  }

  function githubPermission() {
    // Chrome also exposes `browser`; only Firefox exposes getBrowserInfo.
    if (typeof browser !== "undefined" && browser.runtime && typeof browser.runtime.getBrowserInfo === "function") {
      return browser.permissions.request({ origins: ["https://api.github.com/*"], data_collection: ["personalCommunications", "websiteContent", "authenticationInfo"] });
    }
    return new Promise(function (resolve) {
      chrome.permissions.request({ origins: ["https://api.github.com/*"] }, function (granted) { void chrome.runtime.lastError; resolve(granted); });
    });
  }
  U.reconcile = function () { if (backup) renderBackup(backup); };
  U.on("github-form", "submit", function (event) {
    event.preventDefault();
    return U.run("github-connect", "Connecting to your private repository…", async function () {
      if (!await githubPermission()) throw new Error("Allow GitHub access to enable backup.");
      const status = U.require(await U.send({ type: "AE_GITHUB_CONFIGURE", config: { repo: $("github-repo").value, branch: $("github-branch").value, folder: $("github-folder").value, token: $("github-token").value } }));
      $("github-token").value = "";
      renderBackup(status, true);
      U.feedback("Connected. New archive writes will be backed up automatically.");
    });
  });
  U.on("github-now", "click", function () {
    return U.run("github-now", "Uploading queued conversations…", async function () {
      let status;
      do {
        status = U.require(await U.send({ type: "AE_GITHUB_FLUSH" }));
        renderBackup(status);
        $("github-now").disabled = true;
      } while (status.enabled && status.pending && !status.error);
      if (status.error) throw new Error(status.error);
      U.feedback(status.pending ? "Backup paused. Remaining conversations stay queued." : "Backup queue is up to date.");
    });
  });
  U.on("github-pause", "click", function () {
    return U.run("github-pause", backup && backup.enabled ? "Pausing backup…" : "Resuming backup…", async function () {
      const current = backup || {};
      const status = U.require(await U.send(current.enabled ? { type: "AE_GITHUB_PAUSE" } : { type: "AE_GITHUB_CONFIGURE", config: { repo: current.repo, branch: current.branch, folder: current.folder, token: "" } }));
      renderBackup(status);
      U.feedback(status.enabled ? "Automatic backup resumed." : "Backup paused. Local archiving continues.");
    });
  });
  U.on("github-disconnect", "click", function () {
    return U.run("github-disconnect", "Removing the saved connection…", async function () {
      renderBackup(U.require(await U.send({ type: "AE_GITHUB_PAUSE", forget: true })));
      $("github-token").value = "";
      U.feedback("Disconnected. Existing local files and GitHub commits are preserved.");
    });
  });
  U.on("github-import", "change", async function (event) {
    if (!event.target.files.length) return;
    importing = true;
    event.target.disabled = true;
    try { await U.importArchive(event.target.files); }
    catch (error) { U.setText("github-import-status", error.message + " Previously queued conversations remain queued."); }
    finally { importing = false; event.target.value = ""; renderBackup(await U.send({ type: "AE_GITHUB_STATUS" })); }
  });

  U.on("auto-archive", "change", async function () {
    const wanted = $("auto-archive").checked;
    $("auto-archive").disabled = true;
    try {
      U.require(await U.send({ type: "AE_SET_PREFERENCES", preferences: { autoArchive: wanted } }));
      U.feedback(wanted ? "Completed turns will archive automatically." : "Automatic archiving paused. Manual saves still work.");
    } catch (error) {
      $("auto-archive").checked = !wanted;
      U.feedback(error.message, "error");
    } finally { $("auto-archive").disabled = false; }
  });
  U.on("archive-encryption", "change", function () {
    const enabled = $("archive-encryption").checked;
    U.show("encryption-settings", enabled);
    if (!enabled) {
      $("btn-encryption-save").disabled = false;
      U.setText("encryption-status", "Saving is still encrypted until you confirm the change below.");
    }
  });
  U.on("btn-encryption-save", "click", function () {
    return U.run("btn-encryption-save", "Configuring archive encryption…", async function () {
      const enabled = $("archive-encryption").checked;
      const password = $("encryption-password").value;
      const confirm = $("encryption-confirm").value;
      if ((enabled || (encryption && encryption.enabled)) && password !== confirm) throw new Error("The archive passwords do not match.");
      if (!enabled && encryption && encryption.enabled && !password) throw new Error("Enter the current archive password to disable encryption.");
      const unlocking = !!(enabled && encryption && encryption.enabled && !encryption.unlocked);
      const result = U.require(await U.send({ type: unlocking ? "AE_UNLOCK_ARCHIVE_ENCRYPTION" : "AE_SET_ARCHIVE_ENCRYPTION", enabled: enabled, password: password }));
      $("encryption-password").value = "";
      $("encryption-confirm").value = "";
      renderEncryption(result.encryption, result.preferences);
      const active = !!(result.encryption && result.encryption.enabled);
      U.feedback(active ? (unlocking ? "Encrypted archives unlocked for this browser session." : "Encrypted archives enabled for this browser session.") : "Encrypted archives disabled.", "success");
    });
  });
  U.on("btn-encryption-lock", "click", function () {
    return U.run("btn-encryption-lock", "Locking encrypted archives…", async function () {
      const result = U.require(await U.send({ type: "AE_LOCK_ARCHIVE_ENCRYPTION" }));
      renderEncryption(result.encryption, result.preferences);
      U.feedback("Archive encryption is locked. New saves will pause until it is unlocked.", "warning");
    });
  });

  const silentSupported = !!(chrome.downloads && chrome.downloads.setUiOptions);
  $("chk-silent").disabled = !silentSupported;
  if (!silentSupported) U.setText("silent-note", "Unavailable in this browser.");
  U.on("chk-silent", "change", async function () {
    const wanted = $("chk-silent").checked;
    const permission = wanted ? new Promise(function (resolve) { chrome.permissions.request({ permissions: ["downloads.ui"] }, function (granted) { void chrome.runtime.lastError; resolve(granted); }); }) : Promise.resolve(true);
    $("chk-silent").disabled = true;
    try {
      if (!await permission) throw new Error("Download UI permission was not granted.");
      const result = U.require(await U.send({ type: "AE_SET_SILENT", enabled: wanted }));
      if (wanted && !result.suppressed) throw new Error("This browser could not suppress the download bubble.");
      U.feedback(wanted ? "Quiet downloads enabled." : "Normal download UI restored.");
    } catch (error) {
      $("chk-silent").checked = !wanted;
      U.feedback(error.message, "error");
    } finally { $("chk-silent").disabled = false; }
  });
  U.on("btn-selftest", "click", function () {
    return U.run("btn-selftest", "Writing a small archive test file…", async function () {
      const result = U.require(await U.send({ type: "AE_TEST_ARCHIVE" }));
      U.setText("selftest-result", "Write verified: " + (result.resolved || result.path));
      U.feedback("Archive write completed and verified.");
    });
  });
  async function loadArenaTabs() {
    try {
      const tabs = (await chrome.tabs.query({})).filter(function (tab) { return AEView.arenaUrl(tab.url); });
      const previous = $("history-tab").value;
      $("history-tab").replaceChildren();
      if (!tabs.length) { const empty = U.element("option", "", "Open an Arena tab first"); empty.value = ""; $("history-tab").appendChild(empty); }
      tabs.forEach(function (tab) { const option = U.element("option", "", tab.title || tab.url); option.value = String(tab.id); $("history-tab").appendChild(option); });
      if (tabs.some(function (tab) { return String(tab.id) === previous; })) $("history-tab").value = previous;
      $("btn-history").disabled = !tabs.length;
    } catch (error) { U.feedback(error.message, "error"); }
  }
  U.on("btn-history", "click", function () {
    return U.run("btn-history", "Reading Arena history…", async function () {
      const id = Number($("history-tab").value);
      if (!id) throw new Error("Choose a signed-in Arena tab first.");
      U.setText("history-status", "Archiving your history. Keep this page and the Arena tab open.");
      const result = U.require(await U.send({ type: "AE_HISTORY_BACKFILL", tabId: id }));
      const failed = Array.isArray(result.failed) ? result.failed.length : Number(result.failed || 0);
      U.setText("history-status", "History import finished. " + (result.written || 0) + " saved, " + (result.skipped || 0) + " skipped, " + failed + " failed.");
      U.feedback(failed ? "History import finished with " + failed + " failed conversations. Retry to recover them." : "History import finished.", failed ? "warning" : null);
      await loadLibrary();
    });
  });
  async function loadDiagnostics() {
    try { diagnostic = U.require(await U.send({ type: "AE_DIAGNOSTICS" })).diagnostics; $("diagnostic-output").value = JSON.stringify(diagnostic, null, 2); }
    catch (error) { U.feedback(error.message, "error"); }
  }
  U.on("btn-diagnostics-refresh", "click", loadDiagnostics);
  U.on("btn-diagnostics", "click", function () {
    return U.run("btn-diagnostics", "Preparing diagnostics…", async function () {
      await loadDiagnostics();
      if (!diagnostic) throw new Error("No diagnostic report is available.");
      U.require(await U.send({ type: "AE_SAVE_TEXT", filename: "arena-exporter-diagnostics.json", text: JSON.stringify(diagnostic, null, 2), mime: "application/json" }));
      U.feedback("Diagnostics saved without conversation content.");
    });
  });
  async function refresh() {
    try {
      await Promise.all([loadLibrary(), U.send({ type: "AE_GITHUB_STATUS" }).then(function (status) { renderBackup(status); }), U.send({ type: "AE_PREFERENCES" }).then(function (result) { if (result.ok) { $("auto-archive").checked = result.preferences.autoArchive; renderEncryption(result.encryption, result.preferences); } })]);
    } catch (error) { U.feedback(error.message, "error"); U.show("library-loading", false); }
  }
  async function init() {
    navigate(location.hash.slice(1));
    await refresh();
    renderBackup(await U.send({ type: "AE_GITHUB_STATUS" }), true);
    const native = await U.send({ type: "AE_NATIVE_STATUS" });
    U.setText("native-status", native.state === "ok" ? "Arena Archive app connected. Its selected folder is used for saves." : native.state === "no-root" ? "Choose a folder in the Arena Archive app. Downloads is used until then." : "Using your browser's download folder. Install the optional Arena Archive app to choose another destination.");
    if (native.state === "ok") U.setText("archive-path", "Arena Archive / selected folder");
    chrome.storage.local.get(["ae_silent_writes"], function (result) { void chrome.runtime.lastError; $("chk-silent").checked = silentSupported && !!(result && result.ae_silent_writes); });
    await loadArenaTabs();
  }
  U.subscribe(refresh);
  init().catch(function (error) { U.feedback(error.message, "error"); });
})();
