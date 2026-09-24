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
  const INDEX_KEY = "ae_archive_index";
  /* chrome.downloads takes a data: URL; there is no URL.createObjectURL in a
   * service worker. Cap the *encoded* URL, not the raw string: encodeURIComponent
   * can triple the size, and Chrome refuses data: URLs around 2MB. */
  const MAX_DATA_URL_BYTES = 1.8 * 1024 * 1024;
  AE.ARCHIVE_LIMITS = {
    downloadsDataUrlBytes: MAX_DATA_URL_BYTES,
    attachmentFetchBytes: 15 * 1024 * 1024,
    nativeFileBytes: 32 * 1024 * 1024
  };
  let uiSuppressed = false;

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
    const bytes = new TextEncoder().encode(String(str == null ? "" : str));
    return crypto.subtle.digest("SHA-256", bytes).then(function (buf) {
      const a = new Uint8Array(buf);
      let out = "";
      for (let i = 0; i < a.length; i++) {
        const h = a[i].toString(16);
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
      const o = JSON.parse(text);
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
    let url = dataUrlFor(path, text);
    if (url.length <= MAX_DATA_URL_BYTES) return { text: text, url: url };
    if (/conversation\.json$/i.test(path)) {
      const slim = AE.slimArchiveJson(text);
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
      const downloadsUi = chrome.downloads && chrome.downloads["setUiOptions"];
      if (typeof downloadsUi !== "function") {
        resolve(false);
        return;
      }
      try {
        downloadsUi({ enabled: !enabled }, function () {
          const err = chrome.runtime.lastError;
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
        const it = items && items[0];
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
    const safe = AE.safeArchivePath ? AE.safeArchivePath(relPath) : relPath;
    if (!safe) {
      return Promise.resolve({ ok: false, path: relPath, error: "illegal path" });
    }
    const text = String(content == null ? "" : content);
    let fitted;
    if (/^data:[^,]*,/.test(text)) {
      if (text.length > MAX_DATA_URL_BYTES) {
        return Promise.resolve({
          ok: false,
          path: safe,
          error: "too large for the Downloads data URL (" + text.length + " encoded bytes; native archive supports larger files)"
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
        error: "too large for the Downloads data URL (" + fitted.url.length + " encoded bytes; native archive supports larger files)"
      });
    }
    return new Promise(function (resolve) {
      chrome.downloads.download({
        url: fitted.url, filename: safe, conflictAction: "overwrite", saveAs: false
      }, function (id) {
        const err = chrome.runtime.lastError;
        if (err || id == null) {
          resolve({ ok: false, path: safe, error: (err && err.message) || "download refused" });
          return;
        }
        awaitTerminal(id, 0).then(async function (res) {
          const landedPath = (res.resolved || "").replace(/\\/g, "/");
          const correctPath = landedPath === safe || landedPath.endsWith("/" + safe);
          if (options && options.reveal && res.ok && correctPath) {
            try {
              // Firefox's browser namespace reports show() failures as a Promise.
              const downloadsApi = typeof browser !== "undefined" ? browser.downloads : chrome.downloads;
              const shown = await downloadsApi.show(id);
              if (shown === false) throw new Error("Folder could not be opened.");
            } catch (error) { res.ok = false; res.error = "Folder could not be opened: " + error.message; }
          }
          return eraseWhenSettled(id).then(function () {
            /* Chrome reports "complete" even when it has silently rewritten the
             * target, so verify the path it actually used ends where we asked. */
            const landed = correctPath;
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
    const battles = (payload && payload.battles) || [];
    if (!battles.length) return [];
    const latest = battles[battles.length - 1];
    return (latest.contestants || []).map(function (c) { return c && c.model; }).filter(Boolean);
  }

  function archiveRelOwner(index, key, rel) {
    const keys = Object.keys(index || {});
    for (let i = 0; i < keys.length; i++) {
      const otherKey = keys[i];
      if (otherKey !== key && index[otherKey] && index[otherKey].rel === rel) return otherKey;
    }
    return null;
  }

  /* Serial, not parallel: every write is a download plus a history erase, and
   * firing a dozen at once makes Chrome queue them unpredictably. */
  function writeSequential(jobs) {
    const written = [], failed = [];
    let chain = Promise.resolve();
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
  let archiveWriteQueue = Promise.resolve();
  function encryptionMigrationBlock(payload) {
    const session = payload && payload.session || {};
    const key = session.conversation_key || session.session_id;
    if (!key) return Promise.resolve(null);
    return AE.archiveIndexLoad().then(function (index) {
      const existing = index[key];
      if (!existing) return null;
      if (!existing.encrypted && Object.keys(existing.hashes || {}).some(function (file) { return file !== AE.ARCHIVE_INDEX; })) {
        return "This conversation already has plaintext archive files. Move or remove that archive before enabling encryption.";
      }
      const destinations = existing.destinations || {};
      const hasPlaintext = Object.keys(destinations).some(function (destination) {
        const state = destinations[destination] || {};
        if (state.encrypted) return false;
        return Object.keys(state.hashes || {}).some(function (file) { return file !== AE.ARCHIVE_INDEX; });
      });
      return hasPlaintext ? "This conversation already has plaintext archive files. Move or remove that archive before enabling encryption." : null;
    });
  }
  AE.writeArchive = function (payload, files, opts) {
    opts = opts || {};
    const task = archiveWriteQueue.then(function () {
      if (!opts._encrypted && AE.archiveEncryption && AE.archiveEncryption.status().enabled) {
        if (!AE.archiveEncryption.isUnlocked()) {
          return { ok: false, error: "Unlock encrypted archives before saving.", failed: [{ path: "conversation.enc", error: "archive encryption is locked" }] };
        }
        return encryptionMigrationBlock(payload).then(function (migrationError) {
          if (migrationError) return { ok: false, error: migrationError, failed: [{ path: "conversation.enc", error: migrationError }] };
          return sha256Hex(JSON.stringify({
            fingerprint: AE.archiveEncryption.fingerprint ? AE.archiveEncryption.fingerprint() : null,
            files: (files || []).map(function (file) { return [file.path, file.encoding || "utf8", file.content]; })
          })).then(function (sourceHash) {
            return AE.archiveEncryption.encryptFiles(files || []).then(function (content) {
              return writeArchive(payload, [{ path: "conversation.enc", encoding: "utf8", content: content }], Object.assign({}, opts, { _encrypted: true, encrypted: true, sourceHash: sourceHash }));
            });
          });
        });
      }
      return writeArchive(payload, files, opts);
    });
    archiveWriteQueue = task.catch(function () {});
    return task.catch(function (err) {
      return { ok: false, error: String(err && err.message || err), failed: [{ path: INDEX_KEY, error: String(err && err.message || err) }] };
    });
  };

  function writeArchive(payload, files, opts) {
    opts = opts || {};
    const prefix = opts.prefix != null ? opts.prefix : AE.ARCHIVE_DIR;
    const destination = opts.destinationKey || "downloads:" + prefix;
    const writeJobs = opts.writeJobs || writeSequential;
    const writeFile = opts.writeFile || AE.writeArchiveFile;
    return AE.archiveIndexLoad().then(function (index) {
      const session = (payload && payload.session) || {};
      const key = session.conversation_key || session.session_id;
      if (!key) return { ok: false, error: "no conversation key" };

      const existing = index[key] || null;
      const existingRel = existing && existing.rel ? existing.rel : null;
      const collisionOwner = existingRel ? archiveRelOwner(index, key, existingRel) : null;
      /* v1.15.0 and earlier used only the first eight UUID characters. If an
       * old index has two keys pinned to that same folder, move each one to its
       * new full-id path on its next sync instead of preserving the collision. */
      const repairedCollision = !!collisionOwner;
      let rel = existingRel && !repairedCollision
        ? existingRel
        : AE.archiveRelFor(payload, null);
      const relSafe = AE.safeArchivePath ? AE.safeArchivePath(rel) : rel;
      if (!relSafe) return { ok: false, error: "illegal archive path" };
      rel = relSafe;
      const subtype = existing && existing.subtype
        ? existing.subtype
        : (AE.firstBattleSubtype ? AE.firstBattleSubtype(payload) : null);

      /* Hashes are relative to the conversation folder. A relocated chat must
       * rewrite every file into its new folder even when its bytes are unchanged. */
      const destinations = Object.assign({}, (existing && existing.destinations) || {});
      const destinationState = destinations[destination];
      // Legacy unscoped hashes are deliberately ignored once, to populate the
      // current destination after upgrading or changing the native app's root.
      const hashes = repairedCollision || (destinationState && destinationState.rel !== rel) ? {} : ((destinationState && destinationState.hashes) || {});
      const nextHashes = {};
      const jobs = [];
      let skipped = 0;
      const rejected = [];

      if (repairedCollision && AE.decorateArchivePaths && AE.filesToWrite) {
        AE.decorateArchivePaths(payload, rel);
        files = AE.filesToWrite(payload);
      }

      let chain = Promise.resolve();
      (files || []).forEach(function (f) {
        if (!f || typeof f.content !== "string" || !f.path) return;
        const filePath = AE.safeArchivePath ? AE.safeArchivePath(f.path) : f.path;
        if (!filePath) {
          rejected.push({ path: f.path, error: "illegal path" });
          return;
        }
        chain = chain.then(function () {
          const contentHash = opts.encrypted && opts.sourceHash && filePath === "conversation.enc" ? Promise.resolve(opts.sourceHash) : sha256Hex((f.encoding || "utf8") + "\n" + f.content);
          return contentHash.then(function (h) {
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
          const keep = {};
          Object.keys(nextHashes).forEach(function (path) {
            const landed = res.written.some(function (w) { return w.path === path; });
            if (landed || hashes[path] === nextHashes[path]) keep[path] = nextHashes[path];
          });

          const models = latestModels(payload);
          let detail = payload.meta && payload.meta.completeness_detail;
          if (!detail && AE.scoreCompleteness) detail = AE.scoreCompleteness(payload);
          const inferredSub = (AE.firstBattleSubtype && AE.firstBattleSubtype(payload)) || subtype;
          destinations[destination] = { hashes: keep, updated_at: new Date().toISOString(), rel: rel, encrypted: !!opts.encrypted, encryption_format: opts.encrypted && AE.archiveEncryption ? AE.archiveEncryption.format : null };
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
            completeness_detail: detail || null,
            files_with_bytes: detail && detail.files ? detail.files.withBytes : null,
            files_expected: detail && detail.files ? detail.files.expected : null,
            encrypted: !!opts.encrypted,
            encryption_format: opts.encrypted && AE.archiveEncryption ? AE.archiveEncryption.format : null
          };
          if (index[key].mode === "agent") index[key].models_pending = false;
          destinations[destination].entry = {};
          ["mode", "subtype", "title", "url", "models", "models_pending", "turns", "encrypted", "encryption_format"].forEach(function (field) {
            destinations[destination].entry[field] = index[key][field];
          });

          return AE.archiveIndexSave(index)
            .then(function () { return mirrorIndex(index, destination, writeFile, prefix); })
            .then(async function (mirror) {
              if (mirror && !mirror.ok) res.failed.push({ path: AE.ARCHIVE_INDEX, error: mirror.error || "archive index mirror failed" });
              const result = {
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
  const lastMirrorHashes = {};
  function mirrorIndex(index, destination, writeFile, prefix) {
    writeFile = writeFile || AE.writeArchiveFile;
    prefix = prefix != null ? prefix : AE.ARCHIVE_DIR;
    const view = {};
    const durable = {};
    Object.keys(index).forEach(function (k) {
      let e = index[k];
      if (!e.destinations || !e.destinations[destination]) return;
      const destinationEntry = e.destinations[destination];
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
    const text = JSON.stringify({ version: 1, chats: view }, null, 2);
    const idxPath = prefix ? prefix + "/" + AE.ARCHIVE_INDEX : AE.ARCHIVE_INDEX;
    return sha256Hex(JSON.stringify(durable)).then(function (h) {
      if (h === lastMirrorHashes[destination]) return { ok: true, skipped: true };
      return writeFile(idxPath, text).then(function (r) {
        if (r.ok) lastMirrorHashes[destination] = h;
        return r;
      });
    });
  }
})();
