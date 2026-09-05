/* Session summaries and validated popup request routing. */
function getStateSummary(s, snapshot) {
  s = s || ensureState();
  flushStreamMessage(s);
  var counts = {};
  var viewMessages=s.messages.length?s.messages:(snapshot && snapshot.messages || []);
  viewMessages.forEach(function (m) {
    if (!m) return;
    (m.content || []).forEach(function (b) {
      if (b && b.type) counts[b.type] = (counts[b.type] || 0) + 1;
    });
  });
  var rounds=buildBattles(s, snapshot), latestRound=rounds[rounds.length-1];
  if(!viewMessages.length)rounds.forEach(function(round){(round.contestants||[]).forEach(function(c){
    counts.thinking=(counts.thinking||0)+(c.reasoning?1:0);
    counts.tool_call=(counts.tool_call||0)+(c.tool_calls||[]).length;
    counts.artifact=(counts.artifact||0)+(c.files||[]).length;
  });});
  return {
    sessionId: s.session.session_id,
    conversationKey: s.session.conversation_key || null,
    startedAt: s.session.started_at,
    url: s.session.url,
    title: s.session.title || "",
    mode: latestRound && latestRound.mode || observedMode(s, snapshot) || "agent",
    messageCount: viewMessages.length || rounds.reduce(function(n,b){return n+(b.prompt?1:0)+(b.contestants||[]).filter(function(c){return c.response||c.reasoning||(c.files||[]).length;}).length;},0),
    blockCounts: counts,
    endpointCount: s.endpoints.length,
    endpoints: s.endpoints.slice(0, 50).map(function (e) { return { url: e.url, tier: e.tier }; }),
    warningCount: s.warnings.length,
    warnings: s.warnings.slice(),
    captureHealthCritical: (s.warnings || []).some(function (w) {
      return AE.isCaptureHealthWarning && AE.isCaptureHealthWarning(w) &&
        (w === AE.CAPTURE_HEALTH_MSG.BATTLE_NO_EVAL || w === AE.CAPTURE_HEALTH_MSG.AGENT_NO_STREAM);
    }),
    events: s.stats.events,
    unknownEvents: s.stats.unknown,
    streamChunkCount: s.stats.streamChunks || 0,
    battleVoteCount: Array.isArray(s.battleVotes) ? s.battleVotes.length : 0,
    lastBattleVote: Array.isArray(s.battleVotes) && s.battleVotes.length ? s.battleVotes[s.battleVotes.length - 1] : null,
    streaming: sessionIsStreaming(s),
    lastSync: s.lastSync || null,
    archiveRel: s.archiveRel || null,
    nativeSink: typeof AE.nativeLastStatus === "function" ? AE.nativeLastStatus() : null,
    requestOutcome: latestRequestOutcome(s)
  };
}

function isArenaSender(sender) {
  var url = (sender && sender.tab && sender.tab.url) || "";
  return /^https:\/\/([^/]+\.)?(arena\.ai|lmarena\.ai)\//i.test(url);
}

/* Popup actions are about the popup's active tab, never whichever capture
 * session happened to receive the latest event. Full History used to combine
 * the active page's DOM with a different tab's network session, producing a
 * valid-looking export with the wrong URL and conversation id. */
function activateRequestSession(msg) {
  msg = msg || {};
  var explicitKey = typeof msg.sessionKey === "string" ? canonicalSessionKey(msg.sessionKey) : null;
  var snapshotKey = msg.snapshot && msg.snapshot.url ? canonicalSessionKey(conversationKeyFromUrl(msg.snapshot.url)) : null;
  if (explicitKey && snapshotKey && explicitKey !== snapshotKey) {
    return { error: "active tab and DOM snapshot refer to different conversations" };
  }
  /* Only an explicit popup/tab key may switch sessions. A snapshot URL is a
   * consistency check, not authority to redirect an older internal caller. */
  var key = explicitKey || (msg.tabId != null ? canonicalSessionKey(store.tabKeys[msg.tabId]) || snapshotKey || "tab:" + msg.tabId : null);
  var s;
  if (key) {
    if (!store.sessions[key]) store.sessions[key] = freshState(key);
    store.activeKey = key;
    s = store.sessions[key];
    s.session.conversation_key = key;
    if (msg.tabId != null) {
      store.tabKeys[msg.tabId] = key;
      store.tabKeys[String(msg.tabId)] = key;
    }
  } else {
    s = ensureState();
  }
  if (msg.snapshot && msg.snapshot.url) s.session.url = msg.snapshot.url;
  if (msg.snapshot && msg.snapshot.title) s.session.title = msg.snapshot.title;
  if (msg.snapshot && msg.snapshot.pageData) recordPageData(s, msg.snapshot.pageData, msg.snapshot.url);
  return { key: key, session: s, error: null };
}
