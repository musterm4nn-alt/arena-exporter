"use strict";
const assert = require("node:assert/strict");
const { worker } = require("./worker-harness");
const { fakeDownloads } = require("./fake-chrome");
(async () => {
  const writes = [], downloads = fakeDownloads(writes), actions = [];
  downloads.show = id => downloads.search({ id }, items => {
    assert.equal(items[0]?.state, "complete", "history retained until the file is revealed");
    actions.push("show");
  });
  const erase = downloads.erase;
  downloads.erase = (query, callback) => { actions.push("erase"); erase(query, callback); };
  const tab = { id: 9, url: "https://arena.ai/c/selected" };
  const w = worker({ tabs: [tab], downloads }); await w.ready();
  w.local._data.ae_archive_index = {
    "c:selected": { rel: "agent/selected", destinations: { "downloads:arena-archive": { updated_at: "2026-09-04" } } },
    "c:other": { rel: "agent/other" }
  };
  const request = { type: "AE_OPEN_FOLDER", tabId: 9, sessionKey: "c:selected" };
  assert.equal((await w.send(request, null)).ok, true);
  assert.match(writes[0].filename, /^arena-archive\/agent\/selected\//);
  assert.deepEqual(actions, ["show", "erase"]);
  assert.equal((await w.send({ ...request, sessionKey: "c:other" }, null)).ok, false);
  assert.equal((await w.send({ ...request, tabId: 10 }, null)).ok, false);
  assert.equal((await w.send(request, tab)).ok, false, "page content cannot open folders");
  assert.equal(writes.length, 1, "invalid requests cannot write or open a folder");
  tab.url = "https://elsewhere.test/c/selected";
  assert.equal((await w.send(request, null)).ok, false);
  tab.url = "https://arena.ai/c/selected";
  w.local._data.ae_archive_index["c:selected"].destinations = { "native:C:/archive": { updated_at: "2026-09-05" } };
  const native = await w.send(request, null);
  assert.equal(native.ok, false); assert.equal(native.path, "C:/archive/agent/selected");
  assert.equal(writes.length, 1, "never open a fake Downloads folder for native archives");
  // A rewritten destination must not be revealed as though it were the archive.
  const rewritten = fakeDownloads([]);
  rewritten.search = (_query, callback) => callback([{ state: "complete", filename: "/wrong/arena-archive/agent/selected/_open-folder.txt.extra" }]);
  rewritten.show = () => assert.fail("wrong folder was revealed");
  const wrong = worker({ downloads: rewritten }); await wrong.ready();
  const result = await wrong.context.AE.writeArchiveFile("arena-archive/agent/selected/_open-folder.txt", "marker", { reveal: true });
  assert.equal(result.ok, false);
  const denied = await w.send({ type: "AE_GITHUB_CONFIGURE", config: { token: "must not be saved" } }, tab);
  assert.equal(denied.ok, false);
  const popupDenied = await w.send({ type: "AE_GITHUB_CONFIGURE", config: { token: "must not be saved" } }, null);
  assert.equal(popupDenied.ok, false, "only settings may change credentials");
  console.log("Selected-tab folder routing, completion lifetime, native fallback and privileged request isolation passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
