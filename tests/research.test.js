"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { agentPayload, battlePayload } = require("./research-fixture");

const root = path.join(__dirname, "..");

function library() {
  const context = vm.createContext({
    console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView,
    crypto: globalThis.crypto, URL, Date, JSON, Number, String, Object, Array
  });
  vm.runInContext(fs.readFileSync(path.join(root, "src/lib/research.js"), "utf8"), context);
  return context.AE.research;
}

(async () => {
  const research = library();
  const agentJson = JSON.stringify(agentPayload(), null, 2);
  const agent = research.buildRecord(agentJson, { updated_at: "2026-09-24T11:00:00.000Z", rel: "agent/cottbus--abc-123" });
  assert.equal(agent.key, "c:abc-123");
  assert.equal(agent.title, "Plan a weekend in Cottbus");
  assert.equal(agent.mode, "agent");
  assert.equal(agent.turns, 1);
  assert.equal(agent.updated_at, "2026-09-24T11:00:00.000Z");
  assert.equal(agent.rel, "agent/cottbus--abc-123");
  assert.equal(agent.counts.messages, 2);
  assert.equal(agent.counts.user_messages, 1);
  assert.equal(agent.counts.assistant_messages, 1);
  assert.equal(agent.counts.tool_calls, 1);
  assert.equal(agent.counts.thinking_blocks, 1);
  assert.ok(agent.counts.thinking_chars > 0);
  assert.ok(agent.text.includes("Saturday looks sunny"));
  assert.ok(!agent.text.includes("I should check the weather"), "reasoning stays out of the visible text index");
  assert.ok(agent.detail.includes("I should check the weather"));
  assert.ok(agent.detail.includes("web_search"));
  assert.equal(agent.warnings.join("|"), "An attachment download failed.");
  assert.equal(agent.files.length, 1);
  assert.equal(agent.files[0].name, "files/plan.md");
  assert.equal(agent.messages[1].blocks[3].content_omitted, true, "data URLs are never copied into the library");
  assert.equal(agent.payload_omitted, false);
  assert.ok(agent.payload_bytes > 0);

  const battle = research.buildRecord(JSON.stringify(battlePayload()), { updated_at: "2026-09-23T18:05:00.000Z" });
  assert.equal(battle.mode, "battle");
  assert.equal(battle.turns, 2);
  assert.equal(battle.models.join("|"), "alpha-1|beta-1");
  assert.equal(battle.models_pending, false);
  assert.equal(battle.vote_outcomes.join("|"), "a_wins");
  assert.equal(battle.battles[0].vote_source, "manual");
  assert.equal(battle.battles[0].contestants[0].verified, true);
  assert.equal(battle.battles[0].contestants[1].verified, false);
  assert.equal(battle.battles[0].contestants[0].tool_calls.length, 1);
  assert.equal(battle.files[0].lane, "A");
  assert.equal(battle.completeness, "partial");
  assert.ok(battle.text.includes("Alpha explains ownership"));
  assert.ok(battle.text.includes("Explain async Rust"));

  assert.throws(() => research.buildRecord("not json"), /valid JSON/);
  assert.throws(() => research.buildRecord(JSON.stringify({ messages: [] })), /identifier/);
  const noKey = agentPayload();
  delete noKey.session.conversation_key;
  delete noKey.session.session_id;
  assert.equal(research.keyOf(noKey), "c:abc-123", "the page URL is a fallback conversation key");

  const expected = crypto.createHash("sha256").update("utf8\n" + agentJson, "utf8").digest("hex");
  assert.equal(await research.archiveHash(agentJson), expected);
  assert.equal(await research.sha256("abc"), crypto.createHash("sha256").update("abc").digest("hex"));

  const injected = agentPayload();
  injected.messages[1].content.push({ type: "tool_call", tool_name: "probe", arguments: JSON.parse('{"__proto__":{"polluted":true},"safe":1}') });
  const projected = research.buildRecord(JSON.stringify(injected), {});
  const call = projected.messages[1].blocks.find(block => block.type === "tool_call" && block.tool_name === "probe");
  assert.equal(call.arguments.safe, 1);
  assert.equal({}.polluted, undefined, "tool argument keys cannot pollute Object.prototype");

  const huge = agentPayload();
  huge.messages[0].content[0].text = "x".repeat(4 * 1024 * 1024 + 100);
  const oversized = research.buildRecord(JSON.stringify(huge), {});
  assert.equal(oversized.payload_omitted, true, "oversized payloads keep a bounded record and no stored JSON");
  assert.ok(oversized.text.length <= research.LIMITS.textChars);

  assert.equal(agent.preview_truncated, false, "ordinary conversations keep their whole preview");
  assert.equal(battle.preview_truncated, false);

  // Many long messages: each block is under the per-block limit, but together
  // they used to produce a record larger than the payload it replaced.
  const long = agentPayload();
  long.messages = Array.from({ length: 50 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: [
      { type: "thinking", text: "t".repeat(1000) },
      { type: "tool_call", tool_name: "probe", arguments: { q: "a".repeat(7000) }, output: { r: "b".repeat(7000) } },
      { type: "text", text: "x".repeat(150000) }
    ]
  }));
  const longJson = JSON.stringify(long);
  const longRecord = research.buildRecord(longJson, {});
  assert.equal(longRecord.payload_omitted, true);
  assert.equal(longRecord.preview_truncated, true);
  const recordChars = JSON.stringify(longRecord).length;
  assert.ok(recordChars < longJson.length / 2, "the record is far smaller than the payload: " + recordChars);
  assert.ok(recordChars < research.LIMITS.previewChars + research.LIMITS.textChars + research.LIMITS.detailChars + 512 * 1024,
    "the record stays within the shared budget plus the search indexes: " + recordChars);
  assert.equal(longRecord.counts.messages, 50);
  assert.equal(longRecord.counts.blocks, 150, "skipped blocks still count toward totals");
  assert.equal(longRecord.counts.tool_calls, 50);
  assert.equal(longRecord.counts.thinking_blocks, 50);
  assert.equal(longRecord.counts.thinking_chars, 50000);
  assert.ok(longRecord.messages[0].blocks.length > 0, "the start of the conversation stays readable");

  // Thousands of tool calls: each call's JSON is capped at 8000 chars, which
  // alone multiplied out to tens of megabytes.
  const chatty = agentPayload();
  chatty.messages = [{ role: "assistant", content: Array.from({ length: 3000 }, () => (
    { type: "tool_call", tool_name: "probe", arguments: { q: "a".repeat(3000) }, output: { r: "b".repeat(3000) } }
  )) }];
  const chattyRecord = research.buildRecord(JSON.stringify(chatty), {});
  assert.equal(chattyRecord.preview_truncated, true);
  assert.equal(chattyRecord.counts.tool_calls, 3000);
  assert.ok(JSON.stringify(chattyRecord.messages).length < research.LIMITS.previewChars + 512 * 1024);

  // Battle texts draw from the same budget, while lanes, models and votes stay.
  const longBattle = battlePayload();
  longBattle.battles = Array.from({ length: 30 }, (_, i) => Object.assign({}, battlePayload().battles[0], {
    evaluation_id: "e-" + i,
    contestants: battlePayload().battles[0].contestants.map(c => Object.assign({}, c, { response: "r".repeat(100000) }))
  }));
  const battleRecord = research.buildRecord(JSON.stringify(longBattle), {});
  assert.equal(battleRecord.preview_truncated, true);
  assert.equal(battleRecord.battles.length, 30);
  assert.equal(battleRecord.turns, 30);
  assert.equal(battleRecord.models.join("|"), "alpha-1|beta-1", "models come from the last battle even past the budget");
  assert.equal(battleRecord.vote_outcomes.length, 30);
  assert.equal(battleRecord.battles[29].contestants[0].response, "", "late battle text is left to the archive");
  assert.ok(JSON.stringify(battleRecord.battles).length < research.LIMITS.previewChars + 512 * 1024);

  console.log("Research projection passed: agent/battle shapes, bounded evidence, keys, hashes, and size limits.");
})().catch(error => { console.error(error); process.exitCode = 1; });
