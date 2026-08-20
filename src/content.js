/* ISOLATED-world content script: bridges MAIN-world interceptor events into
 * the extension (service worker), and serves on-demand DOM snapshots for
 * fallback/backfill and completeness checks at export time. */
(function () {
  "use strict";
  if (window.__arenaExporterContentInstalled) return;
  window.__arenaExporterContentInstalled = true;

  /* Forward captured network events from the MAIN world to the service worker. */
  window.addEventListener("message", function (ev) {
    if (ev.source !== window || !ev.data || ev.data.type !== AE.MSG_NS) return;
    try {
      chrome.runtime.sendMessage({ type: "AE_EVENT", evt: ev.data.evt }, function () {
        void chrome.runtime.lastError; // swallow "worker sleeping" races
      });
    } catch (e) { /* extension context invalidated (reload) — drop */ }
  }, false);

  /* ---------- ballot click capture ----------
   * The vote mutation is client-side and may not produce a network request.
   * Capture the semantic choice at the point of user interaction, before
   * React removes/re-renders the ballot controls. */
  var lastVoteClick = { key: "", at: 0 };

  function conversationKeyFromHref(href) {
    var m = /\/c\/([A-Za-z0-9_-]+)/.exec(String(href || ""));
    return m ? "c:" + m[1] : null;
  }

  function emitPageContext() {
    try {
      chrome.runtime.sendMessage({
        type: "AE_EVENT",
        evt: {
          kind: "page_context",
          url: location.href,
          title: document.title || "",
          conversationKey: conversationKeyFromHref(location.href),
          capturedAt: new Date().toISOString()
        }
      }, function () { void chrome.runtime.lastError; });
    } catch (e) { /* extension context invalidated */ }
  }

  emitPageContext();
  var lastHref = location.href;
  setInterval(function () {
    if (location.href !== lastHref) {
      lastHref = location.href;
      emitPageContext();
    }
  }, 1500);

  function voteControlFromEvent(ev) {
    var path = typeof ev.composedPath === "function" ? ev.composedPath() : [];
    if (!path.length) {
      var n = ev.target;
      while (n) { path.push(n); n = n.parentElement; }
    }
    return AE.dom && AE.dom.voteFromPath ? AE.dom.voteFromPath(path) : null;
  }

  function emitVote(found) {
    var now = Date.now();
    var key = found.choice + "|" + found.label;
    if (key === lastVoteClick.key && now - lastVoteClick.at < 750) return;
    lastVoteClick = { key: key, at: now };
    chrome.runtime.sendMessage({
      type: "AE_EVENT",
      evt: {
        kind: "battle_vote",
        choice: found.choice,
        label: found.label,
        source: "dom_click",
        url: location.href,
        capturedAt: new Date(now).toISOString()
      }
    }, function () { void chrome.runtime.lastError; });
  }

  /* Only real user input counts. AE.dom.expandCollapsed() fires synthetic
   * .click() on every disclosure control before each DOM snapshot, and those
   * bubble through this same listener — that is how a single export once
   * fabricated 17 "votes" in half a second. */
  function onVoteGesture(ev) {
    try {
      if (!ev.isTrusted) return;
      var found = voteControlFromEvent(ev);
      if (!found) return;
      emitVote(found);
    } catch (e) { /* never interfere with the host page */ }
  }

  document.addEventListener("click", onVoteGesture, true);
  document.addEventListener("pointerup", onVoteGesture, true);

  /* RPC from popup/background. */
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "AE_PING") {
      sendResponse({ ok: true, url: location.href });
      return;
    }

    if (msg.type === "AE_DOM_SNAPSHOT") {
      // Expand collapsed thinking/tool panels first, then scrape.
      AE.dom.expandCollapsed().then(function () {
        var snapshot;
        try {
          snapshot = AE.dom.extract();
          snapshot.battle = AE.dom.battleInfo();
        } catch (e) {
          snapshot = { source: "dom", url: location.href, messages: [], battle: null, error: String(e) };
        }
        sendResponse(snapshot);
      });
      return true; // async response
    }

    if (msg.type === "AE_FETCH_ATTACHMENTS") {
      // Fetch artifact bytes (workspace/preview-token URLs) same-origin and
      // return data URLs so the popup can save them beside the export JSON.
      var urls = (msg.urls || []).slice(0, 30);
      var results = [];
      var chain = Promise.resolve();
      urls.forEach(function (url, i) {
        chain = chain.then(function () {
          return AE.dom.fetchAttachment(url).then(function (r) { results[i] = r; });
        });
      });
      chain.then(function () { sendResponse({ ok: true, results: results }); });
      return true; // async response
    }

    if (msg.type === "AE_DOM_DEBUG") {
      // Selector recon dump: what the extractor found + raw container HTML.
      AE.dom.expandCollapsed().then(function () {
        var out;
        try {
          /* Redacted: this dump is meant to be shared for selector tuning, so
           * it carries DOM shape rather than the conversation itself. */
          out = { extraction: AE.dom.redact(AE.dom.extract()), debug: AE.dom.debugInfo() };
        } catch (e) {
          out = { error: String(e) };
        }
        sendResponse(out);
      });
      return true; // async response
    }
  });
})();

