/* SPIKE (v1.11.x): persisted File System Access root handle.
 *
 * The handle lives in IndexedDB rather than chrome.storage because a
 * FileSystemDirectoryHandle is structured-cloneable but not JSON-serialisable.
 * Both the options page (which can call showDirectoryPicker behind a click)
 * and the service worker (which cannot) read the same record.
 *
 * What this spike exists to answer: does a readwrite grant survive a full
 * browser restart, so the worker can keep writing without another gesture? */
var AE = AE || {};

(function () {
  "use strict";

  var DB_NAME = "ae_fs";
  var STORE = "handles";
  var ROOT_KEY = "archive_root";

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function withStore(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var req = fn(t.objectStore(STORE));
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  AE.fsSaveRoot = function (handle) { return withStore("readwrite", function (s) { return s.put(handle, ROOT_KEY); }); };
  AE.fsLoadRoot = function () { return withStore("readonly", function (s) { return s.get(ROOT_KEY); }); };
  AE.fsClearRoot = function () { return withStore("readwrite", function (s) { return s.delete(ROOT_KEY); }); };

  AE.fsSupported = function () {
    return typeof self !== "undefined" && typeof self.showDirectoryPicker === "function";
  };

  /* "granted" | "prompt" | "denied" | "no_handle" | "unsupported" */
  AE.fsPermission = function (handle) {
    if (!handle) return Promise.resolve("no_handle");
    if (typeof handle.queryPermission !== "function") return Promise.resolve("unsupported");
    return Promise.resolve(handle.queryPermission({ mode: "readwrite" }));
  };

  /* Resolve a/b/c.txt under root, creating directories as needed. */
  AE.fsWrite = function (root, relPath, content) {
    var parts = String(relPath || "").split("/").filter(Boolean);
    if (!parts.length) return Promise.reject(new Error("empty path"));
    var name = parts.pop();
    var dir = Promise.resolve(root);
    parts.forEach(function (segment) {
      dir = dir.then(function (d) { return d.getDirectoryHandle(segment, { create: true }); });
    });
    return dir
      .then(function (d) { return d.getFileHandle(name, { create: true }); })
      .then(function (fh) { return fh.createWritable(); })
      .then(function (w) {
        return Promise.resolve(w.write(content)).then(function () { return w.close(); });
      })
      .then(function () { return { ok: true, path: relPath, bytes: String(content).length }; });
  };
})();
