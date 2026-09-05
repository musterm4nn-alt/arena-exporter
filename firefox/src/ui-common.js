/* Document utilities. Conversation content is rendered with textContent. */
(function () {
  "use strict";
  var ui = globalThis.AEUI = {};
  ui.$ = function (id) { return document.getElementById(id); };
  ui.show = function (id, visible) { ui.$(id).classList.toggle("hidden", !visible); };
  ui.on = function (id, event, handler) { ui.$(id).addEventListener(event, handler); };
  ui.send = function (message) {
    return new Promise(function (resolve) {
      try { chrome.runtime.sendMessage(message, function (result) {
        var error = chrome.runtime.lastError;
        resolve(error ? { ok: false, error: error.message || "Extension unavailable. Reload it and try again." } : result || { ok: false, error: "No response from the extension." });
      }); } catch (error) { resolve({ ok: false, error: error.message }); }
    });
  };
  ui.tabMessage = function (id, message) {
    return new Promise(function (resolve) {
      try { chrome.tabs.sendMessage(id, message, function (result) { void chrome.runtime.lastError; resolve(result || null); }); }
      catch (_) { resolve(null); }
    });
  };
  ui.activeTab = async function () { var tabs = await chrome.tabs.query({ active: true, currentWindow: true }); return tabs[0] || null; };
  ui.openWorkspace = function (view) { return chrome.tabs.create({ url: chrome.runtime.getURL("src/options.html") + "#" + (view || "library") }); };
  ui.feedback = function (text, tone) { var el=ui.$("progress-msg"); el.textContent=text || ""; el.dataset.tone=tone || "success"; };
  ui.require = function (result) { if (!result || !result.ok) throw new Error(result && result.error || "The action could not finish."); return result; };
  ui.run = async function (id, pending, action) {
    var button=ui.$(id); if (button.disabled) return;
    button.disabled=true; button.setAttribute("aria-busy","true"); ui.feedback(pending);
    try { return await action(); } catch (error) { ui.feedback(error.message || String(error),"error"); }
    finally { button.disabled=false; button.removeAttribute("aria-busy"); if(ui.reconcile)ui.reconcile(); }
  };
  ui.date = function (value, withTime) {
    if (!value) return "Not yet"; var d=new Date(value); if (!Number.isFinite(d.getTime())) return "Unknown";
    return d.toLocaleDateString(undefined,{month:"short",day:"numeric",...(withTime ? {hour:"2-digit",minute:"2-digit"} : {})});
  };
  ui.element = function (tag, cls, text) { var e=document.createElement(tag); if(cls)e.className=cls;if(text != null)e.textContent=text;return e; };
  ui.version = function () { ui.$("version-badge").textContent="v"+chrome.runtime.getManifest().version; };
  ui.subscribe = function (refresh) {
    var timer;
    var changed=function () { clearTimeout(timer); timer=setTimeout(refresh,180); };
    if(chrome.runtime.onMessage) chrome.runtime.onMessage.addListener(function (m) { if(m.type === "AE_UI_CHANGED")changed(); });
    if(chrome.storage && chrome.storage.onChanged) chrome.storage.onChanged.addListener(function (changes,area) {
      if(area === "local" && Object.keys(changes).some(function(k){return /github|archive_index|preferences/.test(k);}))changed();
    });
    return changed;
  };
})();
