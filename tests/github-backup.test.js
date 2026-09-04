"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path"), crypto = require("node:crypto");
const { fakeStorageArea } = require("./fake-chrome");
const copy = value => JSON.parse(JSON.stringify(value));
const hash = bytes => crypto.createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex");

function fakeGit() {
  let sequence = 0, head = "head0", tree = {};
  const blobs = new Map(), trees = new Map([["tree0", {}]]), commits = new Map([[head, { tree: { sha: "tree0" } }]]);
  const server = { calls: [], private: true, fail: false, conflict: false, onPush: null, denied: false, truncated: false };
  const addBlob = bytes => { const sha = hash(bytes); blobs.set(sha, bytes); return sha; };
  const advance = () => {
    const treeSha = "tree" + ++sequence;
    trees.set(treeSha, copy(tree));
    head = "head" + sequence;
    commits.set(head, { tree: { sha: treeSha } });
  };
  server.seed = (name, text) => { tree[name] = { sha: addBlob(Buffer.from(text)), type: "blob", mode: "100644" }; advance(); };
  server.read = name => blobs.get(tree[name]?.sha)?.toString();
  server.fetch = async (url, options) => {
    assert.ok(url.startsWith("https://api.github.com/repos/person/"));
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.equal(options.headers.Authorization, "Bearer test-secret-credential");
    const route = new URL(url).pathname.replace(/^\/repos\/person\/[^/]+/, "");
    const body = options.body && JSON.parse(options.body);
    server.calls.push({ route, method: options.method, body });
    const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => copy(data), headers: { get: () => null } });
    if (server.fail) throw new Error("offline");
    if (server.denied) return reply({}, 401);
    if (!route) return reply({ private: server.private, permissions: { push: true }, default_branch: "main", size: 1 });
    if (route === "/git/ref/heads/main") return reply({ object: { sha: head } });
    if (route.startsWith("/git/commits/") && options.method === "GET") return reply(commits.get(route.split("/").pop()));
    if (route.startsWith("/git/trees/") && options.method === "GET") {
      const result = trees.get(route.split("/").pop());
      return reply({ tree: Object.entries(result).map(([path, value]) => ({ path, ...value })), truncated: server.truncated });
    }
    if (route.startsWith("/git/blobs/") && options.method === "GET") return reply({ encoding: "base64", content: blobs.get(route.split("/").pop()).toString("base64") });
    if (route === "/git/blobs") {
      const sha = addBlob(Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8"));
      return reply({ sha }, 201);
    }
    if (route === "/git/trees") {
      const next = copy(trees.get(body.base_tree));
      body.tree.forEach(item => { const { path, ...node } = item; next[path] = node; });
      const sha = "tree" + ++sequence; trees.set(sha, next); return reply({ sha }, 201);
    }
    if (route === "/git/commits") {
      const sha = "head" + ++sequence; commits.set(sha, { tree: { sha: body.tree }, parents: body.parents }); return reply({ sha }, 201);
    }
    if (route === "/git/refs/heads/main") {
      assert.equal(body.force, false);
      if (server.onPush) { const hook = server.onPush; server.onPush = null; await hook(); }
      if (server.conflict) {
        server.conflict = false;
        server.seed("unrelated.txt", "concurrent change");
        const index = JSON.parse(server.read("arena-archive/_index.json") || '{"version":1,"chats":{}}');
        index.chats.otherDevice = { rel: "agent/other", title: "another device" };
        server.seed("arena-archive/_index.json", JSON.stringify(index));
        return reply({}, 422);
      }
      const commit = commits.get(body.sha);
      if (commit.parents[0] !== head) return reply({}, 422);
      head = body.sha; tree = copy(trees.get(commit.tree.sha));
      return reply({ object: { sha: head } });
    }
    throw new Error("Unexpected mock endpoint " + route);
  };
  return server;
}
function environment(server, saved = {}) {
  const local = saved.local || fakeStorageArea(), records = saved.records || new Map(), alarms = [];
  const store = {
    list: async (target, limit = 10) => copy([...records.values()].filter(item => !target || item.target === target).slice(0, limit)),
    counts: async () => [...records.values()].reduce((counts, item) => { counts[item.target] = (counts[item.target] || 0) + 1; return counts; }, {}),
    put: async item => records.set(item.id, copy(item)),
    acknowledge: async items => items.forEach(item => { if (records.get(item.id)?.revision === item.revision) records.delete(item.id); })
  };
  const context = vm.createContext({
    console, setTimeout, clearTimeout, TextEncoder, TextDecoder, Uint8Array, AbortController,
    crypto: globalThis.crypto, btoa, atob, fetch: server.fetch,
    chrome: { runtime: {}, storage: { local }, alarms: {
      onAlarm: { addListener: fn => alarms.push(fn) }, get: (_name, cb) => cb({}), create: () => {}
    } }
  });
  for (const file of ["native-sink.js", "github-backup.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "../src", file), "utf8"), context);
  context.AE.backupStore = store;
  return { api: context.AE, context, local, records, alarms };
}
const configuration = { repo: "person/arena-archive", token: "test-secret-credential", folder: "arena-archive" };
async function enqueue(env, text = "latest turn") {
  return env.api.githubEnqueue("c:one", "agent/one", [
    { path: "conversation.json", content: JSON.stringify({ text }) },
    { path: "attachments/a.bin", content: "data:application/octet-stream;base64,AAEC/w==" }
  ], { rel: "agent/one", title: "One" });
}
(async () => {
  const git = fakeGit();
  git.seed("README.md", "Keep this file.");
  let env = environment(git);
  assert.equal((await enqueue(env)).queued, false, "backups off by default");
  git.private = false;
  await assert.rejects(env.api.githubConfigure(configuration), /private/);
  git.private = true;
  const configured = await env.api.githubConfigure(configuration);
  assert.equal(configured.enabled, true);
  assert.ok(!JSON.stringify(configured).includes(configuration.token), "status never returns credential");
  await assert.rejects(env.api.githubEnqueue("bad", "../escape", [], {}), /path/);
  await assert.rejects(env.api.githubEnqueue("bad", "agent/fine", [{ path: "../escape", content: "no" }], {}), /path/);
  await enqueue(env, "first"); await enqueue(env, "latest");
  assert.equal(env.records.size, 1, "coalesce per conversation");
  assert.ok(!JSON.stringify([...env.records.values()]).includes(configuration.token));
  git.fail = true;
  const offline = await env.api.githubFlush(true);
  assert.equal(offline.pending, 1); assert.match(offline.error, /could not be reached/);
  env = environment(git, env); // fresh worker, same durable state
  git.fail = false; git.conflict = true;
  const completed = await env.api.githubFlush(true);
  assert.equal(completed.pending, 0); assert.ok(completed.lastSuccess); assert.equal(completed.error, null);
  assert.equal(git.read("arena-archive/agent/one/conversation.json"), '{"text":"latest"}');
  assert.equal(git.read("README.md"), "Keep this file.");
  assert.equal(git.read("unrelated.txt"), "concurrent change");
  assert.ok(JSON.parse(git.read("arena-archive/_index.json")).chats.otherDevice, "merge concurrent archive index entries");
  const postCount = git.calls.filter(call => call.method !== "GET").length;
  await enqueue(env, "latest"); await env.api.githubFlush(true);
  assert.equal(git.calls.filter(call => call.method !== "GET").length, postCount, "unchanged snapshots require no commit");
  await enqueue(env, "upload in progress");
  git.onPush = () => enqueue(env, "newer captured turn");
  assert.equal((await env.api.githubFlush(true)).pending, 1, "upload must not acknowledge a newer queued revision");
  await env.api.githubFlush(true);
  assert.match(git.read("arena-archive/agent/one/conversation.json"), /newer captured turn/);
  await enqueue(env);
  git.private = false;
  const callCount = git.calls.length;
  assert.match((await env.api.githubFlush(true)).error, /private/);
  assert.equal(git.calls.length, callCount + 1, "stop before uploading files when repository becomes public");
  git.private = true;
  await env.api.githubConfigure({ ...configuration, repo: "person/other-archive" });
  const switched = await env.api.githubFlush(true);
  assert.equal(switched.pending, 0); assert.equal(switched.otherPending, 1, "old queue cannot be redirected to a new destination");
  await env.api.githubConfigure(configuration);
  git.denied = true;
  assert.match((await env.api.githubFlush(true)).error, /token expired/);
  git.denied = false; git.truncated = true;
  assert.match((await env.api.githubFlush(true)).error, /too large/);
  git.truncated = false;
  await env.api.githubPause(true);
  const pausedCount = git.calls.length;
  assert.equal((await env.api.githubFlush(true)).pending, 1);
  assert.equal(git.calls.length, pausedCount);
  assert.ok(!JSON.stringify(env.local._data).includes(configuration.token), "disconnect removes saved credential, preserves outbox");
  await env.api.githubConfigure(configuration);
  env.context.browser = { permissions: { getAll: async () => ({ data_collection: [] }) } };
  const consentCount = git.calls.length;
  assert.match((await env.api.githubFlush(true)).error, /permissions/);
  assert.equal(git.calls.length, consentCount, "revoking Firefox data permission stops network calls");
  console.log("Durable retry, coalescing, revision acknowledgement, credentials, privacy, permissions, conflicts and remote preservation passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
