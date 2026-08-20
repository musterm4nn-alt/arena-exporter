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

function battleSubtype(parsed, contestants) {
  var hasCitations = contestants.some(function (c) { return c.sources && c.sources.length; });
  var hasCode = contestants.some(function (c) { return c.code; });
  var mod = String((parsed && parsed.modality) || "").toLowerCase();
  if (mod === "webdev" || mod === "code") return "code";
  if (hasCode) return "code";
  if (hasCitations) return "web-search";
  if (mod === "image") return "image";
  if (mod === "video") return "video";
  var codeish = contestants.some(function (c) {
    var t = c.response || "";
    return t.indexOf("```") !== -1 || /function\s*\(|=>\s*\{|<script|def\s+\w+\s*\(/.test(t);
  });
  if (codeish) return "code";
  return "text";
}

function evalInitFromRequests(s) {
  var reqs = s && Array.isArray(s.capturedRequests) ? s.capturedRequests : [];
  for (var i = reqs.length - 1; i >= 0; i--) {
    var url = String(reqs[i].url || "");
    if (!/(create-evaluation|post-to-evaluation)/i.test(url)) continue;
    try {
      var body = typeof reqs[i].body === "string" ? JSON.parse(reqs[i].body) : reqs[i].body;
      if (body && typeof body === "object" && (body.mode === "battle" || body.userMessage || body.id)) return body;
    } catch (e) { /* ignore */ }
  }
  return null;
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
  urls.forEach(function (url) { parsedByUrl[url] = AE.parseBattleStream(streams[url]); });

  var latestUrl = null;
  for (var ui = urls.length - 1; ui >= 0; ui--) {
    var latestParsed = parsedByUrl[urls[ui]];
    if (latestParsed.init || Object.keys(latestParsed.lanes).length) {
      latestUrl = urls[ui];
      break;
    }
  }

  /* recordRequest keeps only the newest body per URL, so a request-derived init
   * describes the newest round and nothing else. Applying it to every stream
   * made earlier rounds inherit this round's evaluation_id and message ids;
   * rounds that never carried their own init record must stay null instead. */
  var reqInit = evalInitFromRequests(s);

  urls.forEach(function (url) {
    var isLatest = url === latestUrl;
    var modelsForBattle = isLatest ? namedModels(domModels) : [];
    var anonymous = modelsForBattle.length < 2;
    var voteForThisBattle = isLatest ? (capturedVote || domVote) : null;
    var winnerModelForBattle = isLatest ? winnerModel : null;
    var greenLanesForBattle = isLatest ? greenLanes : [];
    var negativeLanesForBattle = isLatest ? negativeLanes : [];
    var parsed = parsedByUrl[url];
    if (isLatest && reqInit && AE.applyBattleInit) AE.applyBattleInit(parsed, reqInit);
    if (!parsed.init && !Object.keys(parsed.lanes).length) return;
    var init = parsed.init || {};
    var lanes = ["a", "b"];
    var contestants = lanes.map(function (lane, i) {
      var L = parsed.lanes[lane] || { text: "", finished: false, finishReason: null, citations: [], files: [] };
      var model = modelsForBattle[i] || null;
      if (model && AE.isPlaceholderModel && AE.isPlaceholderModel(model)) model = null;
      return {
        lane: lane.toUpperCase(),
        model: !anonymous && model ? model : null,
        message_id: lane === "a" ? (init.modelAMessageId || null) : (init.modelBMessageId || null),
        response: L.text,
        finished: !!L.finished,
        finish_reason: L.finishReason,
        sources: L.citations || [],
        tools: L.toolNames || [],
        tool_calls: L.tools || [],
        files: L.files || [],
        code: !!L.code
      };
    });
    var result = battleResult(voteForThisBattle, winnerModelForBattle, modelsForBattle, greenLanesForBattle, negativeLanesForBattle);
    battles.push({
      evaluation_id: init.id || null,
      mode: init.mode || "battle",
      subtype: battleSubtype(parsed, contestants),
      prompt: parsed.prompt || null,
      anonymous: anonymous,
      workspace_files: parsed.workspaceFiles || [],
      contestants: contestants,
      vote: result.vote,
      vote_choice: result.vote_choice,
      outcome: result.outcome,
      winner: result.winner,
      winner_model: result.winner_model,
      winner_models: result.winner_models,
      winner_source: result.winner_source
    });
  });

  if (!battles.length && battleDom && namedModels(rawDomModels).length >= 2) {
    var named = namedModels(rawDomModels);
    var domResult = battleResult(capturedVote || domVote, winnerModel, named, greenLanes, negativeLanes);
    battles.push({
      evaluation_id: null,
      mode: "battle",
      subtype: "text",
      prompt: null,
      anonymous: false,
      dom_only: true,
      workspace_files: [],
      contestants: [
        { lane: "A", model: named[0] || null, message_id: null,
          response: (battleDom.responses && battleDom.responses[0]) || "", finished: null,
          finish_reason: null, sources: [], tools: [], tool_calls: [], files: [], code: false },
        { lane: "B", model: named[1] || null, message_id: null,
          response: (battleDom.responses && battleDom.responses[1]) || "", finished: null,
          finish_reason: null, sources: [], tools: [], tool_calls: [], files: [], code: false }
      ],
      vote: domResult.vote,
      vote_choice: domResult.vote_choice,
      outcome: domResult.outcome,
      winner: domResult.winner,
      winner_model: domResult.winner_model,
      winner_models: domResult.winner_models,
      winner_source: domResult.winner_source
    });
  }
  return battles;
}
