/* Extension message boundary. Runtime data stays in the capture modules. */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== "string" || msg.type.indexOf("AE_") !== 0) return;

  if (AE.handleWorkspaceMessage && AE.handleWorkspaceMessage(msg, sender, sendResponse)) return true;

  if (msg.type.indexOf("AE_GITHUB_") === 0 || msg.type === "AE_OPEN_FOLDER") {
    var optionsUrl = chrome.runtime.getURL("src/options.html");
    var popupUrl = chrome.runtime.getURL("src/popup.html");
    if (!sender || sender.id !== chrome.runtime.id || ![optionsUrl, popupUrl].includes(String(sender.url || "").split(/[?#]/)[0])) {
      sendResponse({ ok: false, error: "Open this action from the extension." });
      return;
    }
    var action;
    if (msg.type === "AE_GITHUB_STATUS") action = function () { return AE.githubStatus(); };
    if (msg.type === "AE_GITHUB_FLUSH") action = function () { return AE.githubFlush(true); };
    if (msg.type === "AE_OPEN_FOLDER") action = function () { return AE.openConversationFolder(msg); };
    if (String(sender.url || "").split(/[?#]/)[0] === optionsUrl) {
      if (msg.type === "AE_GITHUB_CONFIGURE") action = function () { return AE.githubConfigure(msg.config || {}); };
      if (msg.type === "AE_GITHUB_PAUSE") action = function () { return AE.githubPause(!!msg.forget); };
      if (msg.type === "AE_GITHUB_IMPORT") action = async function () {
        var queued = await AE.githubEnqueue(msg.key, msg.rel, msg.files, msg.entry);
        return queued.queued ? { ok: true } : { ok: false, error: "Connect GitHub backups before importing an archive." };
      };
    }
    Promise.resolve().then(function () {
      if (!action) throw new Error("This action is only available in extension Settings.");
      return action();
    }).then(sendResponse, function (error) { sendResponse({ ok: false, error: error.message || "Backup action failed." }); });
    return true;
  }

  if (msg.type === "AE_EVENT") {
    if (!isArenaSender(sender)) {
      sendResponse({ ok: false, error: "ignored" });
      return;
    }
    try {
      if (stateReady) handleEvent(msg.evt, sender);
      else pendingEvents.push({ evt: msg.evt, sender: sender });
    } catch (error) {
      AE.recordIssue("capture", "event_failed");
      sendResponse({ ok: false, error: "Capture event failed. Export diagnostics from the extension workspace." });
      AE.notifyUI();
      return;
    }
    sendResponse({ ok: true, queued: !stateReady });
    if (AE.notifyUI) AE.notifyUI();
    try { if (AE.refreshStatusLed) AE.refreshStatusLed(); } catch (eLed) {}
    return;
  }
  if (msg.type === "AE_GET_STATE") {
    stateReadyPromise.then(function () {
      var selected = activateRequestSession(msg);
      if (selected.error) { sendResponse({ ok: false, error: selected.error }); return; }
      var s = selected.session;
      if (msg.snapshot) applyCaptureHealth(s, msg.snapshot);
      var finish = function () {
        var current = store.sessions[canonicalSessionKey(s.session.conversation_key)] || s;
        sendResponse({ ok: true, state: getStateSummary(current, msg.snapshot), sessions: listSessionSummaries() });
        try { if (AE.refreshStatusLed) AE.refreshStatusLed(); } catch (eLed) {}
        /* Opening the popup/options page is the natural moment to re-check
         * battles whose model reveal was missed by the retry ladder. */
        if (s.labelsPending) {
          scheduleTurnSync("state_poll_label_retry", s.session.conversation_key, null);
        }
      };
      if (typeof AE.nativeStatus === "function") AE.nativeStatus().then(finish, finish);
      else finish();
    });
    return true;
  }
  if (msg.type === "AE_SET_MANUAL_VOTE") {
    stateReadyPromise.then(function () {
      var selected = activateRequestSession(msg);
      if (selected.error) { sendResponse({ ok: false, error: selected.error }); return; }
      var s = selected.session;
      if (msg.choice === "clear") {
        for (var i = s.battleVotes.length - 1; i >= 0; i--) {
          if (s.battleVotes[i].source === "manual") { s.battleVotes.splice(i, 1); break; }
        }
        scheduleSave();
        sendResponse({ ok: true, state: getStateSummary() });
        return;
      }
      var ok = recordBattleVote(s, {
        choice: msg.choice, source: "manual", url: msg.url || "",
        capturedAt: new Date().toISOString()
      });
      scheduleSave();
      sendResponse({ ok: ok, state: getStateSummary() });
    });
    return true;
  }
  if (msg.type === "AE_SAVE_TEXT") {
    downloadTextFile(msg.filename, msg.text || "", msg.mime, msg.saveAs !== false).then(sendResponse);
    return true;
  }
  if (msg.type === "AE_EXPORT") {
    stateReadyPromise.then(function () {
      var selected = activateRequestSession(msg);
      if (selected.error) { sendResponse({ ok: false, error: selected.error }); return; }
      var mode = msg.mode === "last_message" ? "last_message" : "full_history";
      var out = buildExport(mode, msg.snapshot, selected.session);
      var payload = out.payload;
      var after = (AE.finalizeArchivePayload)
        ? AE.finalizeArchivePayload(payload, { tabId: msg.tabId })
        : Promise.resolve(payload);
      after.then(function () {
        if (AE.applyCompletenessMeta) AE.applyCompletenessMeta(payload);
        payload = AE.scrubSecrets(payload);
        var json = JSON.stringify(payload, null, 2);
        if (msg.format === "markdown") {
          var markdown = AE.renderMarkdown(payload), filename = out.filename.replace(/\.json$/, ".md");
          if (!msg.save) { sendResponse({ ok: true, text: markdown, filename: filename }); return; }
          downloadTextFile(filename, markdown, "text/markdown;charset=utf-8", true).then(function (result) {
            sendResponse(Object.assign({}, result, { filename: filename }));
          });
          return;
        }
        if (!msg.save) {
          sendResponse({ ok: true, json: json, filename: out.filename, payload: null });
          return;
        }
        var stamp = (function () {
          var d = new Date();
          var p = function (n) { return String(n).padStart(2, "0"); };
          return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
        })();
        var dir = "arena-exporter-attachments/" + stamp + "/";
        var downloads = [];
        if (AE.decorateInlineArtifacts) {
          var inline = AE.decorateInlineArtifacts(payload, dir);
          (inline.saved || []).forEach(function (s) {
            if (s && s.dataUrl && s.path) downloads.push({ dataUrl: s.dataUrl, path: s.path });
          });
        }
        downloadTextFile(out.filename, json, "application/json;charset=utf-8", true).then(function (dl) {
          if (!dl.ok) { sendResponse({ ok: false, error: dl.error || "Download failed" }); return; }
          var chain = Promise.resolve();
          var savedCount = 0;
          var attachmentError = null;
          downloads.forEach(function (d) {
            chain = chain.then(function () {
              return downloadDataUrlFile(d.path, d.dataUrl).then(function (result) {
                if (result.ok) savedCount++;
                else attachmentError = result.error || "Attachment download failed";
              });
            });
          });
          chain.then(function () {
            sendResponse({
              ok: !attachmentError,
              json: json,
              filename: out.filename,
              error: attachmentError,
              savedCount: savedCount
            });
          });
        });
      }, function (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      });
    });
    return true;
  }

  if (msg.type === "AE_HISTORY_PROGRESS") {
    if (!globalThis.__aeBackfill) globalThis.__aeBackfill = {};
    var p = globalThis.__aeBackfill;
    if (msg.stage) p.stage = msg.stage;
    if (msg.page != null) p.page = msg.page;
    if (msg.count != null) p.count = msg.count;
    if (msg.index != null) p.index = msg.index;
    if (msg.total != null) p.total = msg.total;
    if (msg.title != null) p.title = msg.title;
    if (msg.id != null) p.id = msg.id;
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "AE_HISTORY_STATUS") {
    sendResponse({ ok: true, backfill: globalThis.__aeBackfill || { running: false } });
    return;
  }
  if (msg.type === "AE_HISTORY_BACKFILL") {
    if (globalThis.__aeBackfill && globalThis.__aeBackfill.running) {
      sendResponse({ ok: false, error: "backfill already running", backfill: globalThis.__aeBackfill });
      return;
    }
    var tabId = msg.tabId;
    globalThis.__aeBackfill = { running: true, stage: "start", written: 0, skipped: 0, failed: 0, listed: 0, error: null, failedItems: [] };
    var tabMsg = function (payload) {
      return new Promise(function (resolve) {
        try {
          chrome.tabs.sendMessage(tabId, payload, function (got) {
            var err = chrome.runtime.lastError;
            if (err) resolve({ ok: false, error: err.message || "no response — reload the arena.ai tab" });
            else resolve(got || { ok: false, error: "no response — open an arena.ai tab and reload it" });
          });
        } catch (e) {
          resolve({ ok: false, error: String(e) });
        }
      });
    };
    var finish = function (res) {
      globalThis.__aeBackfill.running = false;
      if (res && res.ok === false) globalThis.__aeBackfill.error = res.error || globalThis.__aeBackfill.error;
      try { sendResponse(res); } catch (e) { /* popup may have closed */ }
    };
    AE.archiveIndexLoad().then(function (index) {
      var skip = {};
      Object.keys(index || {}).forEach(function (k) { skip[k] = true; });
      globalThis.__aeBackfill.stage = "list";
      return tabMsg({ type: "AE_HISTORY_LIST" }).then(function (got) {
        if (!got || !got.ok) {
          return { ok: false, error: (got && got.error) || "history list failed" };
        }
        var list = got.list || [];
        var wanted = [];
        var skipped = 0;
        list.forEach(function (item) {
          if (item && item.id) wanted.push(item);
        });
        globalThis.__aeBackfill.listed = list.length;
        globalThis.__aeBackfill.skipped = skipped;
        globalThis.__aeBackfill.total = wanted.length;
        var failed = [];
        var written = 0;
        var chain = Promise.resolve();
        wanted.forEach(function (item, i) {
          chain = chain.then(function () {
            globalThis.__aeBackfill.stage = "fetch";
            globalThis.__aeBackfill.index = i + 1;
            globalThis.__aeBackfill.total = wanted.length;
            globalThis.__aeBackfill.title = item.title || "";
            globalThis.__aeBackfill.id = item.id;
            return tabMsg({ type: "AE_HISTORY_FETCH", item: item }).then(function (gotRec) {
              if (!gotRec || !gotRec.ok || !gotRec.record) {
                failed.push({ id: item.id, error: (gotRec && gotRec.error) || "fetch failed" });
                globalThis.__aeBackfill.failed = failed.length;
                globalThis.__aeBackfill.failedItems = failed.slice(-20);
                return;
              }
              var payload = AE.historyRecordToPayload(gotRec.record);
              if (!payload || !payload.session || !payload.session.conversation_key) {
                failed.push({ id: item.id, error: "could not convert" });
                globalThis.__aeBackfill.failed = failed.length;
                return;
              }
              if (!((payload.messages || []).length || (payload.battles || []).length)) {
                failed.push({ id: item.id, error: "empty conversation" });
                globalThis.__aeBackfill.failed = failed.length;
                return;
              }
              var key = payload.session.conversation_key;
              var prior = index[key] || index["c:" + item.id] || null;
              var alreadyGreen = !!(prior && (prior.completeness === "green" || prior.completeness === "full"));
              if (AE.applyHonestSubtype) AE.applyHonestSubtype(payload);
              var urls = AE.collectArtifactUrls ? AE.collectArtifactUrls(payload) : [];
              if (alreadyGreen && !urls.length) {
                skipped += 1;
                globalThis.__aeBackfill.skipped = skipped;
                return;
              }
              if (AE.shouldSkipEmptyArchive && AE.shouldSkipEmptyArchive(payload) && !urls.length) {
                skipped += 1;
                globalThis.__aeBackfill.skipped = skipped;
                return;
              }
              var existingRel = (prior && prior.rel) || null;
              globalThis.__aeBackfill.stage = "fetch";
              return AE.finalizeArchivePayload(payload, { tabId: tabId, existingRel: existingRel }).then(function () {
              var score = payload.meta && payload.meta.completeness_detail;
              if (score && score.emptyShell && !score.prompt && !(score.files && score.files.expected)) {
                skipped += 1;
                globalThis.__aeBackfill.skipped = skipped;
                return;
              }
              globalThis.__aeBackfill.stage = "write";
              var files = AE.filesToWrite ? AE.filesToWrite(payload) : [];
              return writeArchiveBest(payload, files).then(function (res) {
                if (res && res.ok) {
                  written += 1;
                  globalThis.__aeBackfill.written = written;
                  globalThis.__aeBackfill.lastRel = res.rel;
                } else {
                  failed.push({ id: payload.session.conversation_key, error: (res && res.error) || "write failed" });
                  globalThis.__aeBackfill.failed = failed.length;
                  globalThis.__aeBackfill.failedItems = failed.slice(-20);
                }
              });
              });
            }).then(function () {
              return new Promise(function (r) { setTimeout(r, 180); });
            });
          });
        });
        return chain.then(function () {
          globalThis.__aeBackfill.failed = failed.length;
          globalThis.__aeBackfill.written = written;
          globalThis.__aeBackfill.stage = "done";
          globalThis.__aeBackfill.failedItems = failed.slice(-20);
          return {
            ok: true,
            written: written,
            skipped: skipped,
            listed: list.length,
            failed: failed,
            backfill: globalThis.__aeBackfill
          };
        });
      });
    }).then(finish, function (err) {
      globalThis.__aeBackfill.running = false;
      globalThis.__aeBackfill.error = String(err);
      finish({ ok: false, error: String(err), backfill: globalThis.__aeBackfill });
    });
    return true;
  }

  if (msg.type === "AE_SYNC") {
    stateReadyPromise.then(function () {
      var tabId = msg.tabId != null ? msg.tabId : null;
      var key = msg.sessionKey || null;
      if (!key && tabId != null) {
        key = store.tabKeys[tabId] || "tab:" + tabId;
      }
      key = canonicalSessionKey(key || store.activeKey);
      runTurnSync("manual", key, tabId).then(function (result) {
        var selected = store.sessions[canonicalSessionKey(key)];
        sendResponse({ ok: !!(result && result.ok), sync: result, state: getStateSummary(selected) });
      });
    });
    return true;
  }
  /* Round-trips one file through the real sink so the options page can prove
   * the archive path works before a capture depends on it. */
  if (msg.type === "AE_TEST_ARCHIVE") {
    var stamp = new Date().toISOString();
    var body = "arena-exporter archive self-test\n" + stamp + "\n";
    var viaDownloads = function () {
      return AE.writeArchiveFile(AE.ARCHIVE_DIR + "/_selftest.txt", body);
    };
    var done = function (res) { sendResponse(res); };
    if (typeof AE.writeNativeSelftest === "function") {
      AE.writeNativeSelftest(body).then(function (res) {
        if (res && res.ok) { done(res); return; }
        if (res && res.fallback) return viaDownloads().then(done);
        done(res);
      });
    } else {
      viaDownloads().then(done);
    }
    return true;
  }
  if (msg.type === "AE_NATIVE_STATUS") {
    if (typeof AE.nativeStatus === "function") {
      AE.nativeStatus().then(function (st) { sendResponse(st); });
    } else {
      sendResponse({ state: "missing", connected: false, error: "host-missing", fallback: true });
    }
    return true;
  }
  if (msg.type === "AE_ARCHIVE_INDEX") {
    AE.archiveIndexLoad().then(function (index) { sendResponse({ ok: true, index: index }); }, function (err) { sendResponse({ ok: false, error: String(err.message || err) }); });
    return true;
  }
  if (msg.type === "AE_SET_SILENT") {
    AE.setSilentWrites(msg.enabled !== false).then(function (v) {
      chrome.storage.local.set({ ae_silent_writes: msg.enabled !== false }, function () {
        void chrome.runtime.lastError;
        sendResponse({ ok: true, suppressed: v });
      });
    });
    return true;
  }
  if (msg.type === "AE_CLEAR") {
    stateReadyPromise.then(function () {
      var selected = activateRequestSession(msg);
      if (selected.error) { sendResponse({ ok: false, error: selected.error }); return; }
      clearActiveSession();
      sendResponse({ ok: true });
    });
    return true;
  }
});

/* Download-bubble suppression does not persist across worker restarts and is
 * opt-in: it hides the shelf for the whole browser, not just this extension. */
try {
  chrome.storage.local.get(["ae_silent_writes"], function (r) {
    void chrome.runtime.lastError;
    if (r && r.ae_silent_writes === true) AE.setSilentWrites(true);
  });
} catch (e) { /* downloads.ui unavailable */ }

startStoreLoad();
