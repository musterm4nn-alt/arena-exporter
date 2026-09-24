"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const nodeCrypto = require("node:crypto");
const vm = require("node:vm");
const { worker } = require("./worker-harness");

const root = path.join(__dirname, "..");
function loadCrypto() {
  const context = vm.createContext({ crypto, TextEncoder, TextDecoder, Uint8Array, btoa, atob, Date, JSON });
  vm.runInContext(fs.readFileSync(path.join(root, "src/encrypted-archive.js"), "utf8"), context);
  return context.AE;
}
function decodeDownload(record) {
  const comma = record.url.indexOf(",");
  return decodeURIComponent(record.url.slice(comma + 1));
}

(async () => {
  const AE = loadCrypto();
  const password = "correct horse battery staple";
  const record = await AE.archiveEncryption.configure(password, true);
  assert.equal(record.enabled, true);
  assert.equal(record.version, 2);
  assert.equal(record.kdf, "PBKDF2-SHA-256-512");
  assert.ok(!JSON.stringify(record).includes(password));
  const derived = nodeCrypto.pbkdf2Sync(password, Buffer.from(record.salt, "base64"), record.iterations, 64, "sha256");
  assert.notEqual(record.verifier, derived.subarray(0, 32).toString("base64"), "persisted verifier must not be the AES key");
  const envelopeText = await AE.archiveEncryption.encryptFiles([
    { path: "conversation.json", encoding: "utf8", content: "{\"secret\":\"conversation text\"}" },
    { path: "files/blob.bin", encoding: "base64", content: "aGVsbG8=" }
  ]);
  assert.ok(!envelopeText.includes("conversation text"));
  const envelope = JSON.parse(envelopeText);
  const bundle = await AE.archiveEncryption.decryptEnvelope(envelope, password);
  assert.equal(bundle.files[0].content, "{\"secret\":\"conversation text\"}");
  await assert.rejects(() => AE.archiveEncryption.decryptEnvelope(envelope, record.verifier), /incorrect|decrypt|operation/i);
  const legacySalt = nodeCrypto.randomBytes(16), legacyKey = nodeCrypto.pbkdf2Sync(password, legacySalt, 310000, 32, "sha256");
  const legacyIv = nodeCrypto.randomBytes(12), legacyCipher = nodeCrypto.createCipheriv("aes-256-gcm", legacyKey, legacyIv);
  const legacyBody = Buffer.concat([legacyCipher.update(JSON.stringify({ format: "arena-encrypted-archive", version: 1, files: [{ path: "legacy.txt", encoding: "utf8", content: "legacy" }] }), "utf8"), legacyCipher.final()]);
  const legacyEnvelope = { format: "arena-encrypted-archive", version: 1, iterations: 310000, salt: legacySalt.toString("base64"), iv: legacyIv.toString("base64"), ciphertext: Buffer.concat([legacyBody, legacyCipher.getAuthTag()]).toString("base64") };
  assert.equal((await AE.archiveEncryption.decryptEnvelope(legacyEnvelope, password)).files[0].content, "legacy");
  AE.archiveEncryption.lock();
  await assert.rejects(() => AE.archiveEncryption.unlock("wrong password"), /incorrect/);
  assert.equal((await AE.archiveEncryption.unlock(password)).unlocked, true);
  const fingerprint = AE.archiveEncryption.fingerprint();
  await assert.rejects(() => AE.archiveEncryption.configure("new password", true), /current archive encryption/);
  await AE.archiveEncryption.configure(password, false);
  await AE.archiveEncryption.configure("new password with enough length", true);
  assert.notEqual(AE.archiveEncryption.fingerprint(), fingerprint);
  await assert.rejects(() => AE.archiveEncryption.decryptEnvelope(envelope, "wrong password"), /incorrect|decrypt|operation/i);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "arena-encryption-cli-"));
  const encryptedFile = path.join(temp, "conversation.enc");
  const recovered = path.join(temp, "recovered");
  fs.writeFileSync(encryptedFile, envelopeText, "utf8");
  const cli = spawnSync(process.execPath, [path.join(root, "tools/decrypt-archive.mjs"), encryptedFile, "--out", recovered], { cwd: root, encoding: "utf8", env: { ...process.env, ARENA_ARCHIVE_PASSWORD: password } });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.equal(fs.readFileSync(path.join(recovered, "conversation.json"), "utf8"), "{\"secret\":\"conversation text\"}");

  const w = worker();
  await w.ready();
  await w.context.AE.preferencesReady;
  const enabled = await w.send({ type: "AE_SET_ARCHIVE_ENCRYPTION", enabled: true, password }, null);
  assert.equal(enabled.ok, true);
  assert.equal(enabled.encryption.unlocked, true);
  assert.ok(!JSON.stringify(enabled.preferences).includes(record.verifier));
  const tab = { id: 77, url: "https://arena.ai/c/encrypted-fixture" };
  await w.event({ kind: "page_context", url: tab.url, conversationKey: "c:encrypted-fixture", title: "Encrypted" }, tab);
  await w.event({ kind: "json", url: "https://arena.ai/api/chat/encrypted-fixture", data: { role: "user", content: "secret prompt" } }, tab);
  const sync = await w.send({ type: "AE_SYNC", tabId: tab.id, sessionKey: "c:encrypted-fixture" }, null);
  assert.equal(sync.ok, true);
  const encryptedWrite = w.writes.find(item => /conversation\.enc$/.test(item.filename));
  assert.ok(encryptedWrite, "encrypted archive bundle was not written");
  assert.ok(!decodeDownload(encryptedWrite).includes("secret prompt"));
  assert.ok(!JSON.stringify(w.local._data).includes(password));
  const restarted = worker({ local: w.local, session: w.local });
  await restarted.ready();
  const restored = await restarted.send({ type: "AE_PREFERENCES" }, null);
  assert.equal(restored.encryption.enabled, true);
  assert.equal(restored.encryption.unlocked, false);

  const legacy = worker();
  await legacy.ready();
  const legacyTab = { id: 78, url: "https://arena.ai/c/plaintext-fixture" };
  await legacy.event({ kind: "page_context", url: legacyTab.url, conversationKey: "c:plaintext-fixture", title: "Plaintext" }, legacyTab);
  await legacy.event({ kind: "json", url: "https://arena.ai/api/chat/plaintext-fixture", data: { role: "user", content: "plain prompt" } }, legacyTab);
  const plainSync = await legacy.send({ type: "AE_SYNC", tabId: legacyTab.id, sessionKey: "c:plaintext-fixture" }, null);
  assert.equal(plainSync.ok, true);
  await legacy.send({ type: "AE_SET_ARCHIVE_ENCRYPTION", enabled: true, password }, null);
  await legacy.event({ kind: "json", url: "https://arena.ai/api/chat/plaintext-fixture", data: { role: "assistant", content: "plain answer" } }, legacyTab);
  const blocked = await legacy.send({ type: "AE_SYNC", tabId: legacyTab.id, sessionKey: "c:plaintext-fixture" }, null);
  assert.equal(blocked.ok, false);
  assert.match(blocked.sync.error, /plaintext archive files/);

  console.log("Encrypted archive tests passed: separate verifier/key derivation, persistence, unlock state, restart locking, migration refusal, sealed writes, and wrong-password rejection.");
})().catch(error => { console.error(error); process.exitCode = 1; });
