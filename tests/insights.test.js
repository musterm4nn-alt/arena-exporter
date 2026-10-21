"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { agentPayload, battlePayload } = require("./research-fixture");

const root = path.join(__dirname, "..");
const context = vm.createContext({ console, TextEncoder, TextDecoder, Uint8Array, Date, JSON, Number, String, Object, Array, URL });
for (const file of ["src/lib/research.js", "src/lib/insights.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
}
const AE = context.AE;

const agent = AE.research.buildRecord(JSON.stringify(agentPayload()), { updated_at: "2026-09-24T11:00:00.000Z" });
const battle = AE.research.buildRecord(JSON.stringify(battlePayload()), { updated_at: "2026-09-23T18:05:00.000Z" });
const old = AE.research.buildRecord(JSON.stringify(Object.assign(agentPayload(), {
  session: { conversation_key: "c:old-1", title: "Old chat" },
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  meta: { completeness: "full", warnings: [] }
})), { updated_at: "2024-01-15T09:00:00.000Z" });

const result = AE.insights([agent, battle, old], { now: new Date("2026-09-25T12:00:00.000Z") });
assert.equal(result.totals.conversations, 3);
assert.equal(result.totals.turns, 1 + 2 + 1);
assert.equal(result.totals.messages, 2 + 0 + 1);
assert.equal(result.totals.tool_calls, 1 + 1);
assert.equal(result.totals.files, 2);
assert.ok(result.totals.reasoning_chars > 0);
assert.ok(result.totals.payload_bytes > 0);

assert.equal(result.modes.find(m => m.mode === "agent").count, 2);
assert.equal(result.modes.find(m => m.mode === "battle").count, 1);

assert.equal(result.votes.ballots, 1);
assert.equal(result.votes.outcomes.a_wins, 1);
assert.equal(result.votes.outcomes.b_wins, 0);
assert.equal(result.votes.pending, 1);
assert.equal(result.votes.manual_votes, 1);

const alpha = result.models.find(m => m.name === "alpha-1");
const beta = result.models.find(m => m.name === "beta-1");
assert.equal(alpha.appearances, 2);
assert.equal(alpha.wins, 1);
assert.equal(alpha.verified, true);
assert.equal(beta.appearances, 2);
assert.equal(beta.wins, 0);

assert.equal(result.activity.months.length, 12);
assert.equal(result.activity.months.at(-1).month, "2026-09");
assert.equal(result.activity.months.at(-1).count, 2);
assert.equal(result.activity.earlier, 1);
assert.deepEqual(JSON.parse(JSON.stringify(result.tools[0])), { tool: "web_search", count: 2 });

assert.equal(result.completeness.find(c => c.status === "partial").count, 1);
assert.equal(result.completeness.find(c => c.status === "full").count, 2);

const empty = AE.insights([], { now: new Date("2026-09-25T12:00:00.000Z") });
assert.equal(empty.totals.conversations, 0);
assert.equal(empty.models.length, 0);
assert.equal(empty.activity.months.length, 12);
console.log("Insights passed: totals, modes, votes, model records, activity months, and tools.");
