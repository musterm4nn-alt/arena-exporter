/* Regression tests for the code-quality fork overhaul: shared vote normalizer,
 * shared filename stamp, and source-dedupe guards.
 * Usage: node tests/code-quality.test.js */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

// Shared vote module in isolation.
{
  const context = vm.createContext({});
  vm.runInContext(read("src/lib/vote.js"), context);
  const AE = context.AE;
  assert.equal(typeof AE.normalizeVoteChoice, "function");
  assert.equal(AE.normalizeVoteChoice("A is better"), "A");
  assert.equal(AE.normalizeVoteChoice("B is better"), "B");
  assert.equal(AE.normalizeVoteChoice("Both are good"), "both_good");
  assert.equal(AE.normalizeVoteChoice("Neither"), "neither_good");
  assert.equal(AE.normalizeVoteChoice("  "), null);
  assert.equal(AE.normalizeBattleVoteChoice("A is better"), "A");
  assert.equal(context.normalizeVoteChoice("B is better"), "B");
  assert.equal(context.normalizeBattleVoteChoice("Neither"), "neither_good");
  assert.equal(AE.dom.normalizeVoteChoice, AE.normalizeVoteChoice);
  console.log("shared vote module passed: outcomes, aliases, and AE wiring.");
}

// DOM extractor consumes the shared global instead of a local copy.
{
  const context = vm.createContext({ console, Promise, setTimeout, clearTimeout, JSON, Object, Array, String });
  vm.runInContext(read("src/lib/vote.js"), context);
  vm.runInContext(read("src/lib/dom-extract.js"), context);
  assert.equal(context.AE.dom.normalizeVoteChoice, context.AE.normalizeVoteChoice);
  assert.equal(context.AE.dom.normalizeVoteChoice("Both are good"), "both_good");
  console.log("dom-extract shared-vote wiring passed.");
}

// Shared filename stamp format.
{
  const context = vm.createContext({});
  vm.runInContext(read("src/lib/format.js"), context);
  // NOTE: the Date must come from the context's own realm for instanceof.
  const stamp = vm.runInContext("AE.buildStamp(new Date(2026, 0, 2, 3, 4, 5))", context);
  assert.match(stamp, /^\d{8}-\d{6}$/);
  assert.equal(stamp, "20260102-030405");
  assert.match(context.AE.buildStamp(), /^\d{8}-\d{6}$/);
  console.log("shared stamp builder passed.");
}

// Dedupe guards: the implementations must live in exactly one place.
{
  const battles = read("src/battles.js");
  const dom = read("src/lib/dom-extract.js");
  const builder = read("src/export-builder.js");
  const router = read("src/message-router.js");
  assert.ok(!/function normalizeVoteChoice\s*\(/.test(battles), "battles.js must not define its own normalizer");
  assert.ok(!/function normalizeBattleVoteChoice\s*\(/.test(battles), "battles.js must not define its own normalizer");
  assert.ok(!/function normalizeVoteChoice\s*\(/.test(dom), "dom-extract.js must not define its own normalizer");
  assert.ok(!/function stamp\s*\(/.test(builder), "export-builder.js must not define its own stamp");
  assert.ok(!/function stamp\s*\(/.test(router), "message-router.js must not define its own stamp");
  assert.ok(router.includes("AE.buildStamp()"), "message-router.js must use the shared stamp");
  assert.ok(builder.includes("AE.buildStamp()"), "export-builder.js must use the shared stamp");
  console.log("dedupe guards passed: vote and stamp each defined once.");
}

// Diagnostics stay silent-safe where the issue recorder is absent
// (content worlds, older harnesses): no path may call it unguarded.
(async () => {
  const { worker } = require("./worker-harness");
  const w = worker();
  await w.ready();
  delete w.context.AE.recordIssue;
  const state = await w.send({ type: "AE_GET_STATE" }, null);
  assert.equal(state.ok, true);
  const exp = await w.send({ type: "AE_EXPORT", mode: "full_history", save: false }, null);
  assert.equal(exp.ok, true);
  await w.event({ kind: "interceptor_ready", url: "https://arena.ai/c/probe" });
  console.log("recordIssue-absent paths passed: state, export, and capture events stay silent-safe.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
