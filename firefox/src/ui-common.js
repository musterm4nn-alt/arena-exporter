/* Shared, dependency-free UI utilities for the popup and workspace. */
(function () {
  "use strict";
  var ui = globalThis.AEUI = {};
  ui.$ = function (id) { return document.getElementById(id); };
  ui.show = function (id, visible) {
    var el = ui.$(id);
    if (el) el.classList.toggle("hidden", !visible);
  };
  ui.setText = function (id, value) {
    var el = ui.$(id);
    if (el) el.textContent = value == null ? "" : String(value);
  };
  ui.setTone = function (id, tone, text) {
    var el = ui.$(id);
    if (!el) return;
    if (tone) el.dataset.tone = tone;
    if (text != null) el.textContent = String(text);
  };
  ui.on = function (id, event, handler) {
    var el = ui.$(id);
    if (el) el.addEventListener(event, handler);
  };
  ui.send = function (message) {
    return new Promise(function (resolve) {
      var settled = false;
      function finish(result) {
        if (settled) return;
        settled = true;
        resolve(result || { ok: false, error: "No response from the extension." });
      }
      function callback(result) {
        var error = chrome.runtime.lastError;
        finish(error ? { ok: false, error: error.message || "Extension unavailable. Reload it and try again." } : result);
      }
      try {
        var request = chrome.runtime.sendMessage(message, callback);
        if (request && typeof request.then === "function") {
          request.then(function (result) { callback(result); }, function (error) {
            finish({ ok: false, error: error && error.message || String(error) });
          });
        }
      } catch (error) {
        finish({ ok: false, error: error && error.message || String(error) });
      }
    });
  };
  ui.tabMessage = function (id, message, timeoutMs) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        finish({ error: "Arena did not answer. Let the current response finish, then reload the Arena tab." });
      }, timeoutMs == null ? 8000 : timeoutMs);
      function finish(result) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
      }
      try {
        var request = chrome.tabs.sendMessage(id, message, function (result) {
          void chrome.runtime.lastError;
          finish(result || { error: "Reload the Arena tab to connect page capture." });
        });
        if (request && typeof request.then === "function") {
          request.then(function (result) { finish(result || { error: "Reload the Arena tab to connect page capture." }); }, function (error) {
            finish({ error: error && error.message || "Reload the Arena tab to connect page capture." });
          });
        }
      } catch (_) {
        finish({ error: "Reload the Arena tab to connect page capture." });
      }
    });
  };
  ui.activeTab = async function () {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  };
  ui.openWorkspace = function (view) {
    return chrome.tabs.create({ url: chrome.runtime.getURL("src/options.html") + "#" + (view || "library") });
  };
  ui.feedback = function (text, tone) {
    ui.setTone("progress-msg", tone || "success", text || "");
  };
  ui.require = function (result) {
    if (!result || !result.ok) throw new Error(result && result.error || "The action could not finish.");
    return result;
  };
  ui.folderResult = function (result) {
    if (result && !result.ok && result.path) {
      ui.feedback("Folder path — paste this into your file manager: " + result.path, "warning");
      return;
    }
    ui.require(result);
    ui.feedback("Opened the conversation folder.");
  };
  ui.run = async function (id, pending, action) {
    var button = ui.$(id);
    if (!button || button.disabled) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    ui.feedback(pending);
    try {
      return await action();
    } catch (error) {
      ui.feedback(error && error.message || String(error), "error");
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      if (ui.reconcile) ui.reconcile();
    }
  };
  ui.date = function (value, withTime) {
    if (!value) return "Not yet";
    var d = new Date(value);
    if (!Number.isFinite(d.getTime())) return "Unknown";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}) });
  };
  ui.element = function (tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  ui.version = function () { ui.setText("version-badge", "v" + chrome.runtime.getManifest().version); };
  ui.number = function (value) { return Number(value || 0).toLocaleString(); };
  ui.subscribe = function (refresh) {
    var timer;
    var changed = function () { clearTimeout(timer); timer = setTimeout(refresh, 180); };
    if (chrome.runtime.onMessage) chrome.runtime.onMessage.addListener(function (message) {
      if (message && message.type === "AE_UI_CHANGED") changed();
    });
    if (chrome.storage && chrome.storage.onChanged) chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === "local" && Object.keys(changes).some(function (key) { return /github|archive_index|preferences/.test(key); })) changed();
    });
    return changed;
  };
})();
