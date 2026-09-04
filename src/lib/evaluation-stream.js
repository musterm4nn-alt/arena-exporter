/* Direct uses one output lane. Accept the existing Arena lane protocol and
 * standard AI SDK data/UI streams, only when the captured request says Direct.
 * See https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol. */
var AE = AE || {};
AE.parseEvaluationStream = function (text, init) {
  var direct = init && /^(direct|direct-battle)$/.test(init.mode || "");
  if (!direct || !/^\s*(data:|event:|id:|:)/.test(text || "")) {
    return AE.parseBattleStream(text, { singleLane: !!direct });
  }
  var result = { init: null, lanes: {}, prompt: null, modality: null };
  var lane = { text: "", reasoning: "", finished: false, finishReason: null, citations: [], tools: [], toolNames: [], files: [] };
  var tools = {};
  function tool(chunk) {
    var id = chunk.toolCallId;
    if (!id) return null;
    if (!tools[id]) { tools[id] = { toolCallId: id, toolName: chunk.toolName || "unknown", args: null }; lane.tools.push(tools[id]); }
    if (chunk.toolName) tools[id].toolName = chunk.toolName;
    return tools[id];
  }
  String(text || "").replace(/\r\n?/g, "\n").split("\n\n").forEach(function (frame) {
    var raw = frame.split("\n").filter(function (line) { return line.indexOf("data:") === 0; })
      .map(function (line) { return line.slice(5).replace(/^ /, ""); }).join("\n");
    if (!raw) return;
    if (raw === "[DONE]") { if (result.lanes.a && !result.error) lane.finished = true; return; }
    var chunk;
    try { chunk = JSON.parse(raw); } catch (e) { return; }
    if (!chunk || typeof chunk.type !== "string") return;
    var t = chunk.type;
    if (t === "error") { result.error = chunk.errorText || "Stream error"; lane.finished = false; return; }
    if (t === "abort") { result.error = chunk.reason || "Stream aborted"; result.aborted = true; lane.finished = false; return; }
    if (t === "start") {
      result.init = Object.assign({}, init, chunk.messageId ? { modelAMessageId: chunk.messageId } : {});
    } else if (t === "text-delta") {
      lane.text += chunk.delta || "";
      result.lanes.a = lane;
    } else if (t === "reasoning-delta") {
      lane.reasoning += chunk.delta || "";
      result.lanes.a = lane;
    } else if (/^tool-(input|output)-/.test(t)) {
      var call = tool(chunk);
      if (!call) return;
      result.lanes.a = lane;
      if (t === "tool-input-delta") {
        call.inputText = (call.inputText || "") + (chunk.inputTextDelta || "");
        try { call.args = JSON.parse(call.inputText); } catch (e) { /* still streaming */ }
      }
      if (t === "tool-input-available") call.args = chunk.input;
      if (t === "tool-output-available") call.output = chunk.output;
      if (t === "tool-output-error") call.error = chunk.errorText;
    } else if (t === "source-url" && chunk.url) {
      lane.citations.push({ url: chunk.url, title: chunk.title || null });
      result.lanes.a = lane;
    } else if (t === "file" && chunk.url) {
      lane.files.push({ path: chunk.filename || "file", downloadUrl: chunk.url, contentType: chunk.mediaType || null });
      result.lanes.a = lane;
    } else if (t === "finish") {
      if (chunk.finishReason === "error") result.error = result.error || "Stream finished with an error";
      lane.finished = !result.error;
      lane.finishReason = chunk.finishReason || null;
      lane.metadata = AE.assistantMetadata(chunk);
    }
  });
  lane.toolNames = lane.tools.map(function (call) { return call.toolName; });
  return result;
};
