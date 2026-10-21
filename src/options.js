/* Archive workspace controller: library, reader, insights, health, backup,
 * preferences, and diagnostics. All rendering goes through textContent. */
(function () {
  "use strict";
  const U = AEUI, $ = U.$, pageSize = 20;
  let entries = [], records = [], recordMap = new Map(), libraryStatus = null;
  let mode = "all", page = 0, backup = null, diagnostic = null, encryption = null, importing = false;
  let currentRows = [], currentKey = null, currentRecord = null, currentQuery = "";
  let filterSequence = 0, searchTimer = null, lastVerification = null;
  U.version();

  const views = ["library", "reader", "insights", "health", "backup", "preferences", "diagnostics"];

  function decodeKey(value) {
    try { return decodeURIComponent(value); } catch (_) { return ""; }
  }

  function hashRoute(raw) {
    const value = String(raw || "").replace(/^#/, "");
    if (!value) return { view: "library" };
    if (value.indexOf("read/") === 0) return { view: "reader", key: decodeKey(value.slice(5)) };
    return { view: views.indexOf(value) === -1 ? "library" : value };
  }

  function setView(view) {
    document.querySelectorAll(".view").forEach(function (element) { element.classList.toggle("hidden", element.id !== "view-" + view); });
    document.querySelectorAll("[data-view]").forEach(function (element) {
      if (element.dataset.view === view || (view === "reader" && element.dataset.view === "library")) element.setAttribute("aria-current", "page");
      else element.removeAttribute("aria-current");
    });
    document.title = "Arena Exporter · " + (view === "reader" ? "Reader" : view[0].toUpperCase() + view.slice(1));
    U.feedback("");
    if (view === "diagnostics") loadDiagnostics();
    if (view === "preferences") { loadArenaTabs(); renderLibraryStatus(); }
    if (view === "insights") loadInsights();
    if (view === "health") loadHealth();
    if (view === "library") loadLibrary();
  }

  function navigate(raw) {
    const route = hashRoute(raw);
    if (route.view === "reader" && !route.key) route.view = "library";
    setView(route.view);
    if (location.hash !== "#" + (route.view === "reader" ? "read/" + encodeURIComponent(route.key) : route.view)) {
      history.replaceState(null, "", "#" + (route.view === "reader" ? "read/" + encodeURIComponent(route.key) : route.view));
    }
    if (route.view === "reader") openReader(route.key, currentQuery, true);
  }
  document.querySelectorAll("[data-view]").forEach(function (element) { element.addEventListener("click", function () { navigate(element.dataset.view); }); });
  window.addEventListener("hashchange", function () { navigate(location.hash); });

  function openReader(key, query, fromHash) {
    currentKey = key;
    currentQuery = query || "";
    if (!fromHash) {
      setView("reader");
      history.replaceState(null, "", "#read/" + encodeURIComponent(key));
    }
    loadReader(key);
  }

  function closeReader() {
    currentKey = null;
    currentRecord = null;
    history.replaceState(null, "", "#library");
    setView("library");
  }
  U.on("reader-back", "click", closeReader);

  function openConversation(entry) {
    if (!AEView.arenaUrl(entry.url)) {
      U.feedback("This older archive has no Arena link. Use its folder button instead.", "error");
      return;
    }
    chrome.tabs.create({ url: entry.url });
  }

  function completenessClass(value) {
    return "completeness-label " + (AEView.completeness(value).tone || "idle");
  }

  function renderSummary() {
    const archived = entries.filter(function (entry) { return !entry.orphaned; });
    U.setText("total-chats", U.number(archived.length));
    U.setText("nav-count", U.number(entries.length));
    U.setText("total-turns", U.number(archived.reduce(function (total, entry) { return total + (entry.turns || 0); }, 0)));
    const count = libraryStatus && Number.isFinite(Number(libraryStatus.count)) ? Number(libraryStatus.count) : records.length;
    U.setText("total-library", U.number(count));
    renderLibraryStatus();
  }

  function renderLibraryStatus() {
    let note = "Readable without Arena";
    if (libraryStatus && libraryStatus.blocked) note = "Off while archive encryption is enabled";
    else if (libraryStatus && libraryStatus.available === false) note = "Unavailable in this browser";
    else if (libraryStatus) note = U.reader.humanBytes(libraryStatus.bytes) + " · searchable";
    U.setText("library-summary-note", note);
    const archived = entries.filter(function (entry) { return !entry.orphaned; }).length;
    const indexed = entries.filter(function (entry) { return entry.indexed && !entry.orphaned; }).length;
    let scope = archived
      ? "Full-text search covers " + U.number(indexed) + " of " + U.number(archived) + " archived conversation" + (archived === 1 ? "" : "s") + "."
      : records.length
        ? "Full-text search covers " + U.number(records.length) + " library-only conversation" + (records.length === 1 ? "" : "s") + "; the archive index is empty."
        : "Full-text search becomes available when a conversation is archived or an archive folder is indexed.";
    if (libraryStatus && libraryStatus.blocked) scope = "Local search is off while archive encryption is enabled. Sealed conversations stay sealed.";
    else if (libraryStatus && libraryStatus.available === false) scope = "This browser did not provide local library storage. Titles and models remain searchable.";
    else if (indexed < archived) scope += " Index the archive folder in Library health to make the rest readable.";
    U.setText("library-scope-note", scope);
    U.setText("library-preference-status", libraryStatus && libraryStatus.blocked
      ? "Off: encrypted archives cannot have a plaintext index beside them."
      : libraryStatus && libraryStatus.available === false
        ? "Unavailable in this browser session."
        : U.number(records.length) + " conversation(s) indexed · " + U.reader.humanBytes(libraryStatus && libraryStatus.bytes || 0) + " stored.");
  }

  async function loadLibrary() {
    try {
      const results = await Promise.all([
        U.send({ type: "AE_LIBRARY" }),
        U.send({ type: "AE_RESEARCH_LIST" }),
        U.send({ type: "AE_RESEARCH_STATUS" })
      ]);
      const library = U.require(results[0]);
      entries = (library.entries || []).slice();
      records = results[1] && results[1].ok ? results[1].records || [] : [];
      libraryStatus = results[2] && results[2].ok ? results[2].library : null;
      recordMap = new Map(records.map(function (record) { return [record.key, record]; }));
      entries.forEach(function (entry) { entry.indexed = recordMap.has(entry.key); });
      const known = new Set(entries.map(function (entry) { return entry.key; }));
      records.forEach(function (record) {
        if (known.has(record.key)) return;
        entries.push({
          key: record.key, title: record.title, url: record.url, mode: record.mode, subtype: record.subtype,
          rel: record.rel, updated_at: record.updated_at, turns: record.turns, models: record.models || [],
          completeness: record.completeness, models_pending: record.models_pending,
          indexed: true, orphaned: true
        });
      });
      renderModelOptions();
      renderSummary();
      await applyFilters();
    } catch (error) {
      U.show("library-loading", false);
      U.feedback(error.message, "error");
    }
  }

  function renderModelOptions() {
    const select = $("filter-model");
    if (!select) return;
    const previous = select.value || "all";
    const models = [];
    entries.forEach(function (entry) {
      (entry.models || []).forEach(function (model) { if (model && models.indexOf(model) === -1) models.push(model); });
    });
    models.sort(function (a, b) { return String(a).localeCompare(String(b)); });
    select.replaceChildren();
    const all = U.element("option", "", "All models");
    all.value = "all";
    select.appendChild(all);
    models.forEach(function (model) {
      const option = U.element("option", "", model);
      option.value = model;
      select.appendChild(option);
    });
    select.value = models.indexOf(previous) !== -1 ? previous : "all";
  }

  function readFilters() {
    return {
      mode: mode,
      model: $("filter-model") ? $("filter-model").value || "all" : "all",
      vote: $("filter-vote") ? $("filter-vote").value || "all" : "all",
      days: $("filter-date") ? $("filter-date").value || "all" : "all",
      detail: !!($("filter-detail") && $("filter-detail").checked),
      query: $("library-search") ? $("library-search").value.trim() : "",
      sort: $("library-sort") ? $("library-sort").value : "recent"
    };
  }

  function entryDate(entry) {
    return String(entry.updated_at || (recordMap.get(entry.key) || {}).updated_at || "");
  }

  function passesFilters(entry, filters, matches) {
    if (filters.mode !== "all" && AEView.mode(entry.mode) !== filters.mode) return false;
    const record = recordMap.get(entry.key);
    if (filters.model !== "all") {
      const models = (entry.models && entry.models.length ? entry.models : (record && record.models)) || [];
      if (models.indexOf(filters.model) === -1) return false;
    }
    if (filters.vote !== "all") {
      const outcomes = record && Array.isArray(record.vote_outcomes) ? record.vote_outcomes : [];
      if (filters.vote === "any" && !outcomes.length) return false;
      if (filters.vote === "none" && outcomes.length) return false;
      if (filters.vote !== "any" && filters.vote !== "none" && outcomes.indexOf(filters.vote) === -1) return false;
    }
    if (filters.days !== "all") {
      const updated = Date.parse(entryDate(entry));
      const days = Number(filters.days);
      if (Number.isFinite(days) && Number.isFinite(updated) && updated < Date.now() - days * 86400000) return false;
    }
    if (filters.query) {
      if (matches && matches.has(entry.key)) return true;
      const metadata = [entry.title, entry.rel, entry.key, (entry.models || []).join(" ")].join(" ").toLowerCase();
      return metadata.indexOf(filters.query.toLowerCase()) !== -1;
    }
    return true;
  }

  function sortRows(rows, filters, matches) {
    return rows.slice().sort(function (a, b) {
      if (filters.sort === "title") return String(a.title || "").localeCompare(String(b.title || ""));
      if (filters.sort === "turns") return (b.turns || 0) - (a.turns || 0);
      if (filters.sort === "relevance" && matches && matches.has(a.key) && matches.has(b.key)) {
        const diff = (matches.get(b.key).score || 0) - (matches.get(a.key).score || 0);
        if (diff) return diff;
      }
      return entryDate(b).localeCompare(entryDate(a));
    });
  }

  async function applyFilters() {
    const sequence = ++filterSequence;
    const filters = readFilters();
    let matches = null, contentTotal = null, contentUnavailable = false;
    const canSearch = filters.query.length >= 2 && records.length && !(libraryStatus && libraryStatus.blocked);
    if (canSearch) {
      const result = await U.send({
        type: "AE_RESEARCH_SEARCH",
        options: {
          query: filters.query, mode: filters.mode, model: filters.model, vote: filters.vote,
          days: filters.days, scope: filters.detail ? "all" : "text", sort: filters.sort, limit: 200
        }
      });
      if (sequence !== filterSequence) return;
      if (result && result.ok) {
        matches = new Map(result.results.map(function (item) { return [item.key, item]; }));
        contentTotal = result.total;
      } else {
        contentUnavailable = true;
      }
    }
    const rows = sortRows(entries.filter(function (entry) { return passesFilters(entry, filters, matches); }), filters, matches);
    currentRows = rows;
    renderRows(rows, filters, matches, contentTotal, contentUnavailable);
  }

  function renderRows(rows, filters, matches, contentTotal, contentUnavailable) {
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    page = Math.min(page, pages - 1);
    $("library-rows").replaceChildren();
    const archivedCount = entries.filter(function (entry) { return !entry.orphaned; }).length;
    U.setText("result-count", rows.length + " conversation" + (rows.length === 1 ? "" : "s"));
    U.show("library-loading", false);
    U.show("library-table-wrap", rows.length > 0);
    U.show("library-empty", rows.length === 0);
    const emptyBecauseOfFilters = entries.length > 0;
    U.setText("empty-title", emptyBecauseOfFilters ? "No conversations match just yet." : "A home for your next great answer.");
    U.setText("empty-description", emptyBecauseOfFilters
      ? "Try another search, or widen a filter."
      : "Open an Arena conversation and choose Save now in the extension. Completed turns can also be saved automatically.");
    U.show("empty-reset", emptyBecauseOfFilters);
    U.show("empty-open-arena", !emptyBecauseOfFilters);
    U.show("empty-index", archivedCount > 0 && records.length === 0 && !(libraryStatus && libraryStatus.blocked));

    if (filters.query && contentUnavailable) U.setText("library-scope-note", "Content search is unavailable right now; showing title and model matches only.");
    else if (filters.query && contentTotal != null) U.setText("library-scope-note", contentTotal + " matching conversation(s) in the local library" + (records.length ? " · searched " + U.number(records.length) + " indexed" : "") + ".");
    else renderLibraryStatus();

    rows.slice(page * pageSize, (page + 1) * pageSize).forEach(function (entry) {
      const match = matches && matches.get(entry.key);
      const tr = U.element("tr");
      const titleCell = U.element("td");
      const title = U.element("button", "conversation-link", entry.title || "Untitled conversation");
      title.title = entry.rel || entry.title;
      title.addEventListener("click", function () {
        if (entry.indexed) openReader(entry.key, filters.query);
        else openConversation(entry);
      });
      titleCell.appendChild(title);
      const secondary = U.element("div", "conversation-secondary");
      secondary.appendChild(U.element("span", "mode-chip " + AEView.mode(entry.mode), AEView.modeLabel(entry.mode).toUpperCase()));
      const completeness = AEView.completeness(entry.completeness || (entry.completeness_detail && entry.completeness_detail.status));
      let completenessText = completeness.label;
      if (entry.subtype && entry.subtype !== "text") completenessText = entry.subtype + " · " + completenessText;
      secondary.appendChild(U.element("span", "completeness-label " + completeness.tone, completenessText));
      secondary.appendChild(U.element("span", "library-chip " + (entry.indexed ? "ok" : "idle"), entry.indexed ? "Readable" : entry.orphaned ? "Library only" : "Not indexed"));
      if (entry.encrypted) secondary.appendChild(U.element("span", "mode-chip", "Encrypted"));
      titleCell.appendChild(secondary);
      if (match && match.snippet && match.snippet.text) {
        const snippet = U.element("div", "library-snippet", match.snippet.text);
        if (match.snippet.field === "detail") snippet.title = "Matched reasoning or tool evidence";
        titleCell.appendChild(snippet);
      }
      tr.appendChild(titleCell);

      const models = U.element("td");
      (entry.models && entry.models.length ? entry.models : [entry.models_pending ? "Awaiting reveal" : "Not revealed"]).forEach(function (name) {
        models.appendChild(U.element("span", "model-name", name));
      });
      tr.appendChild(models);
      tr.appendChild(U.element("td", "", U.number(entry.turns)));
      const date = U.element("td", "date-cell", U.date(entry.updated_at));
      date.title = entry.updated_at || "";
      tr.appendChild(date);

      const actions = U.element("td"), row = U.element("div", "row-actions");
      const read = U.element("button", "", "▤");
      read.title = entry.indexed ? "Read offline: " + entry.title : "Index the archive folder to read this conversation";
      read.setAttribute("aria-label", read.title);
      read.disabled = !entry.indexed;
      read.addEventListener("click", function () { openReader(entry.key, filters.query); });
      const folder = U.element("button", "", "▱"), arena = U.element("button", "", "↗");
      folder.title = entry.orphaned ? "No indexed archive folder for this library record" : "Open folder: " + entry.title;
      folder.setAttribute("aria-label", folder.title);
      folder.disabled = !!entry.orphaned;
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
      row.append(read, folder, arena);
      actions.appendChild(row);
      tr.appendChild(actions);
      $("library-rows").appendChild(tr);
    });
    U.setText("page-label", "Page " + (page + 1) + " / " + pages);
    $("page-prev").disabled = page === 0;
    $("page-next").disabled = page === pages - 1;
  }

  U.on("library-search", "input", function () {
    page = 0;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applyFilters, 240);
  });
  U.on("library-sort", "change", function () { page = 0; clearTimeout(searchTimer); applyFilters(); });
  ["filter-model", "filter-vote", "filter-date"].forEach(function (id) { U.on(id, "change", function () { page = 0; applyFilters(); }); });
  U.on("filter-detail", "change", function () { clearTimeout(searchTimer); applyFilters(); });
  document.querySelectorAll("[data-mode]").forEach(function (button) {
    button.addEventListener("click", function () {
      mode = button.dataset.mode;
      page = 0;
      document.querySelectorAll("[data-mode]").forEach(function (element) { element.setAttribute("aria-pressed", String(element === button)); });
      applyFilters();
    });
  });
  U.on("empty-reset", "click", function () {
    $("library-search").value = "";
    mode = "all";
    page = 0;
    ["filter-model", "filter-vote", "filter-date"].forEach(function (id) { if ($(id)) $(id).value = "all"; });
    if ($("filter-detail")) $("filter-detail").checked = false;
    document.querySelectorAll("[data-mode]").forEach(function (element) { element.setAttribute("aria-pressed", String(element.dataset.mode === "all")); });
    applyFilters();
  });
  U.on("empty-index", "click", function () { navigate("health"); });
  U.on("page-prev", "click", function () { page--; applyFilters(); });
  U.on("page-next", "click", function () { page++; applyFilters(); });
  ["btn-open-arena", "empty-open-arena"].forEach(function (id) { U.on(id, "click", function () { chrome.tabs.create({ url: "https://arena.ai/" }); }); });
  U.on("btn-refresh", "click", function () { return U.run("btn-refresh", "Reading archive…", async function () { await loadLibrary(); U.feedback("Library is up to date."); }); });

  /* ---------- reader ---------- */

  async function loadReader(key) {
    const body = $("reader-body");
    body.replaceChildren();
    $("reader-warnings").replaceChildren();
    U.show("reader-notice", false);
    const result = await U.send({ type: "AE_RESEARCH_GET", key: key });
    if (!result || !result.ok) {
      currentRecord = null;
      U.show("reader-notice", true);
      U.setText("reader-notice", result && result.error || "This conversation is not in the local library.");
      U.setText("reader-title", "Not in the local library");
      U.setText("reader-subtitle", "Index the archive folder from Library health, then open it again.");
      U.setText("reader-mode", "LIBRARY");
      $("reader-mode").className = "mode-chip";
      U.setText("reader-status", "Not indexed");
      $("reader-status").className = "completeness-label idle";
      U.setText("reader-source-note", "");
      ["reader-export-json", "reader-export-markdown", "reader-copy", "reader-open-arena"].forEach(function (id) { if ($(id)) $(id).disabled = true; });
      return;
    }
    currentRecord = result.record;
    renderReaderHeader(result.record, !!result.has_payload);
    U.reader.renderBody(result.record, body, currentQuery);
    U.reader.renderWarnings(result.record.warnings, $("reader-warnings"));
    if (!result.has_payload) {
      U.show("reader-notice", true);
      U.setText("reader-notice", "The payload is larger than the library limit or was not stored. Reading works from the bounded preview; exports must come from the archive folder.");
    } else if (result.record.preview_truncated) {
      U.show("reader-notice", true);
      U.setText("reader-notice", "This conversation is longer than the reading preview, so later text is shortened here. Export JSON or Markdown for the full conversation.");
    }
  }

  function renderReaderHeader(record, hasPayload) {
    $("reader-title").textContent = record.title || "Untitled conversation";
    $("reader-mode").textContent = AEView.modeLabel(record.mode).toUpperCase();
    $("reader-mode").className = "mode-chip " + AEView.mode(record.mode);
    const completeness = AEView.completeness(record.completeness);
    $("reader-status").textContent = completeness.label;
    $("reader-status").className = completenessClass(record.completeness);
    const models = (record.models || []).length ? record.models.join(", ") : record.mode === "agent" ? "Orchestrator unrevealed" : "Model not revealed";
    $("reader-subtitle").textContent = AEView.modeLabel(record.mode) + " · " + U.number(record.turns) + " turn" + (record.turns === 1 ? "" : "s") +
      " · " + U.date(record.updated_at) + " · " + models;
    $("reader-source-note").textContent = "Indexed " + U.date(record.indexed_at, true) +
      (record.source === "import" ? " from an archive folder" : " when the turn was saved") +
      " · " + record.counts.messages + " message(s), " + record.counts.tool_calls + " tool call(s), " + record.counts.files + " file(s).";
    $("reader-open-arena").disabled = !AEView.arenaUrl(record.url);
    ["reader-export-json", "reader-export-markdown", "reader-copy"].forEach(function (id) { if ($(id)) $(id).disabled = !hasPayload; });
  }

  U.on("reader-open-arena", "click", function () {
    if (currentRecord && AEView.arenaUrl(currentRecord.url)) chrome.tabs.create({ url: currentRecord.url });
  });
  U.on("reader-folder", "click", function () {
    if (!currentKey) return;
    return U.run("reader-folder", "Opening conversation folder…", async function () {
      U.folderResult(await U.send({ type: "AE_OPEN_ARCHIVED_FOLDER", key: currentKey }));
    });
  });
  U.on("reader-export-json", "click", function () {
    return U.run("reader-export-json", "Preparing JSON…", async function () {
      const result = U.require(await U.send({ type: "AE_RESEARCH_EXPORT", key: currentKey, format: "json", save: true }));
      U.feedback("Saved " + result.filename + ".");
    });
  });
  U.on("reader-export-markdown", "click", function () {
    return U.run("reader-export-markdown", "Preparing Markdown…", async function () {
      const result = U.require(await U.send({ type: "AE_RESEARCH_EXPORT", key: currentKey, format: "markdown", save: true }));
      U.feedback("Saved " + result.filename + ".");
    });
  });
  U.on("reader-copy", "click", function () {
    return U.run("reader-copy", "Copying Markdown…", async function () {
      const result = U.require(await U.send({ type: "AE_RESEARCH_EXPORT", key: currentKey, format: "markdown", save: false }));
      let copiedText = false;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try { await navigator.clipboard.writeText(result.text); copiedText = true; } catch (_) { copiedText = false; }
      }
      if (!copiedText && document.body && typeof document.execCommand === "function") {
        const area = U.element("textarea");
        area.value = result.text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        try { copiedText = document.execCommand("copy"); } catch (_) { copiedText = false; }
        area.remove();
      }
      if (!copiedText) throw new Error("Clipboard access is unavailable in this browser.");
      U.feedback("Markdown copied to the clipboard.");
    });
  });

  /* ---------- bulk export ---------- */

  async function sha256Hex(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    const bytes = new Uint8Array(digest);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
    return hex;
  }

  function downloadBytes(name, bytes, mime) {
    if (!navigator || typeof Blob === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      throw new Error("This browser cannot build the ZIP download.");
    }
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.rel = "noopener";
    if (document.body) document.body.appendChild(link);
    link.click();
    if (link.remove) link.remove();
    setTimeout(function () { try { URL.revokeObjectURL(url); } catch (_) { /* already revoked */ } }, 30000);
  }

  async function exportLibrary() {
    const targets = currentRows.slice();
    const filters = readFilters();
    if (!targets.length) throw new Error("There is nothing in the current list to export.");
    const omitted = [];
    const available = [];
    targets.forEach(function (entry) {
      if (entry.indexed) available.push(entry);
      else omitted.push({ key: entry.key, title: entry.title, reason: entry.orphaned ? "not_in_archive" : "not_in_local_library" });
    });
    const items = [];
    for (let start = 0; start < available.length; start += 4) {
      const chunk = available.slice(start, start + 4).map(function (entry) { return entry.key; });
      const data = U.require(await U.send({ type: "AE_RESEARCH_EXPORT_DATA", keys: chunk }));
      (data.items || []).forEach(function (item) {
        if (item.error) omitted.push({ key: item.key, title: item.title, reason: item.error });
        else items.push(item);
      });
    }
    if (!items.length) throw new Error("None of the listed conversations has a stored payload to export.");
    const files = [], manifestConversations = [];
    const used = new Set();
    let totalBytes = 0;
    for (const item of items) {
      const folder = AE.bulk.bundlePath(item, used);
      const jsonBytes = new TextEncoder().encode(item.json);
      const jsonHash = await sha256Hex(item.json);
      const conversationFiles = [{ name: "conversation.json", bytes: jsonBytes.length, sha256: jsonHash }];
      files.push({ name: folder + "/conversation.json", data: item.json });
      totalBytes += jsonBytes.length;
      if (item.markdown) {
        const markdownBytes = new TextEncoder().encode(item.markdown);
        conversationFiles.push({ name: "conversation.md", bytes: markdownBytes.length, sha256: await sha256Hex(item.markdown) });
        files.push({ name: folder + "/conversation.md", data: item.markdown });
        totalBytes += markdownBytes.length;
      }
      if (totalBytes > 128 * 1024 * 1024) throw new Error("This selection is larger than 128 MiB. Narrow the filters and export in parts.");
      manifestConversations.push({
        key: item.key, title: item.title, mode: item.mode, updated_at: item.updated_at, folder: folder, files: conversationFiles
      });
    }
    const manifest = AE.bulk.manifest({
      created_at: new Date().toISOString(),
      extension_version: chrome.runtime.getManifest().version,
      scope: filters.query || filters.mode !== "all" || filters.model !== "all" || filters.vote !== "all" || filters.days !== "all" ? "filtered library" : "library",
      conversations: manifestConversations,
      omitted: omitted
    });
    files.push({ name: "manifest.json", data: JSON.stringify(manifest, null, 2) });
    const zip = AE.zip.build(files, { date: new Date() });
    downloadBytes(AE.bulk.folderName(new Date()) + ".zip", zip, "application/zip");
    U.feedback("Exported " + items.length + " conversation" + (items.length === 1 ? "" : "s") + " in one ZIP" +
      (omitted.length ? "; " + omitted.length + " left out with a reason in manifest.json." : "."), omitted.length ? "warning" : "success");
  }

  U.on("btn-bulk-export", "click", function () {
    return U.run("btn-bulk-export", "Building the ZIP export…", exportLibrary);
  });

  /* ---------- insights ---------- */

  async function loadInsights() {
    try {
      const result = await U.send({ type: "AE_RESEARCH_INSIGHTS" });
      if (!result || !result.ok) throw new Error(result && result.error || "Insights are unavailable.");
      const data = result.insights;
      const empty = !data.totals.conversations;
      U.show("insights-empty", empty);
      U.show("insights-content", !empty);
      if (empty) return;
      U.reader.renderInsights(data, {
        activity: $("insights-activity"), modes: $("insights-modes"), votes: $("insights-votes"),
        votesNote: $("insights-votes-note"), models: $("insights-models"), completeness: $("insights-completeness"),
        toolsList: $("insights-tools-list"), generated: $("insights-generated")
      });
    } catch (error) { U.feedback(error.message, "error"); }
  }
  U.on("btn-insights-refresh", "click", function () { return U.run("btn-insights-refresh", "Recomputing insights…", loadInsights); });
  U.on("insights-open-health", "click", function () { navigate("health"); });

  /* ---------- library health ---------- */

  function renderHealthCards(report) {
    const archived = entries.filter(function (entry) { return !entry.orphaned; });
    const indexed = libraryStatus && Number.isFinite(Number(libraryStatus.count)) ? Number(libraryStatus.count) : records.length;
    U.setText("health-indexed", U.number(indexed));
    U.setText("health-archive", U.number(archived.length));
    const missing = report ? report.missing.length : archived.filter(function (entry) { return !recordMap.has(entry.key); }).length;
    U.setText("health-missing", U.number(missing));
    U.setText("health-bytes", U.reader.humanBytes(libraryStatus && libraryStatus.bytes || 0));
  }

  async function loadHealth() {
    try {
      const results = await Promise.all([
        U.send({ type: "AE_LIBRARY" }), U.send({ type: "AE_RESEARCH_LIST" }), U.send({ type: "AE_RESEARCH_STATUS" })
      ]);
      const library = results[0] && results[0].ok ? results[0].entries || [] : entries;
      entries = library.slice();
      records = results[1] && results[1].ok ? results[1].records || [] : [];
      recordMap = new Map(records.map(function (record) { return [record.key, record]; }));
      entries.forEach(function (entry) { entry.indexed = recordMap.has(entry.key); });
      libraryStatus = results[2] && results[2].ok ? results[2].library : null;
      renderHealthCards(lastVerification);
      U.show("health-notice", false);
      const blocked = !!(libraryStatus && libraryStatus.blocked);
      const unusable = blocked || !!(libraryStatus && libraryStatus.available === false);
      ["btn-health-verify", "btn-health-prune", "research-import"].forEach(function (id) { if ($(id)) $(id).disabled = unusable; });
      if (libraryStatus && libraryStatus.blocked) {
        U.show("health-notice", true);
        U.setText("health-notice", "Local library is off while archive encryption is enabled. Plaintext indexes are never kept beside sealed archives.");
      } else if (libraryStatus && libraryStatus.available === false) {
        U.show("health-notice", true);
        U.setText("health-notice", libraryStatus.error || "This browser did not provide local library storage.");
      } else if (libraryStatus) {
        U.setText("health-last-verified", lastVerification
          ? "Last checked " + U.date(lastVerification.generated_at, true) + " · " + lastVerification.matched + " matched."
          : "Not checked in this session.");
      }
      if (lastVerification) U.reader.renderHealth(lastVerification, $("health-details"));
      if (navigator && navigator.storage && navigator.storage.estimate) {
        navigator.storage.estimate().then(function (estimate) {
          if (estimate && estimate.quota) U.setText("health-quota-note", "stored locally · " + U.reader.humanBytes(estimate.quota) + " available to this browser");
        }).catch(function () { /* optional */ });
      }
    } catch (error) { U.feedback(error.message, "error"); }
  }

  U.on("btn-health-refresh", "click", function () { return U.run("btn-health-refresh", "Reading library state…", loadHealth); });
  U.on("btn-health-verify", "click", function () {
    return U.run("btn-health-verify", "Checking every stored payload…", async function () {
      const result = U.require(await U.send({ type: "AE_RESEARCH_VERIFY" }));
      lastVerification = result.report;
      renderHealthCards(lastVerification);
      U.reader.renderHealth(lastVerification, $("health-details"));
      U.setText("health-last-verified", "Last checked " + U.date(lastVerification.generated_at, true) + " · " + lastVerification.matched + " matched.");
      const problems = lastVerification.mismatched.length + lastVerification.orphaned.length + lastVerification.stale.length;
      U.feedback(problems ? "Verification found " + problems + " item(s) to review." : "Verification finished: every stored payload matches.", problems ? "warning" : "success");
    });
  });
  U.on("btn-health-prune", "click", function () {
    return U.run("btn-health-prune", "Removing orphaned entries…", async function () {
      if (!lastVerification || !lastVerification.orphaned.length) throw new Error("Run Verify first; no orphaned entries were reported.");
      const result = U.require(await U.send({ type: "AE_RESEARCH_REMOVE", keys: lastVerification.orphaned.map(function (item) { return item.key; }) }));
      lastVerification = null;
      U.setText("health-details", "Orphaned entries removed.");
      await loadHealth();
      U.feedback("Removed " + result.removed + " orphaned entr" + (result.removed === 1 ? "y" : "ies") + ".", "success");
    });
  });
  U.on("btn-health-clear", "click", function () {
    return U.run("btn-health-clear", "Clearing the local library…", async function () {
      if (typeof confirm === "function" && !confirm("Clear the local searchable library? Archived files on disk are not touched.")) { U.feedback(""); return; }
      U.require(await U.send({ type: "AE_RESEARCH_CLEAR" }));
      lastVerification = null;
      await loadHealth();
      U.feedback("Local library cleared. Archived files are unchanged.", "success");
    });
  });
  U.on("btn-open-health", "click", function () { navigate("health"); });
  U.on("research-import", "change", async function (event) {
    if (!event.target.files.length) return;
    importing = true;
    event.target.disabled = true;
    U.setText("research-import-status", "Reading conversation files…");
    try {
      const result = await U.importResearch(event.target.files, function (done, total, skipped) {
        U.setText("research-import-status", done + " of " + total + " indexed" + (skipped ? " · " + skipped + " skipped" : "") + "…");
      });
      U.setText("research-import-status", result.imported + " conversation(s) indexed" + (result.skipped.length ? " · " + result.skipped.length + " skipped (larger than 4 MiB or not a readable export)." : "."));
      U.feedback("Local library updated. " + result.imported + " conversation(s) are now readable.", result.skipped.length ? "warning" : "success");
      await loadLibrary();
      await loadHealth();
    } catch (error) {
      U.setText("research-import-status", error.message);
      U.feedback(error.message, "error");
    } finally {
      importing = false;
      event.target.disabled = false;
      event.target.value = "";
    }
  });

  /* ---------- backup ---------- */

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
    if (!enabled) U.setTone("encryption-status", "success", "New archives are stored as ordinary local files.");
    else if (unlocked) U.setTone("encryption-status", "success", "Encryption is unlocked for this browser session. New bundles are sealed with AES-GCM.");
    else U.setTone("encryption-status", "warning", "Encryption is enabled but locked. Enter the password before saving a new archive.");
    if (preferences && preferences.archiveEncryption) $("archive-encryption").checked = !!preferences.archiveEncryption.enabled;
  }

  function githubPermission() {
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

  /* ---------- preferences ---------- */

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
    const active = !!(encryption && encryption.enabled);
    U.show("encryption-settings", enabled || active);
    if (!enabled && active) {
      U.setText("btn-encryption-save", "Disable encryption");
      $("btn-encryption-save").disabled = false;
      U.setTone("encryption-status", "warning", "Enter the current archive password to disable encryption.");
    } else if (enabled) {
      U.setText("btn-encryption-save", active ? (encryption.unlocked ? "Password active" : "Unlock archive") : "Enable encryption");
      $("btn-encryption-save").disabled = !!(active && encryption.unlocked);
      U.setTone("encryption-status", "", active ? "" : "Set a password to encrypt new archives.");
    } else {
      U.setText("btn-encryption-save", "Enable encryption");
      $("btn-encryption-save").disabled = false;
      U.setTone("encryption-status", "success", "New archives are stored as ordinary local files.");
    }
  });
  U.on("btn-encryption-save", "click", function () {
    return U.run("btn-encryption-save", "Configuring archive encryption…", async function () {
      const enabled = $("archive-encryption").checked;
      const password = $("encryption-password").value;
      const confirmValue = $("encryption-confirm").value;
      const currentlyEnabled = !!(encryption && encryption.enabled);
      if (enabled && password !== confirmValue) throw new Error("The archive passwords do not match.");
      if (!enabled && currentlyEnabled && !password) throw new Error("Enter the current archive password to disable encryption.");
      const unlocking = !!(enabled && encryption && encryption.enabled && !encryption.unlocked);
      const result = U.require(await U.send({ type: unlocking ? "AE_UNLOCK_ARCHIVE_ENCRYPTION" : "AE_SET_ARCHIVE_ENCRYPTION", enabled: enabled, password: password }));
      $("encryption-password").value = "";
      $("encryption-confirm").value = "";
      renderEncryption(result.encryption, result.preferences);
      const active = !!(result.encryption && result.encryption.enabled);
      if (result.libraryCleared) U.feedback("Encrypted archives enabled. The plaintext local library was cleared.", "warning");
      else U.feedback(active ? (unlocking ? "Encrypted archives unlocked for this browser session." : "Encrypted archives enabled for this browser session.") : "Encrypted archives disabled.", "success");
      await loadLibrary();
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

  /* ---------- diagnostics ---------- */

  async function loadDiagnostics() {
    try {
      diagnostic = U.require(await U.send({ type: "AE_DIAGNOSTICS" })).diagnostics;
      $("diagnostic-output").value = JSON.stringify(diagnostic, null, 2);
    } catch (error) { U.feedback(error.message, "error"); }
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
      await Promise.all([
        loadLibrary(),
        U.send({ type: "AE_GITHUB_STATUS" }).then(function (status) { renderBackup(status); }),
        U.send({ type: "AE_PREFERENCES" }).then(function (result) {
          if (result.ok) {
            $("auto-archive").checked = result.preferences.autoArchive;
            renderEncryption(result.encryption, result.preferences);
          }
        })
      ]);
    } catch (error) {
      U.feedback(error.message, "error");
      U.show("library-loading", false);
    }
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
    let deepKey = null;
    try { deepKey = new URLSearchParams(location.search || "").get("key"); } catch (_) { deepKey = null; }
    if (deepKey) openReader(deepKey, "");
  }
  U.subscribe(refresh);
  init().catch(function (error) { U.feedback(error.message, "error"); });
})();
