"use strict";
/* Minimal IndexedDB double: enough for research-store's key/value operations.
 * Requests complete in microtasks and a transaction completes when its queued
 * work is done, which mirrors the ordering the store relies on. */

function createIndexedDB() {
  const databases = new Map();

  function request(result) {
    const req = { result: result, error: null, onsuccess: null, onerror: null };
    return req;
  }

  function database(name) {
    if (!databases.has(name)) databases.set(name, { name: name, version: 0, stores: new Map() });
    return databases.get(name);
  }

  function makeTransaction(db, names, mode) {
    const tx = { error: null, oncomplete: null, onabort: null, onerror: null, pending: 0, completed: false, mode: mode, stores: names };
    const storeMap = new Map();
    names.forEach(function (storeName) {
      if (!db.stores.has(storeName)) throw new Error("No object store named " + storeName);
      const data = db.stores.get(storeName).data;
      const keyPath = db.stores.get(storeName).keyPath;
      storeMap.set(storeName, {
        put: function (value) {
          const key = keyPath ? value[keyPath] : value.key;
          schedule(function () { data.set(key, structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value))); });
          return request(key);
        },
        get: function (key) {
          const req = request(undefined);
          schedule(function () {
            req.result = data.has(key) ? (structuredClone ? structuredClone(data.get(key)) : JSON.parse(JSON.stringify(data.get(key)))) : undefined;
            if (req.onsuccess) req.onsuccess({ target: req });
          });
          return req;
        },
        delete: function (key) {
          schedule(function () { data.delete(key); });
          return request(undefined);
        },
        clear: function () {
          schedule(function () { data.clear(); });
          return request(undefined);
        },
        getAll: function () {
          const req = request([]);
          schedule(function () {
            req.result = Array.from(data.values()).map(function (value) {
              return structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
            });
            if (req.onsuccess) req.onsuccess({ target: req });
          });
          return req;
        },
        count: function () {
          const req = request(0);
          schedule(function () { req.result = data.size; if (req.onsuccess) req.onsuccess({ target: req }); });
          return req;
        }
      });
    });

    function maybeComplete() {
      if (tx.completed || tx.pending > 0) return;
      tx.completed = true;
      if (tx.oncomplete) tx.oncomplete();
    }

    function schedule(fn) {
      tx.pending++;
      queueMicrotask(function () {
        try { fn(); } catch (error) { tx.error = error; if (tx.onerror) tx.onerror(error); }
        tx.pending--;
        if (tx.pending === 0) queueMicrotask(maybeComplete);
      });
    }

    tx.objectStore = function (storeName) {
      const store = storeMap.get(storeName);
      if (!store) throw new Error("Store " + storeName + " is not part of this transaction");
      return store;
    };
    return tx;
  }

  function open(name, version) {
    const req = request(null);
    queueMicrotask(function () {
      const db = database(name);
      const targetVersion = version || db.version || 1;
      const upgrade = targetVersion > db.version;
      db.version = targetVersion;
      const handle = {
        name: name,
        version: targetVersion,
        objectStoreNames: { contains: storeName => db.stores.has(storeName) },
        createObjectStore: function (storeName, options) {
          db.stores.set(storeName, { keyPath: options && options.keyPath || null, data: new Map() });
          return {};
        },
        transaction: function (names, mode) {
          return makeTransaction(db, Array.isArray(names) ? names : [names], mode || "readonly");
        },
        close: function () {}
      };
      req.result = handle;
      if (upgrade && req.onupgradeneeded) req.onupgradeneeded({ target: req });
      if (req.onsuccess) req.onsuccess({ target: req });
    });
    return req;
  }

  return {
    open: open,
    deleteDatabase: function (name) {
      const req = request(undefined);
      queueMicrotask(function () { databases.delete(name); if (req.onsuccess) req.onsuccess({ target: req }); });
      return req;
    },
    databases: databases
  };
}

module.exports = { createIndexedDB };
