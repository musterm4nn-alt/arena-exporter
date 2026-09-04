/* Minimal chrome.* fakes shared by the worker tests.
 * Faithful enough that the archive sink runs for real: downloads resolve to a
 * path containing the requested relative filename, which is exactly what
 * AE.writeArchiveFile verifies before trusting Chrome's "complete". */
"use strict";

function fakeStorageArea() {
  const data = {};
  return {
    _data: data,
    get: (keys, cb) => {
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      list.forEach((k) => { if (k in data) out[k] = JSON.parse(JSON.stringify(data[k])); });
      if (cb) { cb(out); return; }
      return Promise.resolve(out);
    },
    set: (obj, cb) => {
      Object.assign(data, JSON.parse(JSON.stringify(obj)));
      if (cb) { cb(); return; }
      return Promise.resolve();
    }
  };
}

/* Records every write. `fail` lets a test force a failure for one path. */
function fakeDownloads(writes, opts) {
  opts = opts || {};
  let nextId = 1;
  const items = {};
  return {
    download: (o, cb) => {
      const id = nextId++;
      const failing = opts.failPath && o.filename.indexOf(opts.failPath) !== -1;
      items[id] = {
        id,
        state: failing ? "interrupted" : "complete",
        filename: failing ? "" : "/fake/Downloads/" + o.filename,
        error: failing ? "FILE_FAILED" : null,
        bytesReceived: failing ? 0 : 1
      };
      writes.push({ filename: o.filename, url: o.url, ok: !failing });
      cb(id);
    },
    search: (q, cb) => cb(items[q.id] ? [items[q.id]] : []),
    erase: (q, cb) => { delete items[q.id]; cb([q.id]); },
    setUiOptions: (o, cb) => { if (cb) cb(); },
    onChanged: { addListener: () => {} }
  };
}

function decodeWrite(w) {
  const comma = w.url.indexOf(",");
  return decodeURIComponent(w.url.slice(comma + 1));
}

module.exports = { fakeStorageArea, fakeDownloads, decodeWrite };
