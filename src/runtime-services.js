/* Preferences, pure parse cache and extension-only workspace actions. */
var AE = AE || {};
(function () {
  "use strict";
  var cache = new WeakMap(), notificationTimer = null, issues = [];
  var defaults = { autoArchive: true, archiveEncryption: null };

  function storageSetLocal(value) {
    return new Promise(function (resolve, reject) {
      try {
        var request = chrome.storage.local.set(value, function () {
          var error = chrome.runtime && chrome.runtime.lastError;
          if (error) reject(new Error(error.message || "settings write failed")); else resolve();
        });
        if (request && typeof request.then === "function") request.then(resolve, reject);
      } catch (error) { reject(error); }
    });
  }
  AE.preferences = Object.assign({}, defaults);
  AE.preferencesReady = new Promise(function (resolve, reject) {
    try {
      var request = chrome.storage.local.get(["ae_preferences"], function (stored) {
        var error = chrome.runtime && chrome.runtime.lastError;
        if (error) reject(new Error(error.message || "settings read failed")); else resolve(stored || {});
      });
      if (request && typeof request.then === "function") request.then(resolve, reject);
    } catch (error) { reject(error); }
  }).then(function (stored) {
    var prefs = stored && stored.ae_preferences;
    AE.preferences.autoArchive = !(prefs && prefs.autoArchive === false);
    AE.preferences.archiveEncryption = prefs && prefs.archiveEncryption || null;
    if (AE.archiveEncryption && AE.archiveEncryption.restore) AE.archiveEncryption.restore(AE.preferences.archiveEncryption);
    autoArchiveEnabled = AE.preferences.autoArchive;
  }).catch(function () { if (AE.recordIssue) AE.recordIssue("settings", "read_failed"); });

  AE.parseCachedEvaluation = function (session, key, text, init) {
    var entries = cache.get(session);
    if (!entries) { entries = new Map(); cache.set(session, entries); }
    // Requests can arrive after their streams. The init is part of the key.
    var signature = JSON.stringify(init || null), old = entries.get(key);
    if (!old || old.text !== text || old.signature !== signature) {
      old = { text: text, signature: signature,
        value: AE.parseEvaluationStream ? AE.parseEvaluationStream(text, init) : AE.parseBattleStream(text) };
      entries.set(key, old);
      while (entries.size > 40) entries.delete(entries.keys().next().value);
    }
    return old.value;
  };
  AE.notifyUI = function () {
    if (notificationTimer || !chrome.runtime.sendMessage) return;
    notificationTimer = setTimeout(function () {
      notificationTimer = null;
      try {
        chrome.runtime.sendMessage({ type: "AE_UI_CHANGED" }, function () { void chrome.runtime.lastError; });
      } catch (_) { /* No extension document is open. */ }
    }, 250);
  };
  AE.recordIssue = function (area, code) {
    // Controlled diagnostic identifiers only: no chat text, URLs or tokens.
    issues.push({ at: new Date().toISOString(), area: String(area).slice(0, 40), code: String(code).slice(0, 60) });
    if (issues.length > 50) issues.shift();
  };
  AE.archiveLimits = Object.assign({
    downloadsDataUrlBytes: 1.8 * 1024 * 1024,
    attachmentFetchBytes: 15 * 1024 * 1024,
    nativeFileBytes: 32 * 1024 * 1024,
    note: "Downloads fallback uses a bounded data URL; large attachments may require the native archive app."
  }, AE.ARCHIVE_LIMITS || {});
  AE.diagnostics = function () {
    var sessions = Object.values(store.sessions);
    return {
      version: extensionVersion(),
      schema: AE.SCHEMA_VERSION,
      created_at: new Date().toISOString(),
      runtime: {
        storage_area: (function () {
          try { return chrome.storage && chrome.storage.session ? "session" : "local"; } catch (_) { return "local"; }
        })(),
        max_sessions: 12,
        evaluation_stream_budget_bytes: 4 * 1024 * 1024
      },
      capture: {
        sessions: sessions.length,
        events: sessions.reduce(function (n, s) { return n + (s.stats.events || 0); }, 0),
        streaming: sessions.filter(function (s) { return s.stats && (s.stats.lastStreamAt || 0) && Date.now() - s.stats.lastStreamAt < STREAMING_WINDOW_MS; }).length,
        storage_errors: sessions.filter(function (s) { return s.storageError; }).length
      },
      auto_archive: AE.preferences.autoArchive,
      archive_encryption: AE.archiveEncryption ? AE.archiveEncryption.status() : null,
      archive_limits: AE.archiveLimits,
      issues: issues.slice(),
      privacy: "Contains counts, limits, and diagnostic codes only. Conversation text, titles, URLs, and credentials are excluded."
    };
  };
  AE.publicPreferences = function () {
    return {
      autoArchive: AE.preferences.autoArchive,
      archiveEncryption: AE.archiveEncryption ? {
        enabled: AE.archiveEncryption.status().enabled,
        unlocked: AE.archiveEncryption.status().unlocked,
        format: AE.archiveEncryption.status().format,
        version: AE.archiveEncryption.status().version
      } : null
    };
  };
  AE.libraryEntries = async function () {
    var index = await AE.archiveIndexLoad();
    return Object.keys(index).map(function (key) {
      var entry = index[key];
      return { key: key, title: entry.title || "Untitled conversation", url: entry.url || null,
        mode: entry.mode || "agent", subtype: entry.subtype || "text", rel: entry.rel,
        updated_at: entry.updated_at, turns: entry.turns || 0, models: Array.isArray(entry.models) ? entry.models : [],
        completeness: entry.completeness || null,
        completeness_detail: entry.completeness_detail || null,
        models_pending: !!entry.models_pending,
        files_expected: entry.files_expected, files_with_bytes: entry.files_with_bytes,
        encrypted: !!entry.encrypted, encryption_format: entry.encryption_format || null,
        destinations: Object.keys(entry.destinations || {}) };
    }).sort(function (a, b) { return String(b.updated_at || "").localeCompare(String(a.updated_at || "")); });
  };
  AE.openArchivedFolder = async function (key) {
    var index = await AE.archiveIndexLoad(), entry = index[key];
    if (!entry || !AE.nativeSafeRel(entry.rel)) throw new Error("This conversation has no saved archive folder.");
    var destinations = Object.keys(entry.destinations || {}).sort(function (a, b) {
      return String(entry.destinations[b].updated_at).localeCompare(String(entry.destinations[a].updated_at));
    });
    if (destinations[0] && destinations[0].indexOf("native:") === 0) {
      return { ok: false, error: "Open this conversation in the Arena Archive desktop app.", path: destinations[0].slice(7) + "/" + entry.rel };
    }
    return AE.writeArchiveFile(AE.ARCHIVE_DIR + "/" + entry.rel + "/_open-folder.txt",
      "Arena conversation archive. This file lets the extension open this folder.\n", { reveal: true });
  };
  AE.handleWorkspaceMessage = function (msg, sender, respond) {
    if (!["AE_PREFERENCES", "AE_SET_PREFERENCES", "AE_SET_ARCHIVE_ENCRYPTION", "AE_UNLOCK_ARCHIVE_ENCRYPTION", "AE_LOCK_ARCHIVE_ENCRYPTION", "AE_LIBRARY", "AE_OPEN_ARCHIVED_FOLDER", "AE_DIAGNOSTICS"].includes(msg.type)) return false;
    var page = String(sender && sender.url || "").split(/[?#]/)[0];
    if (!sender || sender.id !== chrome.runtime.id ||
        ![chrome.runtime.getURL("src/options.html"), chrome.runtime.getURL("src/popup.html")].includes(page)) {
      respond({ ok: false, error: "Open this action from Arena Exporter." }); return true;
    }
    Promise.all([stateReadyPromise, AE.preferencesReady]).then(async function () {
      if (msg.type === "AE_SET_PREFERENCES") {
        if (!msg.preferences || typeof msg.preferences.autoArchive !== "boolean") throw new Error("Choose an automatic archive setting.");
        var next = Object.assign({}, AE.preferences, { autoArchive: msg.preferences.autoArchive });
        await storageSetLocal({ ae_preferences: next });
        AE.preferences = next;
        autoArchiveEnabled = next.autoArchive;
        if (!autoArchiveEnabled) Object.keys(turnSyncTimers).forEach(function (key) { clearTimeout(turnSyncTimers[key]); delete turnSyncTimers[key]; });
        AE.notifyUI();
        return { ok: true, preferences: AE.publicPreferences() };
      }
      if (msg.type === "AE_SET_ARCHIVE_ENCRYPTION") {
        if (!AE.archiveEncryption) throw new Error("Encrypted archives are unavailable in this runtime.");
        var record = await AE.archiveEncryption.configure(msg.password || "", msg.enabled !== false);
        var encryptedPreferences = Object.assign({}, AE.preferences, { archiveEncryption: record });
        await storageSetLocal({ ae_preferences: encryptedPreferences });
        AE.preferences = encryptedPreferences;
        AE.notifyUI();
        return { ok: true, encryption: AE.archiveEncryption.status(), preferences: AE.publicPreferences() };
      }
      if (msg.type === "AE_UNLOCK_ARCHIVE_ENCRYPTION") {
        if (!AE.archiveEncryption) throw new Error("Encrypted archives are unavailable in this runtime.");
        await AE.archiveEncryption.unlock(msg.password || "");
        AE.notifyUI();
        return { ok: true, encryption: AE.archiveEncryption.status(), preferences: AE.publicPreferences() };
      }
      if (msg.type === "AE_LOCK_ARCHIVE_ENCRYPTION") {
        if (!AE.archiveEncryption) throw new Error("Encrypted archives are unavailable in this runtime.");
        AE.archiveEncryption.lock();
        AE.notifyUI();
        return { ok: true, encryption: AE.archiveEncryption.status(), preferences: AE.publicPreferences() };
      }
      if (msg.type === "AE_PREFERENCES") return { ok: true, preferences: AE.publicPreferences(), encryption: AE.archiveEncryption ? AE.archiveEncryption.status() : null };
      if (msg.type === "AE_LIBRARY") return { ok: true, entries: await AE.libraryEntries() };
      if (msg.type === "AE_OPEN_ARCHIVED_FOLDER") return AE.openArchivedFolder(msg.key);
      return { ok: true, diagnostics: AE.diagnostics() };
    }).then(respond, function (error) { respond({ ok: false, error: String(error.message || error) }); });
    return true;
  };
})();
