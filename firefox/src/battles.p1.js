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

