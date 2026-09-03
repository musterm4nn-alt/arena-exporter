/* Archive sink: folder pinning, unchanged-file skipping, failure retry,
 * and refusal to trust a rewritten target path.
 * Usage: node tests/archive-sink.test.js */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { fakeStorageArea, fakeDownloads, decodeWrite } = require("./fake-chrome");

const ROOT = path.join(__dirname, "..", "src");

function makeCtx(downloadOpts) {
  const writes = [];
  const ctx = {
    console, setTimeout, clearTimeout,
    JSON, Math, Date, Object, Array, String, Number, Set, Promise,
    encodeURIComponent, decodeURIComponent,
    crypto: globalThis.crypto,
    TextEncoder, TextDecoder,
    chrome: {
      runtime: { lastError: null },
      storage: { local: fakeStorageArea() },
      downloads: fakeDownloads(writes, downloadOpts)
    }
  };
  vm.createContext(ctx);
  for (const f of ["lib/schema.js", "archive-layout.js", "markdown.js", "downloads-sink.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx);
  }
  return { ctx, writes, AE: ctx.AE };
}

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.error("  ✗ " + name); }
}

function payloadFor(key, title, turns, models) {
  return {
    session: { conversation_key: key, session_id: key, title },
    export: { source: { url: "https://arena.ai/c/" + key } },
    battles: Array.from({ length: turns }, (_, i) => ({
      subtype: "text", index: i + 1,
      contestants: [{ lane: "A", model: models[0] }, { lane: "B", model: models[1] }]
    }))
  };
}

(async () => {
  console.log("Writes land under arena-archive with the right tree:");
  {
    const { AE, writes } = makeCtx();
    const p = payloadFor("c:abc123", "Mirror chat", 1, ["grok-4.5", "kimi-k3"]);
    const res = await AE.writeArchive(p, [
      { path: "conversation.json", content: '{"a":1}' },
      { path: "conversation.md", content: "# hi" },
      { path: "battle-01/A/response.md", content: "lane a" }
    ]);
    check("write reported ok", res.ok === true);
    check("rel is battle/text/<slug>", /^battle\/text\/mirror-chat--/.test(res.rel));
    check("all three files written", res.written.length === 3);
    const names = writes.map((w) => w.filename);
    check("paths prefixed with arena-archive", names.every((n) => n.indexOf("arena-archive/") === 0));
    check("nested lane path preserved", names.some((n) => /battle-01\/A\/response\.md$/.test(n)));
    check("index mirrored to disk", names.some((n) => n === "arena-archive/_index.json"));
    check("content survives the data: url round trip",
      writes.some((w) => decodeWrite(w) === '{"a":1}'));
  }

  console.log("Unchanged files are not rewritten:");
  {
    const { AE, writes } = makeCtx();
    const p = payloadFor("c:same", "Same", 1, ["m1", "m2"]);
    const files = [
      { path: "conversation.json", content: "{}" },
      { path: "battle-01/A/response.md", content: "unchanged" }
    ];
    await AE.writeArchive(p, files);
    const firstCount = writes.length;
    const second = await AE.writeArchive(p, files);
    check("second identical sync writes nothing new", writes.length === firstCount);
    check("all files reported skipped", second.skipped === 2 && second.written.length === 0);

    const changed = [
      { path: "conversation.json", content: "{}" },
      { path: "battle-01/A/response.md", content: "CHANGED" }
    ];
    const third = await AE.writeArchive(p, changed);
    check("only the changed file is rewritten",
      third.written.length === 1 && third.written[0] === "battle-01/A/response.md");
  }

  console.log("Folder is pinned on first write:");
  {
    const { AE } = makeCtx();
    const first = await AE.writeArchive(payloadFor("c:pin", "Original title", 1, ["m1", "m2"]),
      [{ path: "conversation.json", content: "{}" }]);
    const renamed = payloadFor("c:pin", "Completely different title", 2, ["m1", "m2"]);
    const second = await AE.writeArchive(renamed, [{ path: "conversation.json", content: "{ }" }]);
    check("folder does not follow the title", second.rel === first.rel);
    const index = await AE.archiveIndexLoad();
    check("turn count updated in place", index["c:pin"].turns === 2);
    check("models recorded", index["c:pin"].models.join(",") === "m1,m2");
    check("models_pending false once named", index["c:pin"].models_pending === false);
  }

  console.log("Conversation ids sharing a UUID prefix never share a folder:");
  {
    const { AE } = makeCtx();
    const keyA = "c:01a05e6e-983b-77ee-85cf-0eb6404eb8ad";
    const keyB = "c:01a05e6e-d1f2-7e76-9f89-826894685faf";
    const first = await AE.writeArchive(payloadFor(keyA, "Same title", 1, ["m1", "m2"]),
      [{ path: "conversation.json", content: "{}" }]);
    const second = await AE.writeArchive(payloadFor(keyB, "Same title", 1, ["m1", "m2"]),
      [{ path: "conversation.json", content: "{}" }]);
    check("same-prefix UUIDs have distinct rel paths", first.rel !== second.rel);
    check("first rel contains its full UUID", first.rel.endsWith("--01a05e6e-983b-77ee-85cf-0eb6404eb8ad"));
    check("second rel contains its full UUID", second.rel.endsWith("--01a05e6e-d1f2-7e76-9f89-826894685faf"));
  }

  console.log("A legacy colliding index entry is relocated on next sync:");
  {
    const { AE, writes } = makeCtx();
    const keyA = "c:01a05e6e-983b-77ee-85cf-0eb6404eb8ad";
    const keyB = "c:01a05e6e-d1f2-7e76-9f89-826894685faf";
    const legacyRel = "battle/text/chat--01a05e6e";
    await AE.archiveIndexSave({
      [keyA]: { rel: legacyRel, subtype: "text", hashes: { "conversation.json": "stale" } },
      [keyB]: { rel: legacyRel, subtype: "text", hashes: { "conversation.json": "stale" } }
    });
    const payload = payloadFor(keyA, "Legacy chat", 1, ["m1", "m2"]);
    const res = await AE.writeArchive(payload, [{ path: "conversation.json", content: "{}" }]);
    check("legacy collision moves off the shared path", res.rel !== legacyRel);
    check("legacy collision moves to its full-id path",
      res.rel.endsWith("--01a05e6e-983b-77ee-85cf-0eb6404eb8ad"));
    const conversationWrite = writes.find((w) =>
      w.filename === "arena-archive/" + res.rel + "/conversation.json");
    const archived = conversationWrite ? JSON.parse(decodeWrite(conversationWrite)) : null;
    check("relocated conversation metadata records the new path",
      archived && archived.archive && archived.archive.rel === res.rel);
  }

  console.log("Subtype is locked to the first battle:");
  {
    const { AE } = makeCtx();
    const first = payloadFor("c:sub", "Sub", 1, ["m1", "m2"]);
    await AE.writeArchive(first, [{ path: "conversation.json", content: "{}" }]);
    const later = payloadFor("c:sub", "Sub", 2, ["m1", "m2"]);
    later.battles[0].subtype = "code";
    const res = await AE.writeArchive(later, [{ path: "conversation.json", content: "{x}" }]);
    check("rel keeps the original subtype", res.rel.indexOf("battle/text/") === 0);
  }

  console.log("A failed write is retried, not marked clean:");
  {
    const { AE, writes } = makeCtx({ failPath: "battle-01/A/response.md" });
    const p = payloadFor("c:fail", "Fail", 1, ["m1", "m2"]);
    const files = [
      { path: "conversation.json", content: "{}" },
      { path: "battle-01/A/response.md", content: "will fail" }
    ];
    const first = await AE.writeArchive(p, files);
    check("failure surfaced", first.ok === false && first.failed.length === 1);
    const before = writes.length;
    const second = await AE.writeArchive(p, files);
    check("failed file attempted again", writes.length > before);
    check("succeeded file still skipped", second.skipped === 1);
  }

  console.log("A silently rewritten target is treated as failure:");
  {
    const writes = [];
    const ctx = {
      console, setTimeout, clearTimeout, JSON, Math, Date, Object, Array, String, Number, Set, Promise,
      encodeURIComponent, decodeURIComponent,
      crypto: globalThis.crypto,
      TextEncoder, TextDecoder,
      chrome: {
        runtime: { lastError: null },
        storage: { local: fakeStorageArea() },
        downloads: {
          // Reproduces the real symlink behaviour: reports "complete" but drops
          // the directory and writes to the Downloads root instead.
          download: (o, cb) => { writes.push(o.filename); cb(1); },
          search: (q, cb) => cb([{ id: 1, state: "complete", filename: "/fake/Downloads/response.md", error: null }]),
          erase: (q, cb) => cb([1]),
          setUiOptions: (o, cb) => cb && cb(),
          onChanged: { addListener: () => {} }
        }
      }
    };
    vm.createContext(ctx);
    for (const f of ["lib/schema.js", "archive-layout.js", "markdown.js", "downloads-sink.js"]) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx);
    }
    const res = await ctx.AE.writeArchiveFile("arena-archive/battle/text/x/battle-01/A/response.md", "body");
    check("path rewrite detected", res.ok === false && /rewrote the target path/.test(res.error || ""));
  }

  console.log("Path traversal is refused:");
  {
    const { AE, writes } = makeCtx();
    const res = await AE.writeArchiveFile("arena-archive/../../evil.txt", "nope");
    check("dot-dot write rejected", res.ok === false && /illegal path/.test(res.error || ""));
    check("no download issued", writes.length === 0);
    check("safeArchivePath strips traversal", AE.safeArchivePath("../etc/passwd") === null);
    check("safeArchivePath keeps nested lane path", AE.safeArchivePath("battle-01/A/response.md") === "battle-01/A/response.md");
  }

  console.log("Missing setUiOptions cannot suppress the download UI:");
  {
    const writes = [];
    const ctx = {
      console, setTimeout, clearTimeout, JSON, Math, Date, Object, Array, String, Number, Set, Promise,
      encodeURIComponent, decodeURIComponent,
      crypto: globalThis.crypto,
      TextEncoder, TextDecoder,
      chrome: {
        runtime: { lastError: null },
        storage: { local: fakeStorageArea() },
        downloads: {
          download: (o, cb) => { writes.push(o.filename); cb(1); },
          search: (q, cb) => cb([{ id: 1, state: "complete", filename: "/fake/Downloads/" + writes[writes.length - 1], error: null }]),
          erase: (q, cb) => cb([1]),
          onChanged: { addListener: () => {} }
        }
      }
    };
    vm.createContext(ctx);
    for (const f of ["lib/schema.js", "archive-layout.js", "markdown.js", "downloads-sink.js"]) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx);
    }
    const res = await ctx.AE.setSilentWrites(true);
    check("returns false when setUiOptions is missing", res === false);
  }

  console.log("Oversized conversation.json is slimmed, not dropped:");
  {
    const { AE } = makeCtx();
    const slim = AE.slimArchiveJson(JSON.stringify({
      session: { conversation_key: "c:x" },
      meta: {
        captured_requests: [{ body: "huge" }],
        stream_samples: ["x"],
        evaluation_streams: { a: "y" },
        endpoint_catalog: ["https://arena.ai/x"],
        completeness: "full"
      }
    }));
    const o = JSON.parse(slim);
    check("debug fields stripped", !o.meta.captured_requests && !o.meta.stream_samples && !o.meta.evaluation_streams && !o.meta.endpoint_catalog);
    check("completeness kept", o.meta.completeness === "full");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
