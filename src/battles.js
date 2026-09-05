/* Battle reconstruction and vote handling. Operates on a session object. */

var BATTLE_VOTE_CAP = 40;

function normalizeBattleVoteChoice(value) {
  var t = String(value == null ? "" : value).replace(/\s+/g, " ").trim().toLowerCase();
  if (!t) return null;
  if (/\bneither\b|\bnone\s+(?:are|is)\s+good\b/.test(t)) return "neither_good";
  if (/\bboth\b.*\b(?:good|great|fine|acceptable|better)\b/.test(t) || /\bboth\s+are\s+good\b/.test(t)) return "both_good";
  if (/(?:^|\b)(?:model\s*)?a(?:\b|\s).*(?:\bbetter\b|\bwin(?:s|ner)?\b|\bprefer(?:red)?\b)/.test(t) ||
      /(?:^|\b)(?:choose|select|vote\s+for)\s+(?:model\s*)?a\b/.test(t)) return "A";
  if (/(?:^|\b)(?:model\s*)?b(?:\b|\s).*(?:\bbetter\b|\bwin(?:s|ner)?\b|\bprefer(?:red)?\b)/.test(t) ||
      /(?:^|\b)(?:choose|select|vote\s+for)\s+(?:model\s*)?b\b/.test(t)) return "B";
  if (/^(?:vote|choice|option|model)[ _-]*a(?:[_ -]?(?:better|winner|win))?$/.test(t)) return "A";
  if (/^(?:vote|choice|option|model)[ _-]*b(?:[_ -]?(?:better|winner|win))?$/.test(t)) return "B";
  if (/^a$/.test(t)) return "A";
  if (/^b$/.test(t)) return "B";
  if (/^both(?:[_ -]good)?$/.test(t)) return "both_good";
  if (/^(?:neither|none)(?:[_ -]good)?$/.test(t)) return "neither_good";
  return null;
}

function recordBattleVote(s, evt) {
  var raw = evt.choice || evt.vote || evt.label || evt.text || "";
  var choice = normalizeBattleVoteChoice(raw);
  if (!choice) return false;
  var entry = {
    choice: choice,
    label: String(evt.label || evt.text || raw || choice).replace(/\s+/g, " ").trim().slice(0, 160),
    source: evt.source || "dom_click",
    url: String(evt.url || "").slice(0, 300),
    captured_at: evt.capturedAt || new Date().toISOString()
  };
  var last = s.battleVotes[s.battleVotes.length - 1];
  if (last && last.choice === entry.choice && last.url === entry.url &&
      Math.abs(Date.parse(entry.captured_at) - Date.parse(last.captured_at)) < 1000) {
    s.battleVotes[s.battleVotes.length - 1] = entry;
  } else {
    s.battleVotes.push(entry);
  }
  if (s.battleVotes.length > BATTLE_VOTE_CAP) s.battleVotes.shift();
  return true;
}

function latestBattleVote(s, domSnapshot) {
  var votes = Array.isArray(s.battleVotes) ? s.battleVotes : [];
  var pageUrl = domSnapshot && domSnapshot.url ? String(domSnapshot.url) : "";
  if (pageUrl) {
    var pageKey = pageUrl.split("#")[0].split("?")[0];
    for (var i = votes.length - 1; i >= 0; i--) {
      var voteUrl = String(votes[i].url || "");
      if (voteUrl && voteUrl.split("#")[0].split("?")[0] === pageKey) return votes[i];
    }
    return null;
  }
  return votes.length ? votes[votes.length - 1] : null;
}

/* Every vote cast on this conversation, oldest first. One per round. */
function votesForConversation(s, domSnapshot) {
  var votes = Array.isArray(s.battleVotes) ? s.battleVotes : [];
  var pageUrl = domSnapshot && domSnapshot.url ? String(domSnapshot.url) : "";
  if (!pageUrl) return votes.slice();
  var pageKey = pageUrl.split("#")[0].split("?")[0];
  return votes.filter(function (v) {
    var u = String(v.url || "");
    return u && u.split("#")[0].split("?")[0] === pageKey;
  });
}

/* Confirmed experimentally: ask both lanes for a random number, vote A, then
 * ask what number was said -- lane B reports lane A's number. A decisive vote
 * makes the winner's reply the context BOTH lanes continue from next turn, so
 * the losing lane's next response is that model continuing another model's
 * text. A both_good / neither_good vote leaves each lane on its own thread.
 *
 * This matters for attribution: a "cross_lane" sample is not a clean example of
 * how its model writes unprompted. */
function laneContextSource(prevVote, lane) {
  if (!prevVote || !prevVote.choice) return "unknown";
  var c = prevVote.choice;
  if (c === "A" || c === "B") return c === lane ? "self" : "cross_lane";
  if (c === "both_good" || c === "neither_good") return "self";
  return "unknown";
}

function modelForLane(lane, domModels) {
  if (lane === "A" && domModels[0]) return domModels[0];
  if (lane === "B" && domModels[1]) return domModels[1];
  return null;
}

function normalizedVoteObject(vote) {
  if (!vote) return null;
  var choice = normalizeBattleVoteChoice(vote.choice || vote.vote_choice || vote.label || vote.text);
  if (!choice) return null;
  return {
    choice: choice,
    label: vote.label || choice,
    source: vote.source || "dom",
    url: vote.url || null,
    captured_at: vote.captured_at || null
  };
}

function winnerLane(winnerModel, domModels) {
  if (!winnerModel) return null;
  for (var i = 0; i < domModels.length; i++) {
    if (domModels[i] === winnerModel) return i === 0 ? "A" : i === 1 ? "B" : String(i);
  }
  return null;
}

function battleResult(vote, winnerModel, domModels, greenLanes, negativeLanes) {
  var v = normalizedVoteObject(vote);
  var choice = v ? v.choice : null;
  var winner = null;
  var winnerModels = [];
  var outcome = "pending";
  var source = v ? v.source : null;

  if (choice === "A" || choice === "B") {
    winner = choice;
    var selectedModel = modelForLane(choice, domModels);
    if (selectedModel) winnerModels = [selectedModel];
    outcome = choice === "A" ? "a_wins" : "b_wins";
  } else if (choice === "both_good") {
    winner = "both";
    winnerModels = domModels.slice(0, 2);
    outcome = "both_good";
  } else if (choice === "neither_good") {
    winner = "neither";
    outcome = "both_bad";
  } else if (Array.isArray(greenLanes) && greenLanes.length) {
    var lanes = greenLanes.filter(function (x, i, a) { return (x === "A" || x === "B") && a.indexOf(x) === i; });
    if (lanes.length >= 2) {
      winner = "both";
      winnerModels = lanes.map(function (lane) { return modelForLane(lane, domModels); }).filter(Boolean);
      outcome = "both_good";
      source = "dom_green";
    } else if (lanes.length === 1) {
      winner = lanes[0];
      var greenModel = modelForLane(lanes[0], domModels);
      if (greenModel) winnerModels = [greenModel];
      outcome = lanes[0] === "A" ? "a_wins" : "b_wins";
      source = "dom_green";
    }
  } else if (Array.isArray(negativeLanes) && negativeLanes.length >= 2) {
    winner = "neither";
    outcome = "both_bad";
    source = "dom_negative";
  } else if (winnerModel) {
    var inferredLane = winnerLane(winnerModel, domModels);
    if (inferredLane === "A" || inferredLane === "B") {
      winner = inferredLane;
      winnerModels = [winnerModel];
      outcome = inferredLane === "A" ? "a_wins" : "b_wins";
      source = "dom_green";
    }
  }

  return {
    vote: v,
    vote_choice: choice,
    outcome: outcome,
    winner: winner,
    winner_model: winnerModels.length === 1 ? winnerModels[0] : null,
    winner_models: winnerModels,
    winner_source: source
  };
}

function isMediaFile(f) {
  if (!f) return false;
  var ct = String(f.contentType || f.media_type || "").toLowerCase();
  if (/^image\//.test(ct) || /^video\//.test(ct)) return true;
  var p = String(f.path || f.downloadUrl || f.url || "");
  return /\.(png|jpe?g|webp|gif|avif|svg|mp4|webm|mov)(\?|$)/i.test(p);
}

function battleSubtype(parsed, contestants) {
  var hasCitations = contestants.some(function (c) { return c.sources && c.sources.length; });
  var hasCode = contestants.some(function (c) { return c.code; });
  var hasImage = contestants.some(function (c) {
    return (c.files || []).some(function (f) {
      return isMediaFile(f) && !/^video\//.test(String(f.contentType || "")) && !/\.(mp4|webm|mov)(\?|$)/i.test(String(f.path || f.downloadUrl || ""));
    });
  });
  var hasVideo = contestants.some(function (c) {
    return (c.files || []).some(function (f) {
      return /^video\//.test(String(f.contentType || "")) || /\.(mp4|webm|mov)(\?|$)/i.test(String(f.path || f.downloadUrl || ""));
    });
  });
  var mod = String((parsed && parsed.modality) || "").toLowerCase();
  if (mod === "webdev" || mod === "code") return "code";
  if (mod === "image" || hasImage) return "image";
  if (mod === "video" || hasVideo) return "video";
  if (hasCode) return "code";
  if (hasCitations) return "web-search";
  var codeish = contestants.some(function (c) {
    var t = c.response || "";
    return t.indexOf("```") !== -1 || /function\s*\(|=>\s*\{|<script|def\s+\w+\s*\(/.test(t);
  });
  if (codeish) return "code";
  return "text";
}

/* Every captured evaluation request, oldest first -- one per turn of the
 * conversation now that they are no longer deduped down to the last. */
function evalInitsFromRequests(s) {
  var reqs = s && Array.isArray(s.capturedRequests) ? s.capturedRequests : [];
  var out = [];
  for (var i = 0; i < reqs.length; i++) {
    var url = String(reqs[i].url || "");
    if (!/(create-evaluation|post-to-evaluation)/i.test(url)) continue;
    try {
      var body = typeof reqs[i].body === "string" ? JSON.parse(reqs[i].body) : reqs[i].body;
      if (body && typeof body === "object" && (body.mode === "battle" || body.userMessage || body.id)) {
        body = Object.assign({}, body);
        if (reqs[i].request_id) body.capture_request_id = reqs[i].request_id;
        out.push(body);
      }
    } catch (e) { /* ignore */ }
  }
  return out;
}

function namedModels(list) {
  var out = [];
  (list || []).forEach(function (n) {
    if (!n || (AE.isPlaceholderModel && AE.isPlaceholderModel(n))) return;
    out.push(n);
  });
  return out;
}

function buildBattles(s, domSnapshot) {
  var battles = [];
  var streams = s.evaluationStreams || {};
  var urls = Object.keys(streams);
  var battleDom = domSnapshot && domSnapshot.battle ? domSnapshot.battle : null;
  var rawDomModels = battleDom && Array.isArray(battleDom.models) ? battleDom.models.slice(0, 2) : [];
  var domModels = namedModels(rawDomModels);
  var capturedVote = latestBattleVote(s, domSnapshot);
  var rawDomVote = battleDom && (battleDom.vote || battleDom.selectedVote || battleDom.vote_choice) ?
    (battleDom.vote || battleDom.selectedVote || { choice: battleDom.vote_choice }) : null;
  /* Idle ballot buttons share “positive” chrome. Ignore DOM selection while the ballot is still interactive. */
  var domVote = rawDomVote;
  if (domVote && battleDom && battleDom.ballotVisible && !capturedVote) domVote = null;
  var greenLanes = battleDom && Array.isArray(battleDom.greenLanes) ? battleDom.greenLanes : [];
  var negativeLanes = battleDom && Array.isArray(battleDom.negativeLanes) ? battleDom.negativeLanes : [];
  var winnerModel = battleDom && battleDom.winnerModel ? battleDom.winnerModel : null;
  if (winnerModel && AE.isPlaceholderModel && AE.isPlaceholderModel(winnerModel)) winnerModel = null;
  /* Parse each stream once. These bodies run to megabytes and buildBattles is
   * called on every turn sync, so the old parse-in-both-loops cost real time. */
  var parsedByUrl = {};
  var reqInits = evalInitsFromRequests(s);
  var initsByRequest = {};
  reqInits.forEach(function (init) { if (init.capture_request_id) initsByRequest[init.capture_request_id] = init; });
  var initsAlign = reqInits.length > 0 && reqInits.length === urls.length;
  s.unparsedEvaluationStreams = {};
  urls.forEach(function (url, i) {
    var requestId = (s.evaluationRequests || {})[url];
    var init = requestId ? initsByRequest[requestId] : initsAlign ? reqInits[i] : i === urls.length - 1 ? reqInits[reqInits.length - 1] : null;
    var parsed = AE.parseCachedEvaluation(s, url, streams[url], init);
    parsedByUrl[url] = parsed;
    var attempt = requestId && (s.requestAttempts || []).find(function (a) { return a.request_id === requestId; });
    if (parsed.error && attempt && !(attempt.status >= 400)) {
      attempt.outcome = parsed.aborted ? "aborted" : "stream_error";
      attempt.error = AE.redactSecretText(parsed.error).slice(0, 600);
    }
    if (!Object.keys(parsed.lanes).length && streams[url]) s.unparsedEvaluationStreams[url] = streams[url];
  });

  var latestUrl = null;
  for (var ui = urls.length - 1; ui >= 0; ui--) {
    var latestParsed = parsedByUrl[urls[ui]];
    if (latestParsed.init || Object.keys(latestParsed.lanes).length) {
      latestUrl = urls[ui];
      break;
    }
  }

  /* Requests and streams are both in turn order, so when we have one request per
   * round they can be zipped. If the counts disagree we cannot know which round
   * a body belongs to, and only the newest round -- which the newest request
   * definitely describes -- gets one. Never guess: a wrong evaluation_id is
   * worse than a null one. */
  function initForRound(url, roundIndex) {
    var requestId = (s.evaluationRequests || {})[url];
    if (requestId) return initsByRequest[requestId] || null;
    var isLatest = url === latestUrl;
    return initsAlign ? reqInits[roundIndex]
      : (isLatest && reqInits.length ? reqInits[reqInits.length - 1] : null);
  }

  /* The evaluation id identifies the *conversation*, not the turn: every
   * post-to-evaluation in a multi-turn battle reuses it. Two streams carrying
   * different ids are different battles that merely shared a URL. */
  var latestEvalId = null;
  if (latestUrl) {
    var latestIdx = urls.indexOf(latestUrl);
    var latestParsedInit = (parsedByUrl[latestUrl] && parsedByUrl[latestUrl].init) || initForRound(latestUrl, latestIdx);
    latestEvalId = (latestParsedInit && latestParsedInit.id) || null;
  }

  /* Votes are cast one per round, in order, so they zip onto rounds the same
   * way inits do -- and only when the counts agree. */
  var conversationVotes = votesForConversation(s, domSnapshot);
  var votesAlign = conversationVotes.length > 0 && conversationVotes.length === urls.length;

  urls.forEach(function (url, roundIndex) {
    var isLatest = url === latestUrl;
    var voteForThisBattle = votesAlign ? conversationVotes[roundIndex]
      : (isLatest ? (capturedVote || domVote) : null);
    var prevVote = (votesAlign && roundIndex > 0) ? conversationVotes[roundIndex - 1] : null;
    var winnerModelForBattle = isLatest ? winnerModel : null;
    var greenLanesForBattle = isLatest ? greenLanes : [];
    var negativeLanesForBattle = isLatest ? negativeLanes : [];
    var parsed = parsedByUrl[url];
    var roundInit = initForRound(url, roundIndex);
    var requestId = (s.evaluationRequests || {})[url] || (roundInit && roundInit.capture_request_id);
    var attempt = requestId && (s.requestAttempts || []).find(function (a) { return a.request_id === requestId; });
    if (attempt && (attempt.status >= 400 || /^(selection_rejected|captcha_rejected|http_error|network_error)$/.test(attempt.outcome))) return;
    if (parsed.error && !Object.keys(parsed.lanes).some(function (lane) {
      var output = parsed.lanes[lane];
      return output.text || output.reasoning || (output.files && output.files.length) || (output.tools && output.tools.length);
    })) return;
    // Error-only JSON and empty responses are not an assistant turn. Request
    // metadata may supply the init, but never supplies evidence of an output.
    if (!parsed.init && !Object.keys(parsed.lanes).length) return;
    if (roundInit && AE.applyBattleInit) AE.applyBattleInit(parsed, roundInit);
    if (!parsed.init && !Object.keys(parsed.lanes).length) return;
    var init = parsed.init || {};
    var mode = init.mode || "battle";
    var direct = mode === "direct" || mode === "direct-battle";
    var selected = direct || mode === "side-by-side";

    /* Arena keeps one model pair for a whole conversation and only names them
     * after a vote, so the reveal labels every earlier turn too -- otherwise a
     * four-turn battle yields two labeled samples instead of eight. Only
     * propagate within the same evaluation id; provenance is recorded so
     * propagated labels stay auditable and filterable. */
    var sameConversation = isLatest || !!(latestEvalId && init.id && init.id === latestEvalId);
    var modelsForBattle = sameConversation ? namedModels(domModels) : [];
    var modelSource = isLatest ? "arena_reveal" : "arena_reveal_propagated";
    var anonymous = modelsForBattle.length < (direct ? 1 : 2);
    var lanes = direct ? ["a"] : ["a", "b"];
    var contestants = lanes.map(function (lane, i) {
      var L = parsed.lanes[lane] || { text: "", finished: false, finishReason: null, citations: [], files: [] };
      var domLane = isLatest && battleDom && Array.isArray(battleDom.lanes) ? battleDom.lanes[i] : null;
      var domResponse = isLatest && battleDom && Array.isArray(battleDom.responses) ? battleDom.responses[i] : null;
      var response = L.text || (domLane && domLane.response) || domResponse || "";
      var tools = Array.isArray(L.toolNames) ? L.toolNames.slice() : [];
      if (domLane && Array.isArray(domLane.tools)) domLane.tools.forEach(function (name) {
        if (tools.indexOf(name) === -1) tools.push(name);
      });
      var toolCalls = Array.isArray(L.tools) && L.tools.length ? L.tools :
        (domLane && Array.isArray(domLane.tool_calls) ? domLane.tool_calls : []);
      var files = Array.isArray(L.files) ? L.files.slice() : [];
      if (domLane && Array.isArray(domLane.files)) {
        var seenF = {};
        files.forEach(function (f) { var k = (f && (f.downloadUrl || f.url || f.path)) || ""; if (k) seenF[k] = true; });
        domLane.files.forEach(function (f) {
          if (!f) return;
          var k = f.downloadUrl || f.url || f.path;
          if (k && seenF[k]) return;
          if (k) seenF[k] = true;
          files.push(f);
        });
      }
      var model = modelsForBattle[i] || null;
      if (model && AE.isPlaceholderModel && AE.isPlaceholderModel(model)) model = null;
      var requestedId = lane === "a" ? init.modelAId : init.modelBId;
      var catalog = selected ? AE.catalogModel(s.modelCatalog, requestedId) : null;
      var catalogLabel = catalog && AE.catalogModelLabel(catalog);
      var hasOutput = !!(response || L.reasoning || files.length || tools.length || toolCalls.length);
      var label = selected && hasOutput && catalogLabel ? catalogLabel : (!anonymous && model ? model : null);
      var labelSource = label ? (selected ? catalogLabel ? "request_catalog" : "page_selection" : modelSource) : "unknown";
      return {
        lane: lane.toUpperCase(),
        model: label,
        model_source: labelSource,
        requested_model_id: requestedId || null,
        catalog_model_id: catalog ? catalog.id : null,
        public_name: catalog ? catalog.publicName || null : null,
        display_name: catalog ? catalog.displayName || null : null,
        catalog_name: catalog ? catalog.name || null : null,
        catalog_user_selectable: catalog && typeof catalog.userSelectable === "boolean" ? catalog.userSelectable : null,
        catalog_entry: catalog,
        model_identity_verified: labelSource === "arena_reveal" || labelSource === "arena_reveal_propagated",
        context_source: roundIndex === 0 ? "first_turn" : selected ? "same_lane" : laneContextSource(prevVote, lane.toUpperCase()),
        message_id: lane === "a" ? (init.modelAMessageId || null) : (init.modelBMessageId || null),
        response: response,
        reasoning: L.reasoning || null,
        metadata: L.metadata || null,
        finished: !!L.finished || !!(domLane && domLane.finished),
        finish_reason: L.finishReason,
        sources: L.citations || [],
        tools: tools,
        tool_calls: toolCalls,
        files: files,
        code: !!L.code || !!(domLane && domLane.code)
      };
    });
    anonymous = contestants.some(function (c) { return !c.model; });
    var result = battleResult(selected ? null : voteForThisBattle, selected ? null : winnerModelForBattle, modelsForBattle, selected ? [] : greenLanesForBattle, selected ? [] : negativeLanesForBattle);
    battles.push({
      evaluation_id: init.id || null,
      mode: mode,
      request_id: requestId || null,
      http_status: attempt ? attempt.status || null : null,
      stream_error: parsed.error || null,
      requested_model_a_id: init.modelAId || null,
      requested_model_b_id: init.modelBId || null,
      subtype: battleSubtype({ modality: parsed.modality || (battleDom && battleDom.modality) }, contestants),
      prompt: parsed.prompt || null,
      anonymous: anonymous,
      workspace_files: parsed.workspaceFiles || [],
      contestants: contestants,
      vote: result.vote,
      vote_choice: result.vote_choice,
      outcome: selected ? "not_applicable" : result.outcome,
      winner: result.winner,
      winner_model: result.winner_model,
      winner_models: result.winner_models,
      winner_source: result.winner_source
    });
  });

  var domLanes = battleDom && Array.isArray(battleDom.lanes) ? battleDom.lanes : [];
  var domResponses = battleDom && Array.isArray(battleDom.responses) ? battleDom.responses : [];
  var domMode = observedMode(s, domSnapshot) || "battle";
  var domDirect = /^(direct|direct-battle)$/.test(domMode);
  var domSelected = domDirect || domMode === "side-by-side";
  var laneCount = domDirect ? 1 : 2;
  var lastAttempt = latestRequestOutcome(s);
  var failedAttempt = lastAttempt && /^(?:.*_error|selection_rejected|captcha_rejected|aborted)$/.test(lastAttempt.outcome);
  var hasDomLaneOutput = domLanes.length >= laneCount && domLanes.some(function (lane) {
    return lane && (lane.response || lane.code || (lane.tools && lane.tools.length) || (lane.files && lane.files.length));
  });
  var hasDomResponses = domResponses.length >= laneCount && domResponses.some(function (text) { return !!text; });
  if (!battles.length && battleDom &&
      ((!domSelected && !failedAttempt && namedModels(rawDomModels).length >= 2) || hasDomLaneOutput || hasDomResponses)) {
    var named = namedModels(rawDomModels);
    var domAnonymous = named.length < laneCount;
    var domResult = battleResult(domSelected ? null : capturedVote || domVote, domSelected ? null : winnerModel, named, domSelected ? [] : greenLanes, domSelected ? [] : negativeLanes);
    var domContestants = (domDirect ? ["A"] : ["A", "B"]).map(function (lane, i) {
      var domLane = Array.isArray(battleDom.lanes) ? battleDom.lanes[i] : null;
      domLane = domLane || {};
      return {
        lane: lane,
        model: domAnonymous ? null : (named[i] || null),
        model_source: domAnonymous ? "unknown" : domSelected ? "page_selection" : "arena_reveal",
        model_identity_verified: !domAnonymous && !domSelected,
        message_id: null,
        response: domLane.response || (battleDom.responses && battleDom.responses[i]) || "",
        finished: typeof domLane.finished === "boolean" ? domLane.finished : null,
        finish_reason: domLane.finish_reason || null,
        sources: Array.isArray(domLane.sources) ? domLane.sources : [],
        tools: Array.isArray(domLane.tools) ? domLane.tools : [],
        tool_calls: Array.isArray(domLane.tool_calls) ? domLane.tool_calls : [],
        files: Array.isArray(domLane.files) ? domLane.files : [],
        code: !!domLane.code
      };
    });
    battles.push({
      evaluation_id: null,
      mode: domMode,
      subtype: battleSubtype({ modality: battleDom.modality }, domContestants),
      prompt: battleDom.prompt || null,
      anonymous: domAnonymous,
      dom_only: true,
      workspace_files: Array.isArray(battleDom.workspace_files) ? battleDom.workspace_files : [],
      contestants: domContestants,
      vote: domResult.vote,
      vote_choice: domResult.vote_choice,
      outcome: domSelected ? "not_applicable" : domResult.outcome,
      winner: domResult.winner,
      winner_model: domResult.winner_model,
      winner_models: domResult.winner_models,
      winner_source: domResult.winner_source
    });
  }
  return battles;
}
