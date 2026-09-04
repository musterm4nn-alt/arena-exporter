"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const { fakeStorageArea, fakeDownloads } = require("./fake-chrome");

function worker(options = {}) {
  const root = path.join(__dirname, "..", options.firefox ? "firefox/src" : "src");
  const timers = new Map(), writes = [];
  let sequence = 0, listener;
  const local = options.local || fakeStorageArea();
  const context = vm.createContext({
    console, URL: options.URL || URL, Blob, TextEncoder, TextDecoder, crypto: globalThis.crypto,
    setTimeout: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id), setInterval: () => ++sequence, clearInterval: () => {},
    fetch: options.fetch || (async () => ({ ok: false, status: 404 })),
    chrome: {
      storage: { session: options.session || fakeStorageArea(), local },
      downloads: options.downloads || fakeDownloads(writes),
      runtime: {
        lastError: null, onMessage: { addListener: fn => { listener = fn; } },
        getManifest: () => JSON.parse(fs.readFileSync(path.join(root, "..", "manifest.json"), "utf8"))
      },
      tabs: {
        query: (_q, cb) => cb(options.tabs || []),
        sendMessage: (id, _msg, cb) => cb(options.snapshot ? options.snapshot(id) : null)
      }
    }
  });
  if (options.firefox) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "..", "manifest.json"), "utf8"));
    manifest.background.scripts.forEach(file => vm.runInContext(fs.readFileSync(path.join(root, "..", file), "utf8"), context, { filename: file }));
  } else {
    context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file }));
    vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), context, { filename: "background.js" });
  }
  const send = (message, tab = { id: 1, url: "https://arena.ai/" }) => new Promise(resolve => {
    const value = listener(message, tab ? { tab } : {}, resolve);
    if (value === undefined) resolve(null);
  });
  return {
    context, timers, local, writes, send,
    ready: () => context.stateReadyPromise,
    event: (evt, tab) => send({ type: "AE_EVENT", evt }, tab),
    export: async (key, snapshot) => {
      const result = await send({ type: "AE_EXPORT", sessionKey: key, mode: "full_history", snapshot }, null);
      if (!result || !result.ok) throw new Error(result && result.error || "export failed");
      return JSON.parse(result.json);
    }
  };
}
module.exports = { worker };
