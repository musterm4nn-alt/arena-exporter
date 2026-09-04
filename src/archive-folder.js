/* Resolve only the conversation on the selected Arena tab. Never fall back to
 * the worker's last active session when the popup belongs to another page. */
var AE = AE || {};
AE.openConversationFolder = async function (request) {
  var tabs = await new Promise(function (resolve) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (items) {
      void chrome.runtime.lastError;
      resolve(items || []);
    });
  });
  var tab = tabs[0];
  if (!tab || tab.id !== request.tabId || !/^https:\/\/([\w-]+\.)*(arena|lmarena)\.ai\//i.test(tab.url || "")) {
    return { ok: false, error: "Select an Arena conversation tab first." };
  }
  var pageKey = conversationKeyFromUrl(tab.url);
  if (!pageKey || pageKey !== request.sessionKey) return { ok: false, error: "The selected conversation changed. Reopen the extension and try again." };
  await stateReadyPromise;
  var key = canonicalSessionKey(pageKey), index = await AE.archiveIndexLoad();
  var entry = index[key] || index[pageKey];
  if (!entry) {
    var sync = await runTurnSync("manual", key, tab.id);
    if (!sync || !sync.ok) return { ok: false, error: "Archive this conversation first: " + (sync && sync.error || "write failed") };
    index = await AE.archiveIndexLoad();
    entry = index[key] || index[pageKey];
  }
  if (!entry || !AE.nativeSafeRel(entry.rel)) return { ok: false, error: "No archive folder was found for this conversation." };
  var destinations = Object.keys(entry.destinations || {}).sort(function (a, b) {
    return String(entry.destinations[b].updated_at).localeCompare(String(entry.destinations[a].updated_at));
  });
  var latest = destinations[0] || "downloads:" + AE.ARCHIVE_DIR;
  if (latest.indexOf("native:") === 0) {
    return { ok: false, error: "This conversation is in the Arena Archive app's folder. Open that folder in your file manager.",
      path: latest.slice(7) + "/" + entry.rel };
  }
  // Archive writes erase their download history. Create a small stable marker,
  // reveal it only after completion, then remove its history entry as usual.
  var result = await AE.writeArchiveFile(AE.ARCHIVE_DIR + "/" + entry.rel + "/_open-folder.txt",
    "Arena conversation archive. This file lets the extension open this folder.\n", { reveal: true });
  return { ok: result.ok, path: result.resolved || result.path, error: result.error || null };
};
