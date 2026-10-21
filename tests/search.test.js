"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { agentPayload, battlePayload } = require("./research-fixture");

const root = path.join(__dirname, "..");
const context = vm.createContext({ console, TextEncoder, TextDecoder, Uint8Array, Date, JSON, Number, String, Object, Array, URL });
for (const file of ["src/lib/research.js", "src/lib/search.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
}
const AE = context.AE;
const research = AE.research, search = AE.search;

function records() {
  const agent = research.buildRecord(JSON.stringify(agentPayload()), { updated_at: "2026-09-24T11:00:00.000Z" });
  const battle = research.buildRecord(JSON.stringify(battlePayload()), { updated_at: "2026-09-23T18:05:00.000Z" });
  const older = research.buildRecord(JSON.stringify(Object.assign(agentPayload(), {
    session: { conversation_key: "c:old-789", title: "Old notes on baking" },
    messages: [{ role: "user", content: [{ type: "text", text: "A sourdough starter schedule" }] }],
    meta: { completeness: "full", warnings: [] }
  })), { updated_at: "2026-01-02T09:00:00.000Z" });
  return [agent, battle, older];
}

const list = records();
const parsed = search.parse('"sourdough starter" -baking plan');
assert.equal(parsed.terms.join("|"), "plan");
assert.equal(parsed.excludes.join("|"), "baking");
assert.equal(parsed.phrases.join("|"), "sourdough starter");
assert.equal(search.parse("").empty, true);

let result = search.search(list, { query: "cottbus" });
assert.equal(result.total, 1);
assert.equal(result.results[0].key, "c:abc-123");
assert.ok(result.results[0].snippet.text.toLowerCase().includes("cottbus"));

result = search.search(list, { query: "SATURDAY" });
assert.equal(result.total, 1, "search is case-insensitive");

result = search.search(list, { query: "off" });
assert.equal(result.total, 0, "every positive term must match");

result = search.search(list, { query: "plan weekend" });
assert.equal(result.total, 1);

result = search.search(list, { query: '"sourdough starter"' });
assert.equal(result.total, 1, "a quoted phrase matches when every word is present in order");
result = search.search(list, { query: '"sourdough schedule"' });
assert.equal(result.total, 0, "a quoted phrase is required, not optional scoring");

result = search.search(list, { query: "tokio" });
assert.equal(result.total, 0, "reasoning and tool evidence are excluded by default");
result = search.search(list, { query: "tokio", scope: "all" });
assert.equal(result.total, 1);
assert.equal(result.results[0].snippet.field, "detail");

result = search.search(list, { mode: "battle" });
assert.equal(result.total, 1);
assert.equal(result.results[0].key, "c:def-456");

const captured = list.concat([
  Object.assign({}, list[1], { key: "c:direct-1", mode: "direct-battle", title: "Direct rust question" }),
  Object.assign({}, list[1], { key: "c:sbs-1", mode: "side_by_side", title: "Side rust question" })
]);
result = search.search(captured, { query: "ownership", mode: "direct" });
assert.equal(result.results.map(r => r.key).join("|"), "c:direct-1", "the Direct tab includes direct-battle content matches");
result = search.search(captured, { query: "ownership", mode: "side-by-side" });
assert.equal(result.results.map(r => r.key).join("|"), "c:sbs-1", "side-by-side spellings share one tab");
result = search.search(captured, { query: "ownership", mode: "battle" });
assert.equal(result.results.map(r => r.key).join("|"), "c:def-456", "Battle does not absorb direct or side-by-side records");
assert.equal(search.modeGroup("agent_in_mixed"), "agent");

result = search.search(list, { model: "alpha-1" });
assert.equal(result.total, 1);

result = search.search(list, { vote: "any" });
assert.equal(result.total, 1);
assert.equal(result.results[0].key, "c:def-456");
assert.equal(search.search(list, { vote: "none" }).total, 2);
assert.equal(search.search(list, { vote: "a_wins" }).total, 1);
assert.equal(search.search(list, { vote: "b_wins" }).total, 0);

result = search.search(list, { days: 7, now: Date.parse("2026-09-25T00:00:00.000Z") });
assert.equal(result.total, 2, "date filter keeps recent conversations only");

result = search.search(list, { sort: "title" });
assert.equal(result.results.map(r => r.key).join("|"), "c:old-789|c:abc-123|c:def-456");

result = search.search(list, { query: "ownership" });
assert.equal(result.total, 1);
assert.ok(result.results[0].score > 0);

result = search.search(list, { query: "cottbus", limit: 1 });
assert.equal(result.total, 1);
assert.equal(result.results.length, 1);

result = search.search(list, { query: "baking" });
assert.equal(result.total, 1, "title matches still work when no message text matches");

result = search.search(list, { query: "rust -alpha" });
assert.equal(result.total, 0, "excluded terms remove otherwise matching records");

result = search.search(list, { query: "-baking" });
assert.equal(result.total, 2, "an exclusion-only query still filters the library");


console.log("Search passed: phrases, exclusions, AND logic, scope, filters, sorting, snippets, and limits.");
