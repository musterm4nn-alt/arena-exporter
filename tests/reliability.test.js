"use strict";
const assert = require("node:assert/strict");
const { worker } = require("./worker-harness");
const { fakeStorageArea } = require("./fake-chrome");
const plain = value => JSON.parse(JSON.stringify(value));
const tab = (id, path) => ({ id, url: "https://arena.ai/" + path });
const watchdog = setTimeout(() => { console.error("Reliability test stalled"); process.exit(1); }, 10000);

(async () => {
  const w = worker();
  await w.ready();
  const a = tab(1, "agent/page-a"), b = tab(2, "agent");
  await w.event({ kind: "page_context", url: a.url, conversationKey: "c:page-a" }, a);
  await w.event({ kind: "json", url: a.url, data: { role: "user", content: "Alpha only" } }, a);
  await w.event({ kind: "json", url: b.url, data: { role: "user", content: "Beta only" } }, b);
  assert.equal(w.context.store.sessions["c:page-a"].messages.length, 1);
  assert.equal(w.context.store.tabKeys[2], "tab:2");
  assert.equal(w.context.store.sessions["tab:2"].messages[0].content[0].text, "Beta only");

  await w.event({ kind: "session_hint", sessionId: "transport-a", url: "https://arena.ai/ai-proxy/realtime/v1/sessions/transport-a/out" }, a);
  assert.equal(w.context.canonicalSessionKey("s:transport-a"), "c:page-a");
  assert.equal(w.context.store.sessions["c:page-a"].session.session_id, "page-a");
  assert.equal(w.context.store.sessions["c:page-a"].session.realtime_session_id, "transport-a");
  assert.equal((await w.export("s:transport-a")).session.conversation_key, "c:page-a");

  // A hint can precede the page's first conversation URL.
  await w.event({ kind: "session_hint", sessionId: "transport-b", url: "" }, b);
  const namedB = tab(2, "agent/page-b");
  await w.event({ kind: "page_context", url: namedB.url, conversationKey: "c:page-b" }, namedB);
  assert.equal(w.context.canonicalSessionKey("s:transport-b"), "c:page-b");
  assert.equal((await w.export("c:page-b")).messages[0].content[0].text, "Beta only");

  // Returning to the landing page must not resurrect an old placeholder alias.
  await w.event({ kind: "page_context", url: b.url }, b);
  await w.event({ kind: "json", url: b.url, data: { role: "user", content: "New chat" } }, b);
  assert.equal(w.context.store.tabKeys[2], "tab:2");
  assert.equal((await w.export("c:page-b")).messages.length, 1);
  assert.equal(w.context.store.sessions["tab:2"].messages[0].content[0].text, "New chat");

  // Responses keep their initiating page even after the tab has navigated.
  await w.event({ kind: "request", requestId: "pending-a", pageUrl: a.url, url: "https://arena.ai/api/chat/page-a", body: "{}" }, a);
  const movedA = tab(1, "agent/page-new");
  await w.event({ kind: "page_context", url: movedA.url, conversationKey: "c:page-new" }, movedA);
  await w.event({ kind: "json", requestId: "pending-a", pageUrl: a.url, url: "https://arena.ai/api/chat/page-a", data: { role: "assistant", content: "Late Alpha" } }, movedA);
  assert.equal(w.context.store.tabKeys[1], "c:page-new");
  assert.equal(w.context.store.sessions["c:page-new"].messages.length, 0);
  assert.ok(JSON.stringify(w.context.store.sessions["c:page-a"].messages).includes("Late Alpha"));

  // A delayed native-host probe must not change which session a popup receives.
  let releaseProbe;
  const probe = new Promise(resolve => { releaseProbe = resolve; });
  w.context.AE.nativeStatus = () => probe;
  const pendingState = w.send({ type: "AE_GET_STATE", sessionKey: "c:page-a" }, null);
  await Promise.resolve();
  await w.event({ kind: "json", url: namedB.url, data: { role: "user", content: "Other tab event" } }, namedB);
  releaseProbe({ state: "missing" });
  assert.equal((await pendingState).state.conversationKey, "c:page-a");

  // Navigation between requesting and receiving a DOM snapshot must not replace the old chat.
  const stale = worker({ snapshot: () => ({ source: "dom", url: "https://arena.ai/agent/replacement", title: "Wrong chat", messages: [
    { role: "assistant", content: [{ type: "text", text: "Wrong snapshot answer" }] }
  ] }) });
  await stale.ready();
  await stale.event({ kind: "json", url: a.url, data: { role: "user", content: "Original prompt" } }, a);
  const oldSession = stale.context.store.sessions["c:page-a"];
  const synced = await stale.context.runTurnSync("manual", "c:page-a", 1);
  assert.equal(synced.ok, true);
  assert.equal(oldSession.session.url, a.url);
  assert.notEqual(oldSession.session.title, "Wrong chat");
  assert.ok(!JSON.stringify(stale.writes).includes("Wrong snapshot answer"));

  // Native roots and Downloads each need their own first copy and index mirror.
  const sink = worker(); await sink.ready();
  const payload = { session: { conversation_key: "c:archive-a", title: "Archive A" }, export: { source: { mode: "agent" } }, messages: [], battles: [], meta: {} };
  const files = [{ path: "conversation.json", content: '{"capture":"same bytes"}', encoding: "utf8" }];
  assert.equal((await sink.context.AE.writeArchive(payload, files)).written.length, 1);
  const nativeWrites = [];
  let root = "/first-root";
  sink.context.AE.nativeConnect = async () => ({ ok: true, root,
    request: async (_op, message) => { nativeWrites.push({ root, files: plain(message.files) }); return { ok: true }; }, disconnect: () => {} });
  assert.equal((await sink.context.AE.writeArchiveNative(payload, files)).written.length, 1);
  root = "/second-root";
  assert.equal((await sink.context.AE.writeArchiveNative(payload, files)).written.length, 1);
  for (const expected of ["/first-root", "/second-root"]) {
    assert.ok(nativeWrites.some(write => write.root === expected && write.files.some(file => /conversation\.json$/.test(file.rel))));
    assert.ok(nativeWrites.some(write => write.root === expected && write.files.some(file => file.rel === sink.context.AE.ARCHIVE_INDEX)));
  }
  root = "/first-root";
  assert.equal((await sink.context.AE.writeArchiveNative(payload, files)).written.length, 0);
  assert.equal((await sink.context.AE.writeArchive(payload, files)).written.length, 0);

  // Real chrome.storage returns copies. Two concurrent transactions must retain both entries.
  const concurrent = worker(); await concurrent.ready();
  const options = {
    destinationKey: "test:concurrent", prefix: "",
    writeJobs: async jobs => { await new Promise(resolve => setTimeout(resolve, 3)); return { written: jobs, failed: [] }; },
    writeFile: async () => ({ ok: true })
  };
  const other = { ...payload, session: { conversation_key: "c:archive-b", title: "Archive B" } };
  const results = await Promise.all([concurrent.context.AE.writeArchive(payload, files, options), concurrent.context.AE.writeArchive(other, files, options)]);
  assert.ok(results.every(result => result.ok));
  const index = await concurrent.context.AE.archiveIndexLoad();
  assert.deepEqual(Object.keys(index).sort(), ["c:archive-a", "c:archive-b"]);

  // Failure remains visible, and an index mirror is retried even when files are unchanged.
  let mirrorFails = true;
  const failedMirror = { ...options, destinationKey: "test:mirror", writeFile: async () => ({ ok: !mirrorFails, error: mirrorFails ? "disk full" : null }) };
  assert.equal((await concurrent.context.AE.writeArchive(payload, files, failedMirror)).ok, false);
  mirrorFails = false;
  assert.equal((await concurrent.context.AE.writeArchive(payload, files, failedMirror)).ok, true);

  const local = fakeStorageArea();
  const broken = worker({ local }); await broken.ready();
  local.set = (_value, callback) => {
    broken.context.chrome.runtime.lastError = { message: "quota exceeded" };
    callback();
    broken.context.chrome.runtime.lastError = null;
  };
  assert.equal((await broken.context.AE.writeArchive(payload, files, options)).ok, false);
  console.log("Session isolation, async popup state, destination changes and concurrent archive writes passed");
  clearTimeout(watchdog);
})().catch(error => { clearTimeout(watchdog); console.error(error); process.exitCode = 1; });
