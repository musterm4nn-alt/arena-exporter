/* Archive sink built on chrome.downloads.
 *
 * chrome.downloads can only write beneath the browser's download directory and
 * refuses to follow a directory symlinked out of it (see README). So the real
 * tree lives at <downloads>/arena-archive/ and the user symlinks it wherever
 * they want to see it. Nested real subdirectories work fine.
 *
 * Chosen over the File System Access API because an FSA readwrite grant drops
 * back to "prompt" on every browser restart and a service worker cannot
 * re-request one -- which would mean a click per session, with a silent queue
 * as the failure mode. This never decays, and it works on Firefox too. */
var AE = AE || {};

(function () {
  "use strict";

  AE.ARCHIVE_DIR = "arena-archive";
  var INDEX_KEY = "ae_archive_index";
  /* chrome.downloads takes a data: URL; there is no URL.createObjectURL in a
   * service worker. Very large files are reported rather than silently lost. */
  var MAX_FILE_BYTES = 1.5 * 1024 * 1024;
  var uiSuppressed = false;

  function mimeFor(path) {
    if (/\.json$/i.test(path)) return "application/json";
    if (/\.md$/i.test(path)) return "text/markdown";
    if (/\.html?$/i.test(path)) return "text/plain"; // never hand Chrome text/html to save
    return "text/plain";
  }

  /* FNV-1a. Only used to skip rewriting files that did not change. */
  function hash(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  AE.archiveHash = hash;

  /* Suppress the download bubble. Global to the browser while enabled, so it is
   * opt-out via settings rather than forced. */
  AE.setSilentWrites = function (enabled) {
    return new Promise(function (resolve) {
      if (!chrome.downloads || !chrome.downloads.setUiOptions) { resolve(false); return; }
      try {
        chrome.downloads.setUiOptions({ enabled: !enabled }, function () {
          void chrome.runtime.lastError;
          uiSuppressed = !!enabled;
          resolve(uiSuppressed);
        });
      } catch (e) { resolve(false); }
    });
  };

  function eraseWhenSettled(id) {
    return new Promise(function (resolve) {
      chrome.downloads.erase({ id: id }, function () { void chrome.runtime.lastError; resolve(); });
    });
  }

  /* Resolve once the item reaches a terminal state. Erasing an in_progress
   * record can strand the write, so this never erases early. */
  function awaitTerminal(id, tries) {
    return new Promise(function (resolve) {
      chrome.downloads.search({ id: id }, function (items) {
        void chrome.runtime.lastError;
        var it = items && items[0];
        if (!it) { resolve({ ok: false, error: "download record vanished" }); return; }
        if (it.state === "in_progress" && (tries || 0) < 150) {
          setTimeout(function () { resolve(awaitTerminal(id, (tries || 0) + 1)); }, 100);
          return;
        }
        resolve({
          ok: it.state === "complete",
          state: it.state,
          resolved: it.filename || null,
          error: it.error || (it.state === "in_progress" ? "timed out" : null)
        });
      });
    });
  }

  AE.writeArchiveFile = function (relPath, content) {
    var text = String(content == null ? "" : content);
    if (text.length > MAX_FILE_BYTES) {
      return Promise.resolve({ ok: false, path: relPath, error: "too large for a data: URL (" + text.length + " bytes)" });
    }
    var url = "data:" + mimeFor(relPath) + ";charset=utf-8," + encodeURIComponent(text);
    return new Promise(function (resolve) {
      chrome.downloads.download({
        url: url, filename: relPath, conflictAction: "overwrite", saveAs: false
      }, function (id) {
        var err = chrome.runtime.lastError;
        if (err || id == null) {
          resolve({ ok: false, path: relPath, error: (err && err.message) || "download refused" });
          return;
        }
        awaitTerminal(id, 0).then(function (res) {
          return eraseWhenSettled(id).then(function () {
            /* Chrome reports "complete" even when it has silently rewritten the
             * target, so verify the path it actually used ends where we asked. */
            var wantTail = relPath.split("/").join("/");
            var landed = res.resolved && res.resolved.replace(/\\/g, "/").indexOf(wantTail) !== -1;
            resolve({
              ok: res.ok && landed,
              path: relPath,
              resolved: res.resolved,
              error: res.ok && !landed ? "chrome rewrote the target path" : res.error
            });
          });
        });
      });
    });
  };

  /* ---------- persistent conversation -> folder index ----------
   * Replaces the native host's _index.json. chrome.storage.local is
   * authoritative and survives browser restarts; the on-disk copy is a mirror
   * for the reader app. */

  AE.archiveIndexLoad = function () {
    return new Promise(function (resolve) {
      chrome.storage.local.get([INDEX_KEY], function (r) {
        void chrome.runtime.lastError;
        resolve((r && r[INDEX_KEY]) || {});
      });
    });
  };

  AE.archiveIndexSave = function (index) {
    return new Promise(function (resolve) {
      chrome.storage.local.set({ [INDEX_KEY]: index }, function () {
        void chrome.runtime.lastError;
        resolve(index);
      });
    });
  };

  /* ---------- write a whole conversation ---------- */

  function latestModels(payload) {
    var battles = (payload && payload.battles) || [];
    if (!battles.length) return [];
    var latest = battles[battles.length - 1];
    return (latest.contestants || []).map(function (c) { return c && c.model; }).filter(Boolean);
  }

  /* Serial, not parallel: every write is a download plus a history erase, and
   * firing a dozen at once makes Chrome queue them unpredictably. */
  function writeSequential(jobs) {
    var written = [], failed = [];
    var chain = Promise.resolve();
    jobs.forEach(function (job) {
      chain = chain.then(function () {
        return AE.writeArchiveFile(job.full, job.content).then(function (res) {
          if (res.ok) written.push(job);
          else failed.push({ path: job.path, error: res.error, resolved: res.resolved || null });
        });
      });
    });
    return chain.then(function () { return { written: written, failed: failed }; });
  }

  /**
   * Write a conversation into <downloads>/arena-archive/<rel>/.
   * Folder and subtype are fixed on first write and never change afterwards.
   * Files whose content is byte-identical to the last successful write are
   * skipped, so a later turn does not rewrite every earlier turn's response.
   */
  AE.writeArchive = function (payload, files) {
    return AE.archiveIndexLoad().then(function (index) {
      var session = (payload && payload.session) || {};
      var key = session.conversation_key || session.session_id;
      if (!key) return { ok: false, error: "no conversation key" };

      var existing = index[key] || null;
      var rel = existing && existing.rel ? existing.rel : AE.archiveRelFor(payload, null);
      var subtype = existing && existing.subtype
        ? existing.subtype
        : (AE.firstBattleSubtype ? AE.firstBattleSubtype(payload) : null);

      var hashes = (existing && existing.hashes) || {};
      var nextHashes = {};
      var jobs = [];
      var skipped = 0;

      (files || []).forEach(function (f) {
        if (!f || typeof f.content !== "string" || !f.path) return;
        var h = hash(f.content);
        nextHashes[f.path] = h;
        if (hashes[f.path] === h) { skipped++; return; }
        jobs.push({ path: f.path, full: AE.ARCHIVE_DIR + "/" + rel + "/" + f.path, content: f.content });
      });

      return writeSequential(jobs).then(function (res) {
        /* Only remember hashes for files that actually landed; a failed write
         * must be retried next turn, not skipped as unchanged. */
        var keep = {};
        Object.keys(nextHashes).forEach(function (path) {
          var landed = res.written.some(function (w) { return w.path === path; });
          if (landed || hashes[path] === nextHashes[path]) keep[path] = nextHashes[path];
        });

        var models = latestModels(payload);
        index[key] = {
          rel: rel,
          mode: (payload.battles || []).length ? "battle" : "agent",
          subtype: subtype,
          title: session.title || ((payload.battles || [])[0] || {}).prompt || "",
          url: (payload.export && payload.export.source && payload.export.source.url) || null,
          models: models,
          models_pending: !models.length,
          updated_at: new Date().toISOString(),
          turns: (payload.battles || []).length,
          hashes: keep
        };

        return AE.archiveIndexSave(index)
          .then(function () { return mirrorIndex(index, hashes); })
          .then(function () {
            return {
              ok: res.failed.length === 0,
              rel: rel,
              written: res.written.map(function (w) { return w.path; }),
              skipped: skipped,
              failed: res.failed
            };
          });
      });
    });
  };

  /* On-disk copy for the reader app. chrome.storage.local stays authoritative;
   * this is written last so a crash leaves the mirror stale, never the source. */
  var lastMirrorHash = null;
  function mirrorIndex(index, _prev) {
    var view = {};
    Object.keys(index).forEach(function (k) {
      var e = index[k];
      view[k] = {
        rel: e.rel, mode: e.mode, subtype: e.subtype, title: e.title,
        url: e.url, models: e.models, models_pending: e.models_pending,
        updated_at: e.updated_at, turns: e.turns
      };
    });
    var text = JSON.stringify({ version: 1, chats: view }, null, 2);
    var h = hash(text);
    if (h === lastMirrorHash) return Promise.resolve();
    return AE.writeArchiveFile(AE.ARCHIVE_DIR + "/" + AE.ARCHIVE_INDEX, text).then(function (r) {
      if (r.ok) lastMirrorHash = h;
    });
  }
})();
