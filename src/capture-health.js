/* Capture-health canary. Pure functions — no browser, no I/O.
 *
 * Arena stream/API drift can silently rot capture: the page shows a finished
 * battle or Agent thread, but the interceptor never saw the evaluation or
 * realtime streams. DOM-only reconstruction already happens in battles.js;
 * this module turns that case into a loud warning instead of a quiet 0. */

var AE = AE || {};

AE.CAPTURE_HEALTH_PREFIX = "Capture health:";

AE.CAPTURE_HEALTH_MSG = {
  BATTLE_NO_EVAL:
    "Capture health: page has two replies but no evaluation stream. Reloading the tab before the next battle may be required.",
  AGENT_NO_STREAM:
    "Capture health: page has Agent replies but no realtime/chat stream. Reloading the tab before the next turn may be required."
};

AE.evalStreamIsUsable = function (body) {
  var t = String(body || "");
  if (t.length < 8) return false;
  return /"mode"\s*:\s*"battle"|create-evaluation|post-to-evaluation|[ab][0-9a-e]:/.test(t);
};

AE.isCaptureHealthWarning = function (text) {
  return String(text || "").indexOf(AE.CAPTURE_HEALTH_PREFIX) === 0;
};

AE.urlOnlyFilesWarning = function (files) {
  files = files || [];
  if (!files.length) return null;
  var names = files.map(function (f) {
    if (!f) return "file";
    if (typeof f === "string") return f;
    return f.path || f.archive_path || f.title || f.url || "file";
  }).filter(Boolean);
  var shown = names.slice(0, 8);
  var extra = names.length > shown.length ? " +" + (names.length - shown.length) + " more" : "";
  return AE.CAPTURE_HEALTH_PREFIX + " " + files.length + " files stored as URL only (no bytes): " +
    shown.join(", ") + extra;
};

function nonEmptyText(v) {
  return typeof v === "string" && v.replace(/\s+/g, " ").trim().length > 0;
}

function battleReplyCount(dom) {
  var battle = dom && (dom.battle || (dom.responses || dom.lanes ? dom : null));
  if (!battle) return 0;
  var n = 0;
  (battle.responses || []).forEach(function (t) { if (nonEmptyText(t)) n++; });
  var laneN = 0;
  (battle.lanes || []).forEach(function (lane) {
    if (!lane) return;
    if (nonEmptyText(lane.response) || lane.code ||
        (Array.isArray(lane.files) && lane.files.length) ||
        (Array.isArray(lane.tools) && lane.tools.length)) {
      laneN++;
    }
  });
  return Math.max(n, laneN);
}

function assistantContentCount(dom) {
  var msgs = (dom && dom.messages) || [];
  var n = 0;
  msgs.forEach(function (m) {
    if (!m || m.role !== "assistant") return;
    var blocks = m.content || [];
    var has = blocks.some(function (b) {
      if (!b) return false;
      if (nonEmptyText(b.text)) return true;
      if (b.type === "artifact" || b.type === "tool_call" || b.type === "tool_result") return true;
      return false;
    });
    if (has || nonEmptyText(m.text)) n++;
  });
  return n;
}

function looksLikeTermsOrEmptyHome(dom) {
  if (!dom) return true;
  if (dom.termsDialog || dom.emptyComposer) return true;
  var battleN = battleReplyCount(dom);
  var asst = assistantContentCount(dom);
  var msgs = (dom.messages || []).length;
  if (!battleN && !asst && msgs < 2) return true;
  return false;
}

function countMatching(urls, re) {
  var n = 0;
  (urls || []).forEach(function (e) {
    var u = typeof e === "string" ? e : (e && e.url) || "";
    if (re.test(u)) n++;
  });
  return n;
}

function evalCaptureCount(ic) {
  ic = ic || {};
  var n = ic.evaluationStreamCount || 0;
  if (ic.hasUsableEvalBody) n = Math.max(n, 1);
  n = Math.max(n, ic.evaluationRequestCount || 0);
  n = Math.max(n, countMatching(ic.endpoints, /(create-evaluation|post-to-evaluation)/i));
  return n;
}

function agentStreamCount(ic) {
  ic = ic || {};
  var realtime = ic.agentRealtimeOutCount || 0;
  var chat = ic.agentChatCount || 0;
  realtime = Math.max(realtime, countMatching(ic.endpoints, /\/realtime\/v[0-9]+\/sessions\/[^/]+\/out/i));
  chat = Math.max(chat, countMatching(ic.endpoints, /\/api\/chat\//i));
  return { realtime: realtime, chat: chat, total: realtime + chat };
}

function isAgentContext(input, battleN) {
  if (battleN >= 2) return false;
  var url = String((input.dom && input.dom.url) || (input.interceptor && input.interceptor.url) || "");
  if (/\/agent\b/i.test(url)) return true;
  if ((input.mode || "") === "agent") return true;
  return assistantContentCount(input.dom) > 0;
}

/**
 * @param {{
 *   interceptor?: {
 *     evaluationStreamCount?: number,
 *     evaluationRequestCount?: number,
 *     hasUsableEvalBody?: boolean,
 *     agentRealtimeOutCount?: number,
 *     agentChatCount?: number,
 *     endpoints?: Array<string|{url:string}>,
 *     streaming?: boolean,
 *     url?: string
 *   },
 *   dom?: object,
 *   mode?: string,
 *   urlOnlyFiles?: Array
 * }} input
 * @returns {{ warnings: string[], critical: boolean }}
 */
AE.captureHealth = function (input) {
  input = input || {};
  var ic = input.interceptor || {};
  var dom = input.dom || {};
  var warnings = [];
  var critical = false;

  var urlOnly = input.urlOnlyFiles || [];
  if (urlOnly.length) {
    var fileWarn = AE.urlOnlyFilesWarning(urlOnly);
    if (fileWarn) warnings.push(fileWarn);
  }

  if (looksLikeTermsOrEmptyHome(dom)) {
    return { warnings: warnings, critical: false };
  }

  /* Live interceptor: streams are flowing right now — don't scream mid-turn. */
  if (ic.streaming && (ic.endpoints && ic.endpoints.length > 0 ||
      (ic.evaluationStreamCount || 0) > 0 ||
      (ic.agentRealtimeOutCount || 0) > 0 ||
      (ic.agentChatCount || 0) > 0)) {
    return { warnings: warnings, critical: false };
  }

  var battleN = battleReplyCount(dom);
  if (battleN >= 2 && evalCaptureCount(ic) === 0) {
    warnings.unshift(AE.CAPTURE_HEALTH_MSG.BATTLE_NO_EVAL);
    critical = true;
  } else if (isAgentContext(input, battleN) && assistantContentCount(dom) > 0) {
    var ag = agentStreamCount(ic);
    if (ag.realtime === 0 && ag.chat === 0) {
      warnings.unshift(AE.CAPTURE_HEALTH_MSG.AGENT_NO_STREAM);
      critical = true;
    }
  }

  return { warnings: warnings, critical: critical };
};

/**
 * Build captureHealth() input from a session object + DOM snapshot.
 * Session shape matches session-store.js (evaluationStreams, endpoints, …).
 */
AE.healthInputFromSession = function (s, snapshot, extra) {
  s = s || {};
  snapshot = snapshot || {};
  extra = extra || {};
  var streams = s.evaluationStreams || {};
  var usableEval = 0;
  Object.keys(streams).forEach(function (k) {
    if (AE.evalStreamIsUsable(streams[k])) usableEval++;
  });
  var evalReq = 0;
  (s.capturedRequests || []).forEach(function (r) {
    if (/(create-evaluation|post-to-evaluation)/i.test((r && r.url) || "")) evalReq++;
  });
  var realtime = 0, chat = 0;
  (s.endpoints || []).forEach(function (e) {
    var u = (e && e.url) || "";
    if (/\/realtime\/v[0-9]+\/sessions\/[^/]+\/out/i.test(u)) realtime++;
    if (/\/api\/chat\//i.test(u)) chat++;
  });
  var urlOnly = extra.urlOnlyFiles;
  if (!urlOnly && extra.payload && AE.listUrlOnlyFiles) {
    urlOnly = AE.listUrlOnlyFiles(extra.payload);
  }
  return {
    interceptor: {
      evaluationStreamCount: usableEval,
      evaluationRequestCount: evalReq,
      hasUsableEvalBody: usableEval > 0,
      agentRealtimeOutCount: realtime,
      agentChatCount: chat,
      endpoints: s.endpoints || [],
      streaming: extra.streaming != null ? !!extra.streaming : false,
      url: (s.session && s.session.url) || snapshot.url || ""
    },
    dom: snapshot,
    mode: extra.mode || null,
    urlOnlyFiles: urlOnly || []
  };
};

/** Health warnings first; drop previous capture-health lines so a recovered capture goes quiet. */
AE.mergeHealthWarnings = function (existing, health) {
  var kept = (existing || []).filter(function (w) { return !AE.isCaptureHealthWarning(w); });
  var fresh = (health && health.warnings) || [];
  var out = fresh.slice();
  kept.forEach(function (w) {
    if (out.indexOf(w) === -1) out.push(w);
  });
  return out;
};


function nonemptyText(v) {
  return typeof v === "string" && v.replace(/\s+/g, " ").trim().length > 0;
}

AE.scoreCompleteness = function (payload) {
  payload = payload || {};
  if (AE.applyHonestSubtype) AE.applyHonestSubtype(payload);
  var battles = payload.battles || [];
  var messages = payload.messages || [];
  var reasons = [];
  var subtype = (AE.firstBattleSubtype && AE.firstBattleSubtype(payload)) || (battles.length ? "text" : "agent");

  var prompt = false;
  battles.forEach(function (b) { if (b && nonemptyText(b.prompt)) prompt = true; });
  messages.forEach(function (m) {
    if (!m || m.role !== "user") return;
    if (nonemptyText(m.text)) prompt = true;
    (m.content || []).forEach(function (b) {
      if (b && nonemptyText(b.text)) prompt = true;
    });
  });

  var expected = 0, withBytes = 0, urlOnly = 0;
  if (AE.walkArchiveFiles) {
    AE.walkArchiveFiles(payload, function (f) {
      expected += 1;
      if (AE.fileHasBytes && AE.fileHasBytes(f)) withBytes += 1;
      else if (AE.fileUrlOf && AE.fileUrlOf(f)) urlOnly += 1;
    });
  }

  var thinking = false;
  messages.forEach(function (m) {
    (m.content || []).forEach(function (b) {
      if (b && b.type === "thinking" && nonemptyText(b.text)) thinking = true;
    });
  });

  var modelsNamed = false;
  if (battles.length) {
    battles.forEach(function (b) {
      (b.contestants || []).forEach(function (c) {
        if (c && c.model && !(AE.isPlaceholderModel && AE.isPlaceholderModel(c.model))) modelsNamed = true;
      });
    });
  } else {
    messages.forEach(function (m) {
      if (m && m.role === "assistant" && m.model && !(AE.isPlaceholderModel && AE.isPlaceholderModel(m.model))) {
        modelsNamed = true;
      }
    });
  }

  var media = subtype === "image" || subtype === "video";
  var prose = false;
  battles.forEach(function (b) {
    (b.contestants || []).forEach(function (c) {
      if (c && nonemptyText(c.response) && !/^\[image\]/i.test(c.response.trim())) prose = true;
    });
  });
  var emptyShell = media && withBytes === 0 && !prose;

  if (!prompt) reasons.push("no prompt");
  if (media && withBytes === 0) reasons.push(subtype + " / 0 bytes");
  else if (expected > 0 && withBytes === 0) reasons.push("files url-only");
  if (urlOnly) reasons.push(urlOnly + " url-only file(s)");
  if (battles.length && !modelsNamed) reasons.push("models unnamed");

  var status = "green";
  if (emptyShell || !prompt || (media && withBytes === 0)) status = "red";
  else if ((expected > 0 && withBytes === 0) || urlOnly || (battles.length && !modelsNamed)) status = "amber";

  var warnings = (payload.meta && payload.meta.warnings) || [];
  if (status === "green" && warnings.some(function (w) { return AE.isCaptureHealthWarning && AE.isCaptureHealthWarning(w); })) {
    status = "amber";
    reasons.push("capture health");
  }

  return {
    status: status,
    prompt: prompt,
    thinking: thinking,
    files: { expected: expected, withBytes: withBytes, urlOnly: urlOnly },
    modelsNamed: modelsNamed,
    subtype: subtype,
    emptyShell: emptyShell,
    reasons: reasons
  };
};

AE.shouldSkipEmptyArchive = function (payload) {
  var score = AE.scoreCompleteness(payload);
  if (!(payload.battles || []).length && !(payload.messages || []).length) return true;
  if (score.emptyShell && !score.prompt && score.files.expected === 0) return true;
  return false;
};

AE.applyCompletenessMeta = function (payload, extraWarnings) {
  payload = payload || {};
  if (!payload.meta) payload.meta = {};
  var score = AE.scoreCompleteness(payload);
  payload.meta.completeness = score.status === "green" ? "full" : "partial";
  payload.meta.completeness_detail = score;
  var extra = extraWarnings || [];
  var reasons = (score.reasons || []).map(function (r) { return "Completeness: " + r; });
  var merged = (payload.meta.warnings || []).slice();
  extra.concat(reasons).forEach(function (w) {
    if (w && merged.indexOf(w) === -1) merged.push(w);
  });
  payload.meta.warnings = merged;
  return score;
};
