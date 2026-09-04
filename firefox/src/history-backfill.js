/* One-click backfill of the signed-in user's Arena history.
 *
 * Runs in the isolated content script (same-origin cookies) to list and
 * fetch conversations, then the background converts each record to schema
 * 2.0 and writes it through the native/downloads archive sink.
 *
 * Endpoints (session-authenticated, unofficial):
 *   GET /api/history/unified?limit=&includeArchived=&cursor=
 *   GET /api/history/list?...          (fallback)
 *   GET /api/evaluation/{uuid}
 *   GET /agent/{uuid}                  (HTML / Next flight for agentic)
 */
var AE = AE || {};

(function () {
  "use strict";

  var UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  var PAGE_SIZE = 20;
  var PAGE_GUARD = 200;
  var ITEM_GAP_MS = 180;

  AE.historyUuid = function (text) {
    var m = UUID_RE.exec(String(text || ""));
    return m ? m[1].toLowerCase() : null;
  };

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function asText(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (Array.isArray(v)) {
      return v.map(function (p) {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") {
          if (typeof p.text === "string") return p.text;
          if (p.type === "image_url") return "[image] " + ((p.image_url && p.image_url.url) || "");
        }
        try { return JSON.stringify(p); } catch (e) { return String(p); }
      }).join("\n");
    }
    if (typeof v === "object") {
      if (typeof v.text === "string") return v.text;
      if (Array.isArray(v.parts)) return asText(v.parts);
      try { return JSON.stringify(v); } catch (e) { return String(v); }
    }
    return String(v);
  }

  AE.historyNormalizeContent = asText;

  async function fetchJson(url) {
    var res = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json, text/plain, */*" }
    });
    if (!res.ok) {
      var body = "";
      try { body = (await res.text()).slice(0, 240); } catch (e) { /* ignore */ }
      var err = new Error("HTTP " + res.status + (body ? " " + body : ""));
      err.status = res.status;
      throw err;
    }
    var json = await res.json();
    return unwrapApi(json);
  }

  function unwrapApi(json) {
    if (!json || typeof json !== "object") return json;
    var inner = json.payload;
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      if (inner.entries || inner.history || inner.items || inner.messages || inner.pagination || inner.id) {
        return inner;
      }
    }
    if (json.data && typeof json.data === "object" && !Array.isArray(json.data)) {
      var d = json.data;
      if (d.entries || d.history || d.items || d.messages || d.pagination || d.id) return d;
    }
    return json;
  }

  async function fetchText(url) {
    var res = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "text/html,application/xhtml+xml,application/json" }
    });
    if (!res.ok) {
      var err = new Error("HTTP " + res.status);
      err.status = res.status;
      throw err;
    }
    return res.text();
  }

  function historyBatch(payload) {
    if (!payload) return [];
    if (Array.isArray(payload.entries)) return payload.entries;
    if (Array.isArray(payload.history)) return payload.history;
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload)) return payload;
    return [];
  }

  AE.historyListAll = async function (hooks) {
    hooks = hooks || {};
    var merged = [];
    var cursor = null;
    var page = 0;
    var endpoints = ["/api/history/unified", "/api/history/list"];
    var endpoint = endpoints[0];
    while (page < PAGE_GUARD) {
      var params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("includeArchived", "true");
      if (cursor) params.set("cursor", cursor);
      var url = location.origin + endpoint + "?" + params.toString();
      var payload;
      try {
        payload = await fetchJson(url);
      } catch (e) {
        if (page === 0 && endpoint === endpoints[0] && e && e.status === 404) {
          endpoint = endpoints[1];
          continue;
        }
        throw e;
      }
      var batch = historyBatch(payload);
      merged.push.apply(merged, batch);
      page += 1;
      if (hooks.onPage) hooks.onPage({ page: page, count: merged.length });
      var pag = payload && payload.pagination ? payload.pagination : {};
      var hasMore = pag.hasMore === true || pag.has_more === true;
      var next = typeof pag.cursor === "string" ? pag.cursor : (typeof pag.nextCursor === "string" ? pag.nextCursor : null);
      if (!hasMore || !next || !batch.length) break;
      cursor = next;
    }
    var seen = {};
    var out = [];
    merged.forEach(function (item) {
      var id = AE.historyUuid(item && (item.id || item.evaluationId || item.sessionId || item.conversationId));
      if (!id || seen[id]) return;
      seen[id] = true;
      var type = String((item && item.type) || "evaluation");
      if (type !== "agentic") type = "evaluation";
      out.push({
        id: id,
        type: type,
        title: String((item && (item.title || item.name)) || ""),
        mode: String((item && item.mode) || ""),
        createdAt: (item && (item.createdAt || item.created_at)) || "",
        updatedAt: (item && (item.updatedAt || item.updated_at)) || ""
      });
    });
    return out;
  };

  function extractJsonObjectAt(text, start) {
    var depth = 0, inStr = false, esc = false;
    for (var i = start; i < text.length; i++) {
      var c = text.charAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === "\"") inStr = false;
        continue;
      }
      if (c === "\"") { inStr = true; continue; }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  function parseAgentHtml(html, id, meta) {
    if (AE.parsePageData) {
      var page = AE.parsePageData(html, location.origin + "/agent/" + id);
      if (page.transcript) return Object.assign({}, page.transcript, {
        id: id, type: "agentic", title: (meta && meta.title) || "", createdAt: (meta && meta.createdAt) || "",
        pageUrl: location.origin + "/agent/" + id
      });
    }
    var flight = "";
    var re = /self\.__next_f\.push\(\[1,"((?:\\.|[^"\\])*)"\]\)<\/script>/g;
    var m;
    while ((m = re.exec(html))) {
      try { flight += JSON.parse("\"" + m[1] + "\""); } catch (e) { /* skip chunk */ }
    }
    var search = flight || html;
    var idx = 0;
    while (idx < search.length) {
      var start = search.indexOf("{\"messages\":[", idx);
      if (start < 0) break;
      var objText = extractJsonObjectAt(search, start);
      if (!objText) break;
      try {
        var cand = JSON.parse(objText);
        if (Array.isArray(cand.messages) && cand.messages.some(function (msg) {
          return msg && (Array.isArray(msg.parts) || msg.role);
        })) {
          cand.id = id;
          cand.type = "agentic";
          cand.title = (meta && meta.title) || cand.title || "";
          cand.createdAt = (meta && meta.createdAt) || cand.createdAt || "";
          cand.pageUrl = location.origin + "/agent/" + id;
          return cand;
        }
      } catch (e) { /* keep scanning */ }
      idx = start + 1;
    }
    return null;
  }

  AE.historyFetchRecord = async function (item) {
    var id = AE.historyUuid(item && (item.id || item));
    if (!id) throw new Error("invalid id");
    var type = String((item && item.type) || "evaluation");
    if (type === "agentic") {
      var html = await fetchText(location.origin + "/agent/" + id);
      var agent = parseAgentHtml(html, id, item);
      if (!agent) throw new Error("agent payload missing");
      return agent;
    }
    try {
      return await fetchJson(location.origin + "/api/evaluation/" + id);
    } catch (e) {
      if (e && e.status === 404) {
        var html2 = await fetchText(location.origin + "/agent/" + id);
        var agent2 = parseAgentHtml(html2, id, item);
        if (agent2) return agent2;
      }
      throw e;
    }
  };

  AE.historyPullAll = async function (hooks) {
    hooks = hooks || {};
    var list = await AE.historyListAll(hooks);
    if (hooks.onList) hooks.onList({ total: list.length });
    var records = [];
    var failed = [];
    for (var i = 0; i < list.length; i++) {
      if (hooks.onItem) hooks.onItem({ index: i + 1, total: list.length, item: list[i] });
      try {
        var rec = await AE.historyFetchRecord(list[i]);
        rec._historyMeta = list[i];
        records.push(rec);
      } catch (e) {
        failed.push({ id: list[i].id, type: list[i].type, error: String(e && e.message ? e.message : e) });
      }
      await wait(ITEM_GAP_MS);
    }
    return { list: list, records: records, failed: failed };
  };

  function modelOf(message, evaluation, lane) {
    var m = message || {};
    var name = m.modelName || m.model || m.model_name || m.publicName;
    if (name && typeof name === "object") name = AE.catalogModelLabel(name);
    if (typeof name === "string" && name && !AE.isPlaceholderModel(name)) return name;
    var ev = evaluation || {};
    if (lane === "A") name = ev.modelA || ev.model_a || (ev.models && ev.models[0]);
    if (lane === "B") name = ev.modelB || ev.model_b || (ev.models && ev.models[1]);
    if (name && typeof name === "object") name = AE.catalogModelLabel(name);
    if (typeof name === "string" && name && !AE.isPlaceholderModel(name)) return name;
    return null;
  }

  function mediaBasename(path, url, index, contentType) {
    var name = String(path || "").replace(/\\/g, "/").split("/").pop();
    if (url) {
      try {
        var u = new URL(url, "https://arena.ai/");
        var fromUrl = (u.pathname.split("/").pop() || "").split("?")[0];
        if (fromUrl && /\.(png|jpe?g|webp|gif|avif|svg|mp4|webm|mov)$/i.test(fromUrl)) name = fromUrl;
        else if (!name) name = fromUrl;
      } catch (e) { /* keep */ }
    }
    if (name) name = name.split("?")[0];
    var ext = "";
    var ct = String(contentType || "").toLowerCase();
    if (/jpeg|jpg/.test(ct)) ext = ".jpeg";
    else if (/png/.test(ct)) ext = ".png";
    else if (/webp/.test(ct)) ext = ".webp";
    else if (/gif/.test(ct)) ext = ".gif";
    else if (/mp4/.test(ct)) ext = ".mp4";
    if (!name || !/\./.test(name)) name = "image-" + (index + 1) + (ext || ".png");
    else if (ext && !/\.(png|jpe?g|webp|gif|avif|svg|mp4|webm|mov)$/i.test(name)) name += ext;
    return name;
  }

  function filesFromMessage(message) {
    var out = [];
    var seen = {};
    function add(obj) {
      if (obj == null) return;
      if (typeof obj === "string") {
        if (/^https?:/i.test(obj) || obj.indexOf("data:image") === 0) add({ url: obj });
        return;
      }
      if (typeof obj !== "object") return;
      var nested = obj.image_url && typeof obj.image_url === "object" ? obj.image_url : null;
      var url = obj.url || obj.downloadUrl || obj.href || obj.src || (nested && (nested.url || nested.href)) || null;
      var path = obj.name || obj.filename || obj.path || (nested && nested.path) || null;
      var ct = obj.contentType || obj.mimeType || obj.media_type || (nested && nested.contentType) || null;
      var content = typeof obj.content === "string" ? obj.content : null;
      if (!url && !content) return;
      if (url && seen[url]) return;
      if (url) seen[url] = true;
      out.push({
        path: mediaBasename(path, url, out.length, ct),
        downloadUrl: url && String(url).indexOf("data:") === 0 ? null : url,
        content: content || (url && String(url).indexOf("data:") === 0 ? url : null),
        contentType: ct || null
      });
    }
    var buckets = [message && message.experimental_attachments, message && message.attachments, message && message.files];
    buckets.forEach(function (arr) {
      if (Array.isArray(arr)) arr.forEach(add);
    });
    var content = message && message.content;
    if (Array.isArray(content)) {
      content.forEach(function (part) {
        if (!part || typeof part !== "object") return;
        var typ = String(part.type || "");
        if (typ === "image_url" || typ === "image" || typ === "file" || typ === "media") add(part.image_url || part);
      });
    }
    return out;
  }

  function attachmentsToFiles(message) {
    return filesFromMessage(message);
  }

  function voteFromEvaluation(ev) {
    var v = ev && (ev.vote || ev.vote_choice || ev.preference || ev.winner || ev.outcome);
    if (!v) return { choice: null, outcome: null };
    var t = String(v).toLowerCase();
    if (t === "a" || t === "model_a" || t === "left") return { choice: "A", outcome: "a_wins" };
    if (t === "b" || t === "model_b" || t === "right") return { choice: "B", outcome: "b_wins" };
    if (t.indexOf("both") !== -1) return { choice: "both_good", outcome: "both_good" };
    if (t.indexOf("neither") !== -1) return { choice: "neither_good", outcome: "neither_good" };
    return { choice: null, outcome: t };
  }

  function subtypeOf(ev, contestants) {
    var raw = String((ev && (ev.subtype || ev.category || ev.task || ev.game || ev.mode || ev.modality)) || "").toLowerCase();
    if (/code|webdev|web-dev/.test(raw)) return "code";
    if (/image/.test(raw)) return "image";
    if (/video/.test(raw)) return "video";
    if (/search/.test(raw)) return "web-search";
    var files = [];
    (contestants || []).forEach(function (c) { (c.files || []).forEach(function (f) { files.push(f); }); });
    if (files.some(function (f) { return /^video\//i.test(f.contentType || "") || /\.(mp4|webm|mov)$/i.test(f.path || ""); })) return "video";
    if (files.some(function (f) { return /^image\//i.test(f.contentType || "") || /\.(png|jpe?g|webp|gif|avif|svg)$/i.test(f.path || ""); })) return "image";
    return "text";
  }

  AE.historyEvaluationToPayload = function (ev, meta) {
    ev = ev || {};
    var selectedMode = /^(direct|direct-battle|side-by-side)$/.test(ev.mode || "");
    var id = AE.historyUuid(ev.id || ev.evaluationId || (meta && meta.id));
    var vote = voteFromEvaluation(ev);
    var msgs = Array.isArray(ev.messages) ? ev.messages : [];
    var battles = [];
    var thread = [];
    var i = 0;
    while (i < msgs.length) {
      var m = msgs[i] || {};
      var role = String(m.role || "").toLowerCase();
      if (role === "user") {
        var prompt = asText(m.content);
        var assistants = [];
        i++;
        while (i < msgs.length && String((msgs[i] || {}).role || "").toLowerCase() === "assistant") {
          assistants.push(msgs[i]);
          i++;
        }
        if (assistants.length >= 2) {
          var contestants = assistants.map(function (a, idx) {
            var lane = String(a.participantPosition || a.position || "").toUpperCase();
            if (lane !== "A" && lane !== "B") lane = idx === 0 ? "A" : "B";
            return {
              lane: lane,
              model: modelOf(a, ev, lane),
              model_source: modelOf(a, ev, lane) ? "history_metadata" : "unknown",
              model_identity_verified: false,
              model_id: a.modelId || a.model_id || (lane === "A" ? ev.modelAId : ev.modelBId) || null,
              message_id: a.id || null,
              response: asText(a.content),
              finished: true,
              files: attachmentsToFiles(a),
              tools: [],
              tool_calls: []
            };
          });
          battles.push({
            evaluation_id: id,
            mode: ev.mode || "battle",
            subtype: subtypeOf(ev, contestants),
            prompt: prompt,
            anonymous: !contestants.some(function (c) { return c.model; }),
            contestants: contestants,
            vote_choice: selectedMode ? null : vote.choice,
            outcome: selectedMode ? "not_applicable" : vote.outcome || "pending",
            workspace_files: []
          });
        } else {
          thread.push({
            id: m.id || ("user-" + thread.length),
            role: "user",
            content: [{ type: "text", text: prompt }]
          });
          if (assistants[0]) {
            var a = assistants[0];
            thread.push({
              id: a.id || ("asst-" + thread.length),
              role: "assistant",
              model: modelOf(a, ev, "A"),
              model_source: modelOf(a, ev, "A") ? "history_metadata" : "unknown",
              model_identity_verified: false,
              model_id: a.modelId || a.model_id || ev.modelAId || null,
              content: [{ type: "text", text: asText(a.content) }]
            });
          }
        }
      } else {
        i++;
      }
    }
    var title = (meta && meta.title) || ev.title || (battles[0] && battles[0].prompt) || "";
    var mode = battles.length ? (ev.mode || "battle") : (ev.mode || "direct");
    return {
      schema_version: AE.SCHEMA_VERSION || "2.1",
      export: {
        mode: "full_history",
        exported_at: new Date().toISOString(),
        extension_version: (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest)
          ? chrome.runtime.getManifest().version : "1.17.0",
        source: {
          site: "arena.ai",
          mode: mode,
          url: "https://arena.ai/c/" + id
        }
      },
      session: {
        session_id: id,
        conversation_key: "c:" + id,
        title: title,
        started_at: ev.createdAt || (meta && meta.createdAt) || null
      },
      messages: thread,
      battles: battles,
      meta: {
        capture_sources: ["history_api"],
        completeness: "partial",
        warnings: ["Backfilled from Arena history API (unofficial). Live streams were not captured."]
      }
    };
  };

  function agentPartsToBlocks(parts) {
    var blocks = [];
    (Array.isArray(parts) ? parts : []).forEach(function (part) {
      if (!part || typeof part !== "object") return;
      var typ = String(part.type || "");
      if (typ === "text" && part.text) blocks.push({ type: "text", text: part.text });
      else if ((typ === "reasoning" || typ === "thinking") && part.text) blocks.push({ type: "thinking", text: part.text });
      else if (typ.indexOf("tool-") === 0) {
        blocks.push({
          type: "tool_call",
          tool_name: typ.replace(/^tool-/, ""),
          call_id: part.toolCallId || part.id || null,
          arguments: part.input || part.arguments || null
        });
        if (part.output != null || part.errorText != null) {
          blocks.push({
            type: "tool_result",
            tool_name: typ.replace(/^tool-/, ""),
            call_id: part.toolCallId || part.id || null,
            status: part.errorText != null ? "error" : "success",
            output: part.errorText != null ? part.errorText : part.output
          });
        }
      }
    });
    return blocks;
  }

  AE.historyAgentToPayload = function (agent, meta) {
    agent = agent || {};
    var id = AE.historyUuid(agent.id || (meta && meta.id));
    var messages = (Array.isArray(agent.messages) ? agent.messages : []).map(function (m, i) {
      return {
        id: m.id || ("msg-" + i),
        role: String(m.role || "assistant").toLowerCase(),
        content: AE.scrubSecrets(agentPartsToBlocks(m.parts)),
        metadata: AE.assistantMetadata(m)
      };
    });
    var title = (meta && meta.title) || agent.title || "";
    if (!title) {
      var u = messages.filter(function (m) { return m.role === "user"; })[0];
      if (u && u.content && u.content[0] && u.content[0].text) title = u.content[0].text.slice(0, 80);
    }
    return {
      schema_version: AE.SCHEMA_VERSION || "2.1",
      export: {
        mode: "full_history",
        exported_at: new Date().toISOString(),
        extension_version: (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest)
          ? chrome.runtime.getManifest().version : "1.17.0",
        source: {
          site: "arena.ai",
          mode: "agent",
          url: "https://arena.ai/agent/" + id
        }
      },
      session: {
        session_id: id,
        conversation_key: "c:" + id,
        title: title,
        orchestrator_model: null,
        orchestrator_model_source: "not_revealed",
        started_at: agent.createdAt || (meta && meta.createdAt) || null
      },
      messages: messages,
      battles: [],
      meta: {
        capture_sources: ["history_api"],
        transcript: AE.transcriptMetadata(agent),
        completeness: "partial",
        warnings: ["Backfilled from Arena history API (unofficial). Live streams were not captured."]
      }
    };
  };

  AE.historyRecordToPayload = function (record) {
    if (!record || typeof record !== "object") return null;
    var meta = record._historyMeta || {};
    if (record.type === "agentic" || (Array.isArray(record.messages) && record.messages.some(function (m) {
      return m && Array.isArray(m.parts);
    }))) {
      return AE.historyAgentToPayload(record, meta);
    }
    return AE.historyEvaluationToPayload(record, meta);
  };
})();
