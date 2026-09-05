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
 * as the failure mode. This never decays. */
var AE = AE || {};

(function () {
  "use strict";

  AE.ARCHIVE_DIR = "arena-archive";
  var INDEX_KEY = "ae_archive_index";
  /* chrome.downloads takes a data: URL; there is no URL.createObjectURL in a
   * service worker. Cap the *encoded* URL, not the raw string: encodeURIComponent
   * can triple the size, and Chrome refuses data: URLs around 2MB. */
  var MAX_DATA_URL_BYTES = 1.8 * 1024 * 1024;
  var uiSuppressed = false;

  function mimeFor(path) {
    if (/\.json$/i.test(path)) return "application/json";
    if (/\.md$/i.test(path)) return "text/markdown";
    if (/\.html?$/i.test(path)) return "text/plain"; // never hand Chrome text/html to save
    return "text/plain";
  }

  function dataUrlFor(path, text) {
    return "data:" + mimeFor(path) + ";charset=utf-8," + encodeURIComponent(text);
  }

  /* SHA-256 hex. Used to skip rewriting files that did not change. */
  function sha256Hex(str) {
    var bytes = new TextEncoder().encode(String(str == null ? "" : str));
    return crypto.subtle.digest("SHA-256", bytes).then(function (buf) {
      var a = new Uint8Array(buf);
      var out = "";
      for (var i = 0; i < a.length; i++) {
        var h = a[i].toString(16);
        out += h.length === 1 ? "0" + h : h;
      }
      return out;
    });
  }

  AE.archiveHash = sha256Hex;

  /* Drop capture-debug fields from conversation.json so a large battle still
   * archives. Lane responses and attribution samples stay. */
  AE.slimArchiveJson = function (text) {
    try {
      var o = JSON.parse(text);
      if (!o || typeof o !== "object" || !o.meta) return text;
      delete o.meta.captured_requests;
      delete o.meta.stream_samples;
      delete o.meta.evaluation_streams;
      delete o.meta.endpoint_catalog;
      return JSON.stringify(o, null, 2);
    } catch (e) {
      return text;
    }
  };

  function fitDataUrl(path, text) {
    var url = dataUrlFor(path, text);
    if (url.length <= MAX_DATA_URL_BYTES) return { text: text, url: url };
    if (/conversation\.json$/i.test(path)) {
      var slim = AE.slimArchiveJson(text);
      if (slim !== text) {
        text = slim;
        url = dataUrlFor(path, text);
        if (url.length <= MAX_DATA_URL_BYTES) return { text: text, url: url, slimmed: true };
      }
    }
    return { text: text, url: url, tooLarge: true };
  }

  /* Suppress the download bubble. Global to the browser while enabled, so it is
   * opt-in via settings rather than forced. */
  AE.setSilentWrites = function (enabled) {
    return new Promise(function (resolve) {
      /* downloads.ui / setUiOptions is Chrome-only. Firefox has no equivalent;
       * missing API or a failed call must not look like success. */
      var downloadsUi = chrome.downloads && chrome.downloads["setUiOptions"];
      if (typeof downloadsUi !== "function") {
        resolve(false);
        return;
      }
      try {
        downloadsUi({ enabled: !enabled }, function () {
          var err = chrome.runtime.lastError;
          if (err) { uiSuppressed = false; resolve(false); return; }
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

  /* Top-level listener so a multi-file write keeps the service worker alive
   * instead of dying between polls. */
  if (typeof chrome !== "undefined" && chrome.downloads && chrome.downloads.onChanged) {
    chrome.downloads.onChanged.addListener(function () { /* keepalive */ });
  }

  AE.writeArchiveFile = function (relPath, content, options) {
    var safe = AE.safeArchivePath ? AE.safeArchivePath(relPath) : relPath;
    if (!safe) {
      return Promise.resolve({ ok: false, path: relPath, error: "illegal path" });
    }
    var text = String(content == null ? "" : content);
    var fitted;
    if (/^data:[^,]*,/.test(text)) {
      if (text.length > MAX_DATA_URL_BYTES) {
        return Promise.resolve({
          ok: false,
          path: safe,
          error: "too large for a data: URL (" + text.length + " bytes encoded)"
        });
      }
      fitted = { text: text, url: text };
    } else {
      fitted = fitDataUrl(safe, text);
    }
    if (fitted.tooLarge) {
      return Promise.resolve({
        ok: false,
        path: safe,
        error: "too large for a data: URL (" + fitted.url.length + " bytes encoded)"
      });
    }
    return new Promise(function (resolve) {
      chrome.downloads.download({
        url: fitted.url, filename: safe, conflictAction: "overwrite", saveAs: false
      }, function (id) {
        var err = chrome.runtime.lastError;
        if (err || id == null) {
          resolve({ ok: false, path: safe, error: (err && err.message) || "download refused" });
          return;
        }
        awaitTerminal(id, 0).then(async function (res) {
          var landedPath = (res.resolved || "").replace(/\\/g, "/");
          var correctPath = landedPath === safe || landedPath.endsWith("/" + safe);
          if (options && options.reveal && res.ok && correctPath) {
            try {
              // Firefox's browser namespace reports show() failures as a Promise.
              var downloadsApi = typeof browser !== "undefined" ? browser.downloads : chrome.downloads;
              var shown = await downloadsApi.show(id);
              if (shown === false) throw new Error("Folder could not be opened.");
            } catch (error) { res.ok = false; res.error = "Folder could not be opened: " + error.message; }
          }
          return eraseWhenSettled(id).then(function () {
            /* Chrome reports "complete" even when it has silently rewritten the
             * target, so verify the path it actually used ends where we asked. */
            var landed = correctPath;
            resolve({
              ok: res.ok && landed,
              path: safe,
              resolved: res.resolved,
              slimmed: !!fitted.slimmed,
              error: res.ok && !landed ? "chrome rewrote the target path" : res.error
            });
          });
        });
      });
    });
  };

  /* ---------- persistent conversation -> folder index ----------
   * chrome.storage.local is authoritative and survives browser restarts; the
   * on-disk copy is a mirror for the reader app. */

  AE.archiveIndexLoad = function () {
    return new Promise(function (resolve, reject) {
      chrome.storage.local.get([INDEX_KEY], function (r) {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message || "archive index read failed")); return; }
        resolve((r && r[INDEX_KEY]) || {});
      });
    });
  };

  AE.archiveIndexSave = function (index) {
    return new Promise(function (resolve, reject) {
      chrome.storage.local.set({ [INDEX_KEY]: index }, function () {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message || "archive index save failed")); return; }
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

  function archiveRelOwner(index, key, rel) {
    var keys = Object.keys(index || {});
    for (var i = 0; i < keys.length; i++) {
      var otherKey = keys[i];
      if (otherKey !== key && index[otherKey] && index[otherKey].rel === rel) return otherKey;
    }
    return null;
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
  // Storage returns copies, so serialize the complete read/write transaction
  // across conversations and destinations. A failed job must not jam the queue.
  var archiveWriteQueue = Promise.resolve();
  AE.writeArchive = function (payload, files, opts) {
    var task = archiveWriteQueue.then(function () { return writeArchive(payload, files, opts); });
    archiveWriteQueue = task.catch(function () {});
    return task.catch(function (err) {
      return { ok: false, error: String(err && err.message || err), failed: [{ path: INDEX_KEY, error: String(err && err.message || err) }] };
    });
  };

  function writeArchive(payload, files, opts) {
    opts = opts || {};
    var prefix = opts.prefix != null ? opts.prefix : AE.ARCHIVE_DIR;
    var destination = opts.destinationKey || "downloads:" + prefix;
    var writeJobs = opts.writeJobs || writeSequential;
    var writeFile = opts.writeFile || AE.writeArchiveFile;
    return AE.archiveIndexLoad().then(function (index) {
      var session = (payload && payload.session) || {};
      var key = session.conversation_key || session.session_id;
      if (!key) return { ok: false, error: "no conversation key" };

      var existing = index[key] || null;
      var existingRel = existing && existing.rel ? existing.rel : null;
      var collisionOwner = existingRel ? archiveRelOwner(index, key, existingRel) : null;
      /* v1.15.0 and earlier used only the first eight UUID characters. If an
       * old index has two keys pinned to that same folder, move each one to its
       * new full-id path on its next sync instead of preserving the collision. */
      var repairedCollision = !!collisionOwner;
      var rel = existingRel && !repairedCollision
        ? existingRel
        : AE.archiveRelFor(payload, null);
      var relSafe = AE.safeArchivePath ? AE.safeArchivePath(rel) : rel;
      if (!relSafe) return { ok: false, error: "illegal archive path" };
      rel = relSafe;
      var subtype = existing && existing.subtype
        ? existing.subtype
        : (AE.firstBattleSubtype ? AE.firstBattleSubtype(payload) : null);

      /* Hashes are relative to the conversation folder. A relocated chat must
       * rewrite every file into its new folder even when its bytes are unchanged. */
      var destinations = Object.assign({}, (existing && existing.destinations) || {});
      var destinationState = destinations[destination];
      // Legacy unscoped hashes are deliberately ignored once, to populate the
      // current destination after upgrading or changing the native app's root.
      var hashes = repairedCollision || (destinationState && destinationState.rel !== rel) ? {} : ((destinationState && destinationState.hashes) || {});
      var nextHashes = {};
      var jobs = [];
      var skipped = 0;
      var rejected = [];

      if (repairedCollision && AE.decorateArchivePaths && AE.filesToWrite) {
        AE.decorateArchivePaths(payload, rel);
        files = AE.filesToWrite(payload);
      }

      var chain = Promise.resolve();
      (files || []).forEach(function (f) {
        if (!f || typeof f.content !== "string" || !f.path) return;
        var filePath = AE.safeArchivePath ? AE.safeArchivePath(f.path) : f.path;
        if (!filePath) {
          rejected.push({ path: f.path, error: "illegal path" });
          return;
        }
        chain = chain.then(function () {
          return sha256Hex((f.encoding || "utf8") + "\n" + f.content).then(function (h) {
            nextHashes[filePath] = h;
            if (hashes[filePath] === h) { skipped++; return; }
            jobs.push({
              path: filePath,
              full: prefix ? prefix + "/" + rel + "/" + filePath : rel + "/" + filePath,
              content: f.content,
              encoding: f.encoding || null
            });
          });
        });
      });

      return chain.then(function () {
        return writeJobs(jobs).then(function (res) {
          res.failed = (res.failed || []).concat(rejected);
          /* Only remember hashes for files that actually landed; a failed write
           * must be retried next turn, not skipped as unchanged. */
          var keep = {};
          Object.keys(nextHashes).forEach(function (path) {
            var landed = res.written.some(function (w) { return w.path === path; });
            if (landed || hashes[path] === nextHashes[path]) keep[path] = nextHashes[path];
          });

          var models = latestModels(payload);
          var detail = payload.meta && payload.meta.completeness_detail;
          if (!detail && AE.scoreCompleteness) detail = AE.scoreCompleteness(payload);
          var inferredSub = (AE.firstBattleSubtype && AE.firstBattleSubtype(payload)) || subtype;
          destinations[destination] = { hashes: keep, updated_at: new Date().toISOString(), rel: rel };
          index[key] = {
            rel: rel,
            mode: (payload.export && payload.export.source && payload.export.source.mode) || ((payload.battles || []).length ? "battle" : "agent"),
            subtype: inferredSub || subtype,
            title: session.title || ((payload.battles || [])[0] || {}).prompt || "",
            url: (payload.export && payload.export.source && payload.export.source.url) || null,
            models: models,
            models_pending: !models.length,
            updated_at: new Date().toISOString(),
            turns: (payload.battles || []).length || (payload.messages || []).filter(function (m) { return m.role === "assistant"; }).length,
            hashes: keep,
            destinations: destinations,
            completeness: detail ? detail.status : (payload.meta && payload.meta.completeness) || null,
            files_with_bytes: detail && detail.files ? detail.files.withBytes : null,
            files_expected: detail && detail.files ? detail.files.expected : null
          };
          if (index[key].mode === "agent") index[key].models_pending = false;
          destinations[destination].entry = {};
          ["mode", "subtype", "title", "url", "models", "models_pending", "turns"].forEach(function (field) {
            destinations[destination].entry[field] = index[key][field];
          });

          return AE.archiveIndexSave(index)
            .then(function () { return mirrorIndex(index, destination, writeFile, prefix); })
            .then(async function (mirror) {
              if (mirror && !mirror.ok) res.failed.push({ path: AE.ARCHIVE_INDEX, error: mirror.error || "archive index mirror failed" });
              var result = {
                ok: res.failed.length === 0,
                rel: rel,
                written: res.written.map(function (w) { return w.path; }),
                skipped: skipped,
                failed: res.failed
              };
              if (AE.githubQueueArchive) await AE.githubQueueArchive(payload, files, result);
              return result;
            });
        });
      });
    });
  }

  /* On-disk copy for the reader app. chrome.storage.local stays authoritative;
   * this is written last so a crash leaves the mirror stale, never the source. */
  var lastMirrorHashes = {};
  function mirrorIndex(index, destination, writeFile, prefix) {
    writeFile = writeFile || AE.writeArchiveFile;
    prefix = prefix != null ? prefix : AE.ARCHIVE_DIR;
    var view = {};
    var durable = {};
    Object.keys(index).forEach(function (k) {
      var e = index[k];
      if (!e.destinations || !e.destinations[destination]) return;
      var destinationEntry = e.destinations[destination];
      e = Object.assign({}, e, destinationEntry.entry || {});
      view[k] = {
        rel: destinationEntry.rel || e.rel, mode: e.mode, subtype: e.subtype, title: e.title,
        url: e.url, models: e.models, models_pending: e.models_pending,
        updated_at: destinationEntry.updated_at, turns: e.turns
      };
      durable[k] = {
        rel: destinationEntry.rel || e.rel, mode: e.mode, subtype: e.subtype, title: e.title,
        url: e.url, models: e.models, models_pending: e.models_pending,
        turns: e.turns
      };
    });
    var text = JSON.stringify({ version: 1, chats: view }, null, 2);
    var idxPath = prefix ? prefix + "/" + AE.ARCHIVE_INDEX : AE.ARCHIVE_INDEX;
    return sha256Hex(JSON.stringify(durable)).then(function (h) {
      if (h === lastMirrorHashes[destination]) return { ok: true, skipped: true };
      return writeFile(idxPath, text).then(function (r) {
        if (r.ok) lastMirrorHashes[destination] = h;
        return r;
      });
    });
  }
})();
