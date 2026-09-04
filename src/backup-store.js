/* Durable latest-snapshot outbox. Acknowledgement and revision comparison share
 * one transaction, so finishing an upload cannot erase a newer captured turn. */
var AE = AE || {};
(function () {
  "use strict";
  var opening;
  function database() {
    if (!opening) opening = new Promise(function (resolve, reject) {
      var request = indexedDB.open("arena-github-backup", 2);
      request.onupgradeneeded = function () {
        var store = request.result.objectStoreNames.contains("pending")
          ? request.transaction.objectStore("pending") : request.result.createObjectStore("pending", { keyPath: "id" });
        if (!store.indexNames.contains("target")) store.createIndex("target", "target");
      };
      request.onerror = function () { opening = null; reject(new Error("Could not open the backup queue.")); };
      request.onsuccess = function () {
        request.result.onversionchange = function () { request.result.close(); opening = null; };
        resolve(request.result);
      };
    });
    return opening;
  }
  function transaction(mode, run) {
    return database().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction("pending", mode), result;
        tx.oncomplete = function () { resolve(result); };
        tx.onabort = tx.onerror = function () { reject(new Error("Could not save the backup queue; check available disk space.")); };
        run(tx.objectStore("pending"), function (value) { result = value; });
      });
    });
  }
  AE.backupStore = {
    list: function (target, limit) {
      return transaction("readonly", function (store, done) {
        var request = target ? store.index("target").getAll(IDBKeyRange.only(target), limit || 10) : store.getAll();
        request.onsuccess = function (event) { done(event.target.result); };
      });
    },
    counts: function () {
      return transaction("readonly", function (store, done) {
        var counts = Object.create(null);
        store.index("target").openKeyCursor().onsuccess = function (event) {
          var cursor = event.target.result;
          if (!cursor) { done(counts); return; }
          counts[cursor.key] = (counts[cursor.key] || 0) + 1;
          cursor.continue();
        };
      });
    },
    put: function (item) {
      return transaction("readwrite", function (store) { store.put(item); });
    },
    acknowledge: function (items) {
      return transaction("readwrite", function (store) {
        items.forEach(function (item) {
          store.get(item.id).onsuccess = function (event) {
            if (event.target.result && event.target.result.revision === item.revision) store.delete(item.id);
          };
        });
      });
    }
  };
})();
