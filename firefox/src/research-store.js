/* Local library storage (IndexedDB).
 *
 * Records hold the bounded projection used by search and reading; the exact
 * archived conversation.json text is kept beside it so exports are byte-equal
 * to the archive and hashes can be compared with the archive index.
 *
 * Privacy rule: when archive encryption is enabled the library is disabled and
 * cleared, because these records are plaintext. The workspace says so instead
 * of quietly indexing sealed conversations.
 */
var AE = AE || {};
(function () {
  "use strict";

  const DB_NAME = "arena-research";
  const DB_VERSION = 1;
  const RECORDS = "records";
  const PAYLOADS = "payloads";
  const STATE = "state";
  let opening = null;

  function unavailable() {
    return new Error("The local library is unavailable in this browser session.");
  }

  function available() {
    try {
      return typeof indexedDB !== "undefined" && indexedDB && typeof indexedDB.open === "function";
    } catch (_) {
      return false;
    }
  }

  function encryptionBlocked() {
    try {
      return !!(AE.archiveEncryption && AE.archiveEncryption.status && AE.archiveEncryption.status().enabled);
    } catch (_) {
      return false;
    }
  }

  function openDatabase() {
    if (!available()) return Promise.reject(unavailable());
    if (opening) return opening;
    opening = new Promise(function (resolve, reject) {
      let request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (error) {
        opening = null;
        reject(error);
        return;
      }
      request.onupgradeneeded = function () {
        const db = request.result;
        if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS, { keyPath: "key" });
        if (!db.objectStoreNames.contains(PAYLOADS)) db.createObjectStore(PAYLOADS, { keyPath: "key" });
        if (!db.objectStoreNames.contains(STATE)) db.createObjectStore(STATE, { keyPath: "id" });
      };
      request.onerror = function () {
        opening = null;
        reject(request.error || new Error("Could not open the local library."));
      };
      request.onsuccess = function () {
        const db = request.result;
        db.onversionchange = function () { db.close(); opening = null; };
        resolve(db);
      };
    });
    return opening;
  }

  function transaction(names, mode, run) {
    return openDatabase().then(function (db) {
      return new Promise(function (resolve, reject) {
        let tx;
        try {
          tx = db.transaction(names, mode);
        } catch (error) {
          reject(error);
          return;
        }
        let result;
        tx.oncomplete = function () { resolve(result); };
        tx.onabort = function () { reject(tx.error || new Error("The local library write was aborted; check available disk space.")); };
        tx.onerror = function () { reject(tx.error || new Error("The local library write failed; check available disk space.")); };
        try {
          run(tx, function (value) { result = value; });
        } catch (error) {
          try { tx.abort(); } catch (_) { /* already aborted */ }
          reject(error);
        }
      });
    });
  }

  function readState(tx, done) {
    const request = tx.objectStore(STATE).get("status");
    request.onsuccess = function () {
      done(request.result || { id: "status", count: 0, bytes: 0, last_indexed_at: null });
    };
  }

  function byteSize(value) {
    try { return new TextEncoder().encode(String(value == null ? "" : value)).length; } catch (_) { return String(value == null ? "" : value).length; }
  }

  function blockedError() {
    return new Error("The local library is off while archive encryption is enabled. Plaintext indexes are never kept beside sealed archives.");
  }

  async function status() {
    if (!available()) return { available: false, blocked: encryptionBlocked(), count: 0, bytes: 0, last_indexed_at: null, error: unavailable().message };
    if (encryptionBlocked()) return { available: true, blocked: true, count: 0, bytes: 0, last_indexed_at: null, error: blockedError().message };
    try {
      const state = await transaction([STATE], "readonly", function (tx, done) { readState(tx, done); });
      return { available: true, blocked: false, count: state.count || 0, bytes: state.bytes || 0, last_indexed_at: state.last_indexed_at || null, error: null };
    } catch (error) {
      return { available: false, blocked: encryptionBlocked(), count: 0, bytes: 0, last_indexed_at: null, error: String(error.message || error) };
    }
  }

  function list() {
    if (!available()) return Promise.reject(unavailable());
    if (encryptionBlocked()) return Promise.reject(blockedError());
    return transaction([RECORDS], "readonly", function (tx, done) {
      const request = tx.objectStore(RECORDS).getAll();
      request.onsuccess = function () {
        const records = (request.result || []).slice().sort(function (a, b) {
          return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
        });
        done(records);
      };
    });
  }

  function get(key) {
    if (!available()) return Promise.reject(unavailable());
    if (encryptionBlocked()) return Promise.reject(blockedError());
    return transaction([RECORDS, PAYLOADS], "readonly", function (tx, done) {
      const recordRequest = tx.objectStore(RECORDS).get(String(key));
      const payloadRequest = tx.objectStore(PAYLOADS).get(String(key));
      let record = null, payload = null, recordReady = false, payloadReady = false;
      function maybe() {
        if (recordReady && payloadReady) done({ record: record, json: payload ? payload.json : null });
      }
      recordRequest.onsuccess = function () { record = recordRequest.result || null; recordReady = true; maybe(); };
      payloadRequest.onsuccess = function () { payload = payloadRequest.result || null; payloadReady = true; maybe(); };
    });
  }

  function has(key) {
    if (!available() || encryptionBlocked()) return Promise.resolve(false);
    return transaction([RECORDS], "readonly", function (tx, done) {
      const request = tx.objectStore(RECORDS).get(String(key));
      request.onsuccess = function () { done(!!request.result); };
    }).catch(function () { return false; });
  }

  function putRecord(record, json, hash) {
    if (!available()) return Promise.reject(unavailable());
    if (encryptionBlocked()) return Promise.reject(blockedError());
    const copy = Object.assign({}, record, { payload_hash: hash || null, stored_bytes: 0 });
    const payloadStored = !!(json && !copy.payload_omitted);
    copy.stored_bytes = byteSize(JSON.stringify(copy)) + (payloadStored ? byteSize(json) : 0);
    return transaction([RECORDS, PAYLOADS, STATE], "readwrite", function (tx, done) {
      const records = tx.objectStore(RECORDS), payloads = tx.objectStore(PAYLOADS), state = tx.objectStore(STATE);
      const existing = records.get(copy.key);
      existing.onsuccess = function () {
        const old = existing.result;
        records.put(copy);
        if (payloadStored) payloads.put({ key: copy.key, json: json });
        else payloads.delete(copy.key);
        readState(tx, function (current) {
          state.put({
            id: "status",
            count: current.count + (old ? 0 : 1),
            bytes: Math.max(0, (current.bytes || 0) - (old ? Number(old.stored_bytes || old.payload_bytes) || 0 : 0) + (Number(copy.stored_bytes) || 0)),
            last_indexed_at: copy.indexed_at
          });
          done(copy);
        });
      };
    });
  }

  async function indexJson(jsonText, options) {
    options = options || {};
    if (encryptionBlocked()) throw blockedError();
    const record = AE.research.buildRecord(jsonText, options);
    const hash = await AE.research.archiveHash(jsonText);
    const saved = await putRecord(record, jsonText, hash);
    return { ok: true, key: saved.key, record: saved, payload_omitted: saved.payload_omitted };
  }

  async function indexArchive(payload, jsonText, options) {
    if (!jsonText) return { ok: false, error: "No conversation JSON to index." };
    return indexJson(jsonText, options || {});
  }

  async function importJson(jsonText, options) {
    return indexJson(jsonText, Object.assign({ source: "import" }, options || {}));
  }

  function remove(keys) {
    if (!available()) return Promise.reject(unavailable());
    const list = Array.isArray(keys) ? keys : [keys];
    return transaction([RECORDS, PAYLOADS, STATE], "readwrite", function (tx, done) {
      const records = tx.objectStore(RECORDS), payloads = tx.objectStore(PAYLOADS), state = tx.objectStore(STATE);
      let removed = 0, removedBytes = 0;
      function next(index) {
        if (index >= list.length) {
          readState(tx, function (current) {
            state.put({
              id: "status",
              count: Math.max(0, current.count - removed),
              bytes: Math.max(0, (current.bytes || 0) - removedBytes),
              last_indexed_at: current.last_indexed_at || null
            });
            done(removed);
          });
          return;
        }
        const key = String(list[index]);
        const existing = records.get(key);
        existing.onsuccess = function () {
          if (existing.result) {
            removed++;
            removedBytes += Number(existing.result.stored_bytes || existing.result.payload_bytes) || 0;
          }
          records.delete(key);
          payloads.delete(key);
          next(index + 1);
        };
      }
      next(0);
    });
  }

  function clear() {
    if (!available()) return Promise.reject(unavailable());
    return transaction([RECORDS, PAYLOADS, STATE], "readwrite", function (tx, done) {
      tx.objectStore(RECORDS).clear();
      tx.objectStore(PAYLOADS).clear();
      tx.objectStore(STATE).put({ id: "status", count: 0, bytes: 0, last_indexed_at: null });
      done(true);
    });
  }

  function newestHash(entry) {
    if (!entry) return null;
    const destinations = entry.destinations || {};
    const keys = Object.keys(destinations);
    if (!keys.length) return entry.hashes && entry.hashes["conversation.json"] || null;
    keys.sort(function (a, b) { return String(destinations[b].updated_at || "").localeCompare(String(destinations[a].updated_at || "")); });
    const hashes = destinations[keys[0]] && destinations[keys[0]].hashes || {};
    return hashes["conversation.json"] || null;
  }

  async function verify(archiveIndex) {
    if (encryptionBlocked()) throw blockedError();
    const index = archiveIndex || {};
    const records = await list();
    const byKey = Object.create(null);
    records.forEach(function (record) { byKey[record.key] = record; });
    const report = {
      generated_at: new Date().toISOString(),
      archive_count: Object.keys(index).length,
      library_count: records.length,
      checked: 0,
      matched: 0,
      mismatched: [],
      missing: [],
      orphaned: [],
      stale: [],
      unchecked: []
    };
    for (const record of records) {
      const entry = index[record.key];
      if (!entry) {
        report.orphaned.push({ key: record.key, title: record.title });
        continue;
      }
      if (entry.updated_at && record.updated_at && String(entry.updated_at) > String(record.updated_at)) {
        report.stale.push({ key: record.key, title: record.title, archive_updated_at: entry.updated_at, library_updated_at: record.updated_at });
      }
      const expected = newestHash(entry);
      if (!record.payload_hash) {
        report.unchecked.push({ key: record.key, title: record.title, reason: "no_payload" });
        continue;
      }
      if (!expected) {
        report.unchecked.push({ key: record.key, title: record.title, reason: "no_archive_hash" });
        continue;
      }
      let payload = null;
      try { payload = await get(record.key); } catch (_) { payload = null; }
      if (!payload || !payload.json) {
        report.unchecked.push({ key: record.key, title: record.title, reason: "payload_not_stored" });
        continue;
      }
      const actual = await AE.research.archiveHash(payload.json);
      report.checked++;
      if (actual === expected) report.matched++;
      else report.mismatched.push({ key: record.key, title: record.title, expected: expected, actual: actual });
    }
    Object.keys(index).forEach(function (key) {
      if (!byKey[key]) report.missing.push({ key: key, title: index[key] && index[key].title || "Untitled conversation", updated_at: index[key] && index[key].updated_at || null });
    });
    report.missing.sort(function (a, b) { return String(b.updated_at || "").localeCompare(String(a.updated_at || "")); });
    return report;
  }

  async function importItems(items) {
    const list = Array.isArray(items) ? items : [];
    const result = { imported: 0, skipped: [], keys: [] };
    for (const item of list) {
      if (!item || typeof item.text !== "string") {
        result.skipped.push({ path: item && item.path || "unknown", reason: "empty" });
        continue;
      }
      try {
        const saved = await importJson(item.text, {
          source: "import",
          rel: item.rel || null,
          updated_at: item.updated_at || (item.lastModified ? new Date(item.lastModified).toISOString() : null)
        });
        result.imported++;
        result.keys.push(saved.key);
      } catch (error) {
        result.skipped.push({ path: item.path || "unknown", reason: String(error.message || error) });
      }
    }
    return result;
  }

  AE.researchStore = {
    available: available,
    encryptionBlocked: encryptionBlocked,
    status: status,
    list: list,
    get: get,
    has: has,
    indexJson: indexJson,
    indexArchive: indexArchive,
    importJson: importJson,
    importItems: importItems,
    remove: remove,
    clear: clear,
    verify: verify
  };
})();
