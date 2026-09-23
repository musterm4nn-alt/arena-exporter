"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { worker } = require("./worker-harness");

const root = path.join(__dirname, "..");

function loadPrivacy() {
  const context = vm.createContext({ URL, URLSearchParams });
  vm.runInContext(fs.readFileSync(path.join(root, "src/lib/schema.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(root, "src/lib/privacy.js"), "utf8"), context);
  return context.AE;
}

(async () => {
  const AE = loadPrivacy();
  const privateKey = "-----BEGIN PRIVATE KEY-----\nDO_NOT_STORE\n-----END PRIVATE KEY-----";
  const nested = JSON.stringify({
    url: "https://alice:password@example.com/callback?access_token=secret&ok=1#refresh_token=hidden",
    github_token: "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
    deep: JSON.stringify({ authorization: "Bearer eyJabcdefgh.abc.def", private: privateKey })
  });
  const clean = AE.scrubSecrets({ wrapper: nested, safe: "keep me" });
  const serialized = JSON.stringify(clean);
  assert.equal(clean.safe, "keep me");
  assert.ok(!serialized.includes("password@"));
  assert.ok(!serialized.includes("github_pat_"));
  assert.ok(!serialized.includes("BEGIN PRIVATE KEY"));
  assert.ok(!serialized.includes("secret"));
  assert.ok(!serialized.includes("hidden"));

  const harmless = "https://example.com/docs?tab=api#section-2";
  assert.equal(AE.redactSecretText(harmless), harmless);
  assert.equal(AE.normalizeBattleOutcome("both_bad"), "neither_good");

  const w = worker();
  await w.ready();
  const session = w.context.freshState("c:overhaul-dedupe");
  const first = w.context.addMessage("assistant", session);
  const artifact = { type: "artifact", artifact_type: "text/plain", title: "same.txt", content_or_url: "same.txt", source: "network" };
  w.context.appendBlock(first, artifact);
  w.context.appendBlock(first, artifact);
  w.context.addMessage("user", session).content.push({ type: "text", text: "again" });
  const second = w.context.addMessage("assistant", session);
  w.context.appendBlock(second, artifact);
  assert.equal(first.content.filter(b => b.type === "artifact").length, 1);
  assert.equal(second.content.filter(b => b.type === "artifact").length, 1);

  const voteSession = w.context.freshState("c:overhaul-vote");
  voteSession.battleVotes.push({ choice: "neither_good", label: "Neither", source: "dom", url: "https://arena.ai/c/vote" });
  const dom = { url: "https://arena.ai/c/vote", battle: { models: ["A", "B"], vote: "Neither" } };
  const exportResult = w.context.buildExport("full_history", dom, voteSession);
  assert.equal(exportResult.payload.battles[0].outcome, "neither_good");

  const callbackData = {};
  const callbackOnlyArea = {
    get(keys, callback) { callback(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in callbackData).map(key => [key, callbackData[key]]))); },
    set(value, callback) { Object.assign(callbackData, JSON.parse(JSON.stringify(value))); callback(); }
  };
  const callbackWorker = worker({ local: callbackOnlyArea, session: callbackOnlyArea });
  await callbackWorker.ready();
  await callbackWorker.context.AE.preferencesReady;
  assert.equal((await callbackWorker.send({ type: "AE_SET_PREFERENCES", preferences: { autoArchive: false } }, null)).ok, true);
  assert.equal(callbackData.ae_preferences.autoArchive, false);

  console.log("Overhaul regressions passed: privacy URLs/secrets, message-scoped replay dedupe, canonical outcomes, and callback storage.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
