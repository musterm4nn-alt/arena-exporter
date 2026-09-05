/* Shared download completion for manual exports in Chrome and Firefox. */
/* downloads.download reports that a download STARTED, not that its bytes have
 * been consumed. Firefox needs the Blob URL until the terminal download event.
 * Query after subscribing to also catch tiny downloads that finished already. */
function waitForExportDownload(id) {
  return new Promise(function (resolve) {
    var settled = false;
    var downloadError = null;
    function finish(result) {
      if (settled) return;
      settled = true;
      if (chrome.downloads.onChanged && chrome.downloads.onChanged.removeListener) {
        chrome.downloads.onChanged.removeListener(changed);
      }
      resolve(Object.assign({ id: id }, result));
    }
    function changed(delta) {
      if (delta.id !== id) return;
      if (delta.error) downloadError = delta.error.current;
      if (delta.state && delta.state.current === "complete") finish({ ok: true });
      else if (delta.state && delta.state.current === "interrupted") finish({ ok: false, error: downloadError || "Download interrupted" });
    }
    try {
      chrome.downloads.onChanged.addListener(changed);
      chrome.downloads.search({ id: id }, function (items) {
        var error = chrome.runtime.lastError;
        if (error) { finish({ ok: false, error: error.message || "Cannot check download" }); return; }
        var item = items && items[0];
        if (!item) { finish({ ok: false, error: "Download record disappeared" }); return; }
        if (item.state === "complete") finish({ ok: true });
        else if (item.state === "interrupted") finish({ ok: false, error: item.error || "Download interrupted" });
      });
    } catch (error) { finish({ ok: false, error: String(error) }); }
  });
}

function downloadTextFile(filename, text, mime, saveAs) {
  mime = mime || "application/json;charset=utf-8";
  saveAs = saveAs !== false;
  filename = String(filename || "export.json").replace(/[\\/:*?"<>|]/g, "_");
  return new Promise(function (resolve) {
    var blobUrl = null;
    try {
      if (typeof URL !== "undefined" && URL.createObjectURL && typeof Blob !== "undefined") {
        blobUrl = URL.createObjectURL(new Blob([text], { type: mime }));
      }
    } catch (e0) { blobUrl = null; }
    var dataUrl = "data:" + mime + "," + encodeURIComponent(text);
    function cleanup() {
      if (!blobUrl) return;
      try { URL.revokeObjectURL(blobUrl); } catch (e) { /* ignore */ }
      blobUrl = null;
    }
    function attempt(url, useSaveAs, triedBlob) {
      try {
        chrome.downloads.download({
          url: url,
          filename: filename,
          saveAs: !!useSaveAs,
          conflictAction: "uniquify"
        }, function (id) {
          var err = (chrome.runtime.lastError && chrome.runtime.lastError.message) || null;
          if (err && /cancel/i.test(err)) { cleanup(); resolve({ ok: false, error: err }); return; }
          if (err && useSaveAs) { attempt(url, false, triedBlob); return; }
          if (err && triedBlob && url === blobUrl) { attempt(dataUrl, useSaveAs, false); return; }
          if (err || id == null) {
            cleanup();
            resolve({ ok: false, error: err || "Download refused" });
            return;
          }
          waitForExportDownload(id).then(function (result) {
            cleanup();
            resolve(result);
          });
        });
      } catch (e) {
        cleanup();
        resolve({ ok: false, error: String(e) });
      }
    }
    attempt(blobUrl || dataUrl, saveAs, !!blobUrl);
  });
}

function downloadDataUrlFile(filename, dataUrl) {
  filename = String(filename || "file").replace(/[\\/:*?"<>|]/g, "_");
  return new Promise(function (resolve) {
    try {
      chrome.downloads.download({
        url: dataUrl,
        filename: filename,
        saveAs: false,
        conflictAction: "uniquify"
      }, function (id) {
        var err = (chrome.runtime.lastError && chrome.runtime.lastError.message) || null;
        if (err || id == null) { resolve({ ok: false, error: err || "Download refused" }); return; }
        waitForExportDownload(id).then(resolve);
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

