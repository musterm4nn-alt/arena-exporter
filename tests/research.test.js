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

  console.log("Research projection passed: agent/battle shapes, bounded evidence, keys, hashes, and size limits.");
})().catch(error => { console.error(error); process.exitCode = 1; });
