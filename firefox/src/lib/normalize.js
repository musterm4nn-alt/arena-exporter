/* Event normalizer: turns arbitrary captured JSON (API responses, SSE frames)
 * into canonical export blocks. Defensive by design — arena.ai's payload
 * shapes are unknown ground truth, so this sniffs for common agent-protocol
 * patterns (OpenAI-style chunks, Anthropic-style content blocks, generic
 * tool/thinking envelopes). */
var AE = AE || {};

(function () {
  "use strict";

  var THINKING_KEY_RE = /(^|[_\-.])(thinking|reasoning|reasoning_content|chain[_\s-]?of[_\s-]?thought|thought|cot)s?$/i;
  var COMMAND_TOOL_RE = /^(run_?command|exec(ute)?(_command)?|bash|shell|terminal|run_?shell|run_?terminal|computer_?terminal)$/i;
  var ACTION_NAME_RE = /^(create|write|edit|patch|delete|read|open|list|move|rename|navigate|click|scroll|type|hover|drag|select|browse|search|fetch|generate|render|build|deploy|install|analyze|vote|submit)[_-]/i;

  function asText(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }

  function toolNameOf(tc) {
    return (
      tc.name ||
      tc.tool_name ||
      tc.toolName ||
      (tc.function && tc.function.name) ||
      (tc.tool && tc.tool.name) ||
      "unknown"
    );
  }

  function argsOf(tc) {
    var a = tc.arguments != null ? tc.arguments
      : tc.input != null ? tc.input
      : (tc.function && tc.function.arguments != null) ? tc.function.arguments
      : tc.parameters != null ? tc.parameters
      : null;
    if (typeof a === "string") {
      try { a = JSON.parse(a); } catch (e) { /* keep string */ }
    }
    return a;
  }

  function textOfResult(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (Array.isArray(v)) {
      // Anthropic-style [{type:"text",text:"..."}]
      return v
        .map(function (p) { return p && typeof p === "object" ? asText(p.text != null ? p.text : p) : asText(p); })
        .join("\n");
    }
    if (typeof v === "object") return asText(v.content != null ? v.content : v.output != null ? v.output : v);
    return asText(v);
  }

  /**
   * Normalize a captured JSON payload into canonical blocks.
   * @param {*} data parsed JSON body / SSE data object
   * @param {{streaming?: boolean}} opts streaming=true → text/thinking blocks
   *   are marked partial so the service worker merges consecutive deltas.
   * @returns {Array<Object>} blocks
   */
  AE.normalizeCaptured = function (data, opts) {
    opts = opts || {};
    var blocks = [];
    var depthGuard = 0;

    function push(b) {
      if (!b) return;
      b.source = "network";
      if (opts.streaming) b.partial = true;
      blocks.push(b);
    }

    function scan(o) {
      if (!o || depthGuard > 400) return;
      depthGuard++;
      if (Array.isArray(o)) {
        for (var i = 0; i < o.length; i++) scan(o[i]);
        return;
      }
      if (typeof o !== "object") return;

      // OpenAI-style completion envelope: {choices:[{delta|message}]}
      if (Array.isArray(o.choices)) {
        for (var ci = 0; ci < o.choices.length; ci++) {
          var ch = o.choices[ci] || {};
          scanMessageObject(ch.delta || ch.message || {});
        }
        return; // choices payloads are leaf-ish; don't re-scan children
      }

      scanMessageObject(o);

      for (var key of Object.keys(o)) {
        var v = o[key];
        if (v && typeof v === "object") scan(v);
      }
    }

    function scanMessageObject(m) {
      if (!m || typeof m !== "object") return;

      var keys = Object.keys(m);
      var i, k, v;

      // ---- thinking / reasoning text ----
      for (i = 0; i < keys.length; i++) {
        k = keys[i]; v = m[k];
        if (typeof v === "string" && v && THINKING_KEY_RE.test(k)) {
          push({ type: "thinking", text: v });
        }
      }

      // ---- message with role ----
      if (typeof m.role === "string") {
        var role = m.role.toLowerCase();
        if (role === "user" || role === "system") {
          var body = textOfResult(m.content);
          if (body) push({ type: "text", role: role, text: body, format: "markdown" });
        } else if (role === "assistant" && typeof m.content === "string" && m.content) {
          push({ type: "text", role: "assistant", text: m.content, format: "markdown" });
        } else if (role === "tool") {
          push({
            type: "tool_result",
            call_id: m.tool_call_id || m.call_id || null,
            output: textOfResult(m.content),
            status: "unknown"
          });
        }
      }

      // ---- Vercel AI SDK UIMessage parts (generic path; the background also
      //      handles top-level UIMessages with snapshot semantics) ----
      if (Array.isArray(m.parts)) {
        var pb = AE.partsToBlocks(m.parts, typeof m.role === "string" ? m.role.toLowerCase() : "assistant");
        for (var pbi = 0; pbi < pb.length; pbi++) push(pb[pbi]);
      }

      // ---- streaming content delta without role (OpenAI-style) ----
      if (opts.streaming && typeof m.content === "string" && m.content && !m.role) {
        push({ type: "text", text: m.content });
      }

      // ---- typed event envelopes ----
      var etype = typeof m.type === "string" ? m.type.toLowerCase() : "";
      if (etype === "content_block_delta" || etype === "text_delta") {
        var d = m.delta || {};
        if (typeof d.text === "string" && d.text) push({ type: "text", text: d.text });
        if (typeof d.thinking === "string" && d.thinking) push({ type: "thinking", text: d.thinking });
      }
      if (etype === "thinking" || etype === "thinking_block") {
        if (typeof m.thinking === "string" && m.thinking) push({ type: "thinking", text: m.thinking });
      }
      if (etype === "tool_use") {
        pushToolCall({ name: m.name, input: m.input, id: m.id });
      }
      if (etype === "tool_result") {
        push({
          type: "tool_result",
          call_id: m.tool_use_id || m.call_id || null,
          output: textOfResult(m.content),
          status: m.is_error ? "error" : "success"
        });
      }

      // ---- explicit tool call fields ----
      if (Array.isArray(m.tool_calls)) {
        for (i = 0; i < m.tool_calls.length; i++) pushToolCall(m.tool_calls[i]);
      }
      if (m.tool_call && typeof m.tool_call === "object") pushToolCall(m.tool_call);
      if (m.function_call && typeof m.function_call === "object") pushToolCall(m.function_call);
      if (m.tool_result != null && m.type !== "tool_result") {
        push({
          type: "tool_result",
          call_id: m.tool_call_id || m.call_id || null,
          output: textOfResult(m.tool_result),
          status: m.status || "unknown"
        });
      }

      // ---- plain command objects: {command:"...", stdout, stderr, exit_code} ----
      if (typeof m.command === "string" && m.command &&
          ("stdout" in m || "stderr" in m || "exit_code" in m || "exitCode" in m)) {
        push({
          type: "command",
          command: m.command,
          exit_code: m.exit_code != null ? m.exit_code : m.exitCode,
          stdout: asText(m.stdout || ""),
          stderr: asText(m.stderr || "")
        });
      }

      // ---- artifacts ----
      if (etype === "artifact" || m.artifact != null) {
        var a = m.artifact && typeof m.artifact === "object" ? m.artifact : m;
        push({
          type: "artifact",
          artifact_type: a.artifact_type || a.kind || "unknown",
          title: a.title || a.name || null,
          content_or_url: a.url || a.content || null
        });
      }
    }

    function pushToolCall(tc) {
      if (!tc || typeof tc !== "object") return;
      var name = toolNameOf(tc);
      var args = argsOf(tc);
      var block = {
        type: "tool_call",
        tool_name: name,
        call_id: tc.id || tc.call_id || tc.tool_call_id || null,
        arguments: args,
        status: tc.status || "pending"
      };
      push(block);

      // Command-flavored tool calls also surface as first-class command blocks.
      if (COMMAND_TOOL_RE.test(name) && args && typeof args === "object") {
        var cmd = args.command || args.cmd || args.script || null;
        if (cmd) push({ type: "command", command: asText(cmd) });
      }
      // Action-flavored tool names surface as action blocks for rollups.
      if (ACTION_NAME_RE.test(name)) {
        push({
          type: "action",
          action: name,
          target: args && typeof args === "object" ? asText(args.path || args.file || args.url || args.target || "") : "",
          summary: asText(args || "")
        });
      }
    }

    scan(data);
    return blocks;
  };

  /* ---------- Vercel AI SDK UIMessage protocol ----------
   * Confirmed live on arena.ai Agent Mode (/in/append + /out):
   *   {kind:"message", payload:{message:{id, role, parts:[...]}}}
   * Assistant parts include: text, reasoning, tool-<name> (with state
   * input-available / output-available / output-error), file, source-url,
   * step-start. */

  function pushToolPartBlocks(out, p, name) {
    var state = typeof p.state === "string" ? p.state : "";
    var callId = p.toolCallId || p.id || null;
    if (state === "output-available") {
      if (p.input != null) {
        out.push({ type: "tool_call", tool_name: name, call_id: callId, arguments: p.input, status: "success" });
      }
      out.push({ type: "tool_result", call_id: callId, tool_name: name, output: textOfResult(p.output), status: "success" });
    } else if (state === "output-error") {
      out.push({ type: "tool_result", call_id: callId, tool_name: name, output: asText(p.errorText || p.error || "error"), status: "error" });
    } else if (state === "input-available") {
      out.push({ type: "tool_call", tool_name: name, call_id: callId, arguments: p.input != null ? p.input : null, status: "pending" });
    }
    /* input-started / input-streaming / input-delta are partial states;
     * snapshots re-deliver the complete input-available part later. */
  }

  /**
   * Convert a UIMessage parts array into canonical blocks.
   */
  AE.partsToBlocks = function (parts, role) {
    var out = [];
    if (!Array.isArray(parts)) return out;

    if (role === "user" || role === "system") {
      var texts = [];
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (p && p.type === "text" && typeof p.text === "string") texts.push(p.text);
      }
      if (texts.length) out.push({ type: "text", role: role, text: texts.join("\n"), format: "markdown" });
      return out;
    }

    for (var j = 0; j < parts.length; j++) {
      var q = parts[j];
      if (!q || typeof q !== "object" || typeof q.type !== "string") continue;
      var t = q.type;
      if (t === "text" && typeof q.text === "string" && q.text) {
        out.push({ type: "text", text: q.text, format: "markdown" });
      } else if (t === "reasoning" && typeof q.text === "string" && q.text) {
        out.push({ type: "thinking", text: q.text });
      } else if (t.indexOf("tool-") === 0) {
        pushToolPartBlocks(out, q, t.slice(5));
      } else if (t === "file") {
        out.push({ type: "artifact", artifact_type: q.mediaType || "file", title: q.filename || null, content_or_url: q.url || null });
      } else if (t === "source-url" && q.url) {
        out.push({ type: "artifact", artifact_type: "source", title: q.title || q.url, content_or_url: q.url });
      } else if (t === "step-start" || t === "step-finish") {
        /* structural markers — intentionally skipped */
      } else if (typeof q.text === "string" && q.text) {
        out.push({ type: "text", text: q.text });
      }
    }
    return out;
  };

  /**
   * Detect a UIMessage envelope and normalize it with message identity.
   * Returns {messageId, role, blocks} or null.
   */
  AE.normalizeUIMessage = function (data) {
    if (!data || typeof data !== "object") return null;
    var msg = null;
    if (data.payload && data.payload.message && Array.isArray(data.payload.message.parts)) msg = data.payload.message;
    else if (data.message && Array.isArray(data.message.parts)) msg = data.message;
    else if (Array.isArray(data.parts) && (typeof data.id === "string" || typeof data.role === "string")) msg = data;
    if (!msg || !Array.isArray(msg.parts)) return null;
    var role = typeof msg.role === "string" ? msg.role.toLowerCase() : "assistant";
    return {
      messageId: typeof msg.id === "string" ? msg.id : null,
      role: role,
      blocks: AE.partsToBlocks(msg.parts, role)
    };
  };

  /**
   * Extract file-like artifacts from workspace payloads
   * (e.g. /api/chat/<id>/workspace/latest?includeManifest=true).
   * Heuristic: objects exposing path/fileName, or name + size/mime evidence.
   */
  AE.extractWorkspaceArtifacts = function (data) {
    var blocks = [];
    var visits = 0;

    function scan(o) {
      if (!o || visits++ > 800 || blocks.length >= 50) return;
      if (Array.isArray(o)) {
        for (var i = 0; i < o.length; i++) scan(o[i]);
        return;
      }
      if (typeof o !== "object") return;

      var title = null;
      if (typeof o.path === "string" && o.path) title = o.path;
      else if (typeof o.fileName === "string" && o.fileName) title = o.fileName;
      else if (typeof o.name === "string" && o.name &&
               (o.size != null || o.mimeType || o.contentType)) title = o.name;

      if (title) {
        var kind = (typeof o.mimeType === "string" && o.mimeType) ||
                   (typeof o.contentType === "string" && o.contentType) ||
                   (typeof o.type === "string" && o.type) || "file";
        var href = (typeof o.url === "string" && o.url) ||
                   (typeof o.downloadUrl === "string" && o.downloadUrl) || null;
        var inline = typeof o.content === "string" ? o.content : null;
        var block = {
          type: "artifact",
          artifact_type: kind,
          title: title,
          content_or_url: href || inline,
          source: "network"
        };
        if (inline) block.content = inline;
        blocks.push(block);
      }

      for (var key of Object.keys(o)) {
        var v = o[key];
        if (v && typeof v === "object") scan(v);
      }
    }

    scan(data);
    return blocks;
  };

  /* ---------- Battle ("evaluation") stream parser ----------
   * Live-captured wire format for /nextjs-api/stream/create-evaluation and
   * post-to-evaluation: an optional bare JSON init record, then a run of
   * lane-prefixed AI-SDK data-stream rows with NO delimiters, e.g.
   *   {"id":..,"mode":"battle","modelAMessageId":..,"modelBMessageId":..,\n     "userMessage":{..}}a0:"I "b0:"the "a2:[{"type":"heartbeat"}]ad:{"finishReason":"stop"}
   * Lane letter = model (a/b); part code = 0 text delta, 2 data/heartbeat,
   * d finish. We reconstruct each model's response text from its deltas. */

  /* Read one JSON value starting at i. Returns [value, nextIndex] or null. */
  function readJsonValue(str, i) {
    var c = str[i];
    if (c === undefined) return null;
    var end = -1;
    if (c === '"') {
      var j = i + 1;
      while (j < str.length) {
        if (str[j] === "\\") { j += 2; continue; }
        if (str[j] === '"') { end = j + 1; break; }
        j++;
      }
      if (end < 0) return null;
    } else if (c === '{' || c === '[') {
      var depth = 0, inStr = false, esc = false;
      for (var k = i; k < str.length; k++) {
        var ch = str[k];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
        } else {
          if (ch === '"') inStr = true;
          else if (ch === '{' || ch === '[') depth++;
          else if (ch === '}' || ch === ']') { depth--; if (depth === 0) { end = k + 1; break; } }
        }
      }
      if (end < 0) return null;
    } else {
      return null;
    }
    var slice = str.slice(i, end);
    try { return [JSON.parse(slice), end]; } catch (e) { return null; }
  }

  /**
   * Parse a raw battle stream body into init + per-lane responses.
   * @returns {{init:Object|null, lanes:Object, prompt:string|null}}
   */
  AE.parseBattleStream = function (text, options) {
    var result = { init: null, lanes: {}, prompt: null, modality: null };
    if (typeof text !== "string" || !text) return result;
    var i = 0;
    while (i < text.length && /\s/.test(text[i])) i++;

    // Optional leading bare JSON object (the init record).
    if (text[i] === '{') {
      var initRead = readJsonValue(text, i);
      if (initRead) {
        if (initRead[0] && (initRead[0].error || initRead[0].errors) && !initRead[0].userMessage) return result;
        if (!initRead[0] || !(initRead[0].id || initRead[0].mode || initRead[0].userMessage || initRead[0].modelAMessageId)) return result;
        result.init = initRead[0];
        i = initRead[1];
        if (result.init && result.init.userMessage && typeof result.init.userMessage.content === "string") {
          result.prompt = result.init.userMessage.content;
        }
        var amd = result.init && result.init.userMessage && result.init.userMessage.metadata &&
                  result.init.userMessage.metadata.autoModalityMetadata;
        if (amd && typeof amd.modality === "string") result.modality = amd.modality;
      }
    }

    /* Single-char AI-SDK codes only (0 text, 2 data, 9 tool, a result, c cite, d finish).
     * A longer class would treat CSS `background:` inside file contents as a row. */
    var rowRe = options && options.singleLane ? /([ab]?)([0-9a-e]):/y : /([ab])([0-9a-e]):/y;
    while (i < text.length) {
      rowRe.lastIndex = i;
      var m = rowRe.exec(text);
      if (!m) { i++; continue; }
      var lane = m[1] || "a", code = m[2];
      var valRead = readJsonValue(text, rowRe.lastIndex);
      if (!valRead) { i = rowRe.lastIndex; continue; }
      var val = valRead[0];
      i = valRead[1];

      if (code === "3") {
        result.error = typeof val === "string" ? val : "Stream error";
        if (result.lanes[lane]) result.lanes[lane].finished = false;
        continue;
      }
      var L = result.lanes[lane] || (result.lanes[lane] = { text: "", finished: false, finishReason: null, citationsRaw: "", tools: [], toolResults: {}, files: [] });
      if (code === "0" && typeof val === "string") {
        L.text += val;
      } else if (code === "d" && val && typeof val === "object") {
        if (val.finishReason === "error") result.error = result.error || "Stream finished with an error";
        L.finished = !result.error;
        L.finishReason = val.finishReason || null;
      } else if (code === "c" && val && typeof val === "object" && typeof val.argsTextDelta === "string") {
        L.citationsRaw += val.argsTextDelta;
      } else if (code === "9" && val && typeof val === "object" && val.toolName) {
        L.tools.push({ toolCallId: val.toolCallId || null, toolName: val.toolName, args: val.args != null ? val.args : null });
        pushFileFromTool(L, val.toolName, val.args);
      } else if (code === "a" && val && typeof val === "object" && val.toolCallId) {
        L.toolResults[val.toolCallId] = val.result != null ? val.result : val;
      } else if (code === "2") {
        ingestDataItems(result, L, val);
      }
    }

    Object.keys(result.lanes).forEach(function (k) {
      var L = result.lanes[k];
      var cites = extractCitations(L.citationsRaw || "");
      var codeFlag = false;
      var toolNames = {};
      L.tools.forEach(function (t) {
        toolNames[t.toolName] = true;
        if (/(write|create|code|exec|file|javascript|python|bash|shell|webdev)/i.test(t.toolName || "")) codeFlag = true;
        if (/web_?search/i.test(t.toolName || "") && t.toolCallId && L.toolResults[t.toolCallId]) {
          var res = L.toolResults[t.toolCallId];
          var arr = res && Array.isArray(res.results) ? res.results : [];
          arr.forEach(function (r) {
            if (r && typeof r.url === "string" && !cites.some(function (c) { return c.url === r.url; })) {
              cites.push({ url: r.url, title: r.title || null });
            }
          });
        }
      });
      Object.keys(L.toolResults).forEach(function (id) {
        var r = L.toolResults[id];
        var msg = r && typeof r.message === "string" ? r.message : "";
        if (/Created\s+\S+\.(js|jsx|ts|tsx|html|py|css|vue|svelte)\b/i.test(msg)) codeFlag = true;
      });
      if ((result.workspaceFiles && result.workspaceFiles.length) || (L.files && L.files.some(function (f) {
        var p = String((f && (f.path || f.downloadUrl || "")) || "");
        return p && !/\.(png|jpe?g|webp|gif|avif|svg|mp4|webm|mov)(\?|$)/i.test(p);
      }))) codeFlag = true;
      L.citations = cites;
      L.toolNames = Object.keys(toolNames);
      L.code = codeFlag;
      delete L.citationsRaw;
      delete L.toolResults;
    });
    return result;
  };

  function pushFileFromTool(L, toolName, args) {
    if (!args || typeof args !== "object") return;
    var p = args.path || args.file;
    if (!p || typeof p !== "string") return;
    if (!/(create|write|edit).*file|write_file|create_file|edit_file/i.test(toolName || "")) return;
    if (!L.files) L.files = [];
    L.files.push({
      path: p,
      content: typeof args.content === "string" ? args.content : null,
      tool: toolName
    });
  }

  function isMediaUrl(url) {
    if (typeof url !== "string" || !url) return false;
    if (/^(blob:|data:image|data:video)/i.test(url)) return true;
    if (!/^https?:/i.test(url)) return false;
    if (/\.(png|jpe?g|webp|gif|avif|svg|mp4|webm|mov)(\?|$)/i.test(url)) return true;
    if (/cdn\.arena\.ai|r2\.dev|r2\.cloudflarestorage\.com/i.test(url)) return true;
    return false;
  }

  function pushLaneMedia(L, url, kind) {
    if (!isMediaUrl(url) && !/^https?:\/\/([a-z0-9-]+\.)*(arena\.ai|lmarena\.ai)\//i.test(url || "")) return;
    if (!url) return;
    if (!L.files) L.files = [];
    if (L.files.some(function (f) { return f && (f.downloadUrl === url || f.url === url || f.content === url); })) return;
    var video = kind === "video" || /\.(mp4|webm|mov)(\?|$)/i.test(url);
    var rec = {
      path: "image-" + (L.files.length + 1) + (video ? ".mp4" : ".png"),
      contentType: video ? "video/mp4" : "image/png",
      source: "stream"
    };
    try {
      var u = new URL(url, "https://arena.ai/");
      var base = (u.pathname.split("/").pop() || "").split("?")[0];
      if (/\.(png|jpe?g|webp|gif|avif|svg|mp4|webm|mov)$/i.test(base)) rec.path = base;
    } catch (e) { /* keep default */ }
    if (url.indexOf("data:") === 0) rec.content = url;
    else rec.downloadUrl = url;
    L.files.push(rec);
  }

  function ingestMediaItem(L, item) {
    if (!item || typeof item !== "object") return;
    var t = String(item.type || item.kind || "").toLowerCase();
    var kind = /video/.test(t) ? "video" : "image";
    var url = item.url || item.src || item.imageUrl || item.image_url || item.downloadUrl || item.uri || null;
    if (typeof item.image === "string") url = url || item.image;
    if (item.image && typeof item.image === "object") url = url || item.image.url || item.image.src;
    if (item.output && typeof item.output === "object") url = url || item.output.url || item.output.src;
    if (item.result && typeof item.result === "object") url = url || item.result.url || item.result.src;
    if (url) pushLaneMedia(L, url, kind);
    if (Array.isArray(item.images)) item.images.forEach(function (im) {
      if (typeof im === "string") pushLaneMedia(L, im, "image");
      else if (im && typeof im === "object") pushLaneMedia(L, im.url || im.src, "image");
    });
  }

  function ingestDataItems(result, L, val) {
    var items = Array.isArray(val) ? val : (val ? [val] : []);
    items.forEach(function (item) {
      if (!item || typeof item !== "object") return;
      if (item.type === "webdev" && item.event && item.event.type === "init" && Array.isArray(item.event.files)) {
        if (!result.workspaceFiles) result.workspaceFiles = [];
        item.event.files.forEach(function (f) {
          if (f && f.path) {
            result.workspaceFiles.push({
              path: f.path,
              contentType: f.contentType || null,
              content: typeof f.content === "string" ? f.content : null
            });
          }
        });
        return;
      }
      var t = String(item.type || item.kind || (item.event && item.event.type) || "").toLowerCase();
      if (/image|media|video|t2i|txt2img|img/.test(t) || item.imageUrl || item.image_url || item.image || isMediaUrl(item.url || item.src || "")) {
        ingestMediaItem(L, item);
        if (item.event && typeof item.event === "object") ingestMediaItem(L, item.event);
      }
    });
  }

  AE.applyBattleInit = function (parsed, init) {
    if (!parsed) parsed = { init: null, lanes: {}, prompt: null, modality: null };
    if (!init || typeof init !== "object") return parsed;
    parsed.init = Object.assign({}, init, parsed.init || {});
    if (!parsed.prompt && init.userMessage && typeof init.userMessage.content === "string") {
      parsed.prompt = init.userMessage.content;
    }
    if (!parsed.modality && typeof init.modality === "string") parsed.modality = init.modality;
    return parsed;
  };

  AE.isPlaceholderModel = function (name) {
    var t = String(name == null ? "" : name).replace(/\s+/g, " ").trim();
    if (!t) return true;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return true;
    return /^(?:response|model|assistant|lane|player|option)\s*[ab]$/i.test(t);
  };

  /* ---------- orchestrator model identification (agent mode) ----------
   * Agent Mode routes each session to a random model and does not reveal the
   * name in the UI. The wire traffic still carries model-shaped strings under
   * model-ish keys, so scan captured payloads for them and let the session
   * accumulate evidence. Conservative on purpose: a value only counts when
   * the KEY names a model field AND the VALUE looks like an internal model
   * slug (vendor token or dotted version slug). */
  var MODEL_FIELD_RE = /^(?:model|models|.*[_-]model|model[_-].*)$/i;
  var MODEL_SLUG_RE = /^[a-z0-9][a-z0-9._:@\/-]{2,88}[a-z0-9)]$/i;
  var VENDOR_TOKEN_RE = /(?:^|[._:-])(gpt|o[1345](?![a-z])|claude|opus|sonnet|haiku|gemini|grok|kimi|qwen|glm|deepseek|minimax|llama|mistral|nova|pixtral|phi|flux|dall)(?:[._:-]|$)/i;

  AE.scanForModelHints = function (data, out) {
    var found = out || {};
    var visits = 0;
    function note(value) {
      var t = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
      if (!MODEL_SLUG_RE.test(t)) return;
      if (AE.isPlaceholderModel(t)) return;
      if (!VENDOR_TOKEN_RE.test(t) && !/^[a-z0-9]+[-._][0-9]/i.test(t)) return;
      if (/^(?:unknown|none|null|default|auto|max)$/i.test(t)) return;
      found[t] = (found[t] || 0) + 1;
    }
    function walk(o) {
      if (!o || typeof o !== "object" || visits++ > 600) return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      Object.keys(o).forEach(function (k) {
        var v = o[k];
        if (typeof v === "string") {
          if (MODEL_FIELD_RE.test(k)) note(v);
        } else if (v && typeof v === "object") {
          walk(v);
        }
      });
    }
    walk(data);
    return found;
  };

  /* Evaluation request bodies are the only place the prior-turn context is
   * visible, and a whitelist of six scalars threw all of it away. Keep the
   * whole body minus secrets, with the known-huge fields summarised so a
   * multi-turn body still fits the per-request cap. */
  var EVAL_BODY_CAP = 24000;
  var EVAL_BULK_FIELD_RE = /^(recaptcha|captcha|attachments?|files?|images?|workspace)/i;

  AE.summarizeEvalRequest = function (body) {
    var raw = typeof body === "string" ? body : "";
    try {
      var o = typeof body === "string" ? JSON.parse(body) : body;
      if (!o || typeof o !== "object") return raw.slice(0, EVAL_BODY_CAP);
      var scrubbed = AE.scrubSecrets ? AE.scrubSecrets(o) : o;
      if (scrubbed && typeof scrubbed === "object" && !Array.isArray(scrubbed)) {
        Object.keys(scrubbed).forEach(function (k) {
          var v = scrubbed[k];
          if (!EVAL_BULK_FIELD_RE.test(k)) return;
          /* Keep evidence the field existed without carrying its payload. */
          if (Array.isArray(v)) scrubbed[k] = "[" + v.length + " items omitted]";
          else if (v && typeof v === "object") scrubbed[k] = "[object omitted]";
          else if (typeof v === "string" && v.length > 200) scrubbed[k] = "[" + v.length + " chars omitted]";
        });
      }
      var text = JSON.stringify(scrubbed);
      return text.length > EVAL_BODY_CAP ? text.slice(0, EVAL_BODY_CAP) : text;
    } catch (e) {
      return raw.slice(0, EVAL_BODY_CAP);
    }
  };

  /* Pull {url,title} citation objects out of a concatenated citation args stream. */
  function extractCitations(raw) {
    var out = [];
    var seen = {};
    var re = /"url"\s*:\s*"([^"]+)"|"title"\s*:\s*"([^"]*)"/g;
    var lastUrl = null;
    var m;
    while ((m = re.exec(raw))) {
      if (m[1] !== undefined) {
        if (!seen[m[1]]) { seen[m[1]] = { url: m[1], title: null }; out.push(seen[m[1]]); }
        lastUrl = m[1];
      } else if (m[2] !== undefined && lastUrl && seen[lastUrl] && !seen[lastUrl].title) {
        seen[lastUrl].title = m[2];
      }
    }
    return out;
  }
  /* ---------- attachment plumbing (ported from v1.4.0 fork) ---------- */

  /* Turn an artifact title into a safe filename, unique within `used`. */
  AE.attachmentSlug = function (title, used) {
    var base = String(title || "").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
    if (!base) base = "attachment";
    var ext = "";
    var mm = /(\.[a-zA-Z0-9]{1,10})$/.exec(base);
    if (mm) { ext = mm[1]; base = base.slice(0, -ext.length); }
    var name = base + ext;
    var n = 2;
    while (used && used[name]) name = base + "-" + (n++) + ext;
    if (used) used[name] = true;
    return name;
  };

  /* Record local attachment paths on artifact blocks after their bytes were
   * fetched from the page. `results` = [{url,title?,bytes,contentType?,ok,error?}].
   * Adds block.attachment {path,bytes,media_type,truncated}; keeps
   * content_or_url as provenance. Returns {saved,failed}. */
  AE.decorateAttachments = function (payload, results, dir) {
    var byUrl = {};
    (results || []).forEach(function (r) { if (r && r.url) byUrl[r.url] = r; });
    var used = {}, saved = [], failed = [];
    (payload.messages || []).forEach(function (m) {
      (m.content || []).forEach(function (b) {
        if (b.type !== "artifact" || !b.content_or_url) return;
        var r = byUrl[b.content_or_url];
        if (!r) return;
        if (!r.ok) { failed.push({ url: r.url, error: r.error || "fetch failed" }); return; }
        var name = AE.attachmentSlug(r.title || b.title || "attachment", used);
        b.attachment = {
          path: (dir || "attachments/") + name,
          bytes: r.bytes || 0,
          media_type: r.contentType || b.artifact_type || null,
          truncated: !!b.truncated
        };
        saved.push({ url: r.url, path: b.attachment.path, bytes: b.attachment.bytes });
      });
    });
    return { saved: saved, failed: failed };
  };

  /* Inline artifacts (data: URLs or raw HTML/srcdoc) need no fetch. Returns
   * {saved:[{path,dataUrl,bytes}], warnings:[...]}. */
  AE.decorateInlineArtifacts = function (payload, dir) {
    var used = {}, saved = [], warnings = [];
    (payload.messages || []).forEach(function (m) {
      (m.content || []).forEach(function (b) {
        if (b.type !== "artifact" || typeof b.content_or_url !== "string") return;
        var v = b.content_or_url;
        var isData = v.indexOf("data:") === 0;
        var dataUrl = isData ? v : (v.charAt(0) === "<" ? "data:text/html;charset=utf-8," + encodeURIComponent(v) : null);
        if (!dataUrl) return;
        var name = AE.attachmentSlug(b.title || "artifact", used);
        var bytes = isData ? Math.round((v.length * 3) / 4) : v.length;
        b.attachment = {
          path: (dir || "attachments/") + name,
          bytes: bytes,
          media_type: b.artifact_type || "text/html",
          inline: true,
          truncated: !!b.truncated
        };
        if (b.truncated) warnings.push((b.title || name) + " was saved truncated (DOM preview cap)");
        saved.push({ path: b.attachment.path, dataUrl: dataUrl, bytes: bytes });
      });
    });
    return { saved: saved, warnings: warnings };
  };
})();
