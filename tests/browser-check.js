/* Only loaded by the test server, never included by an extension page. */
window.chrome = {
  runtime: { sendMessage(message, callback) {
    if (message.type === "AE_GITHUB_STATUS") return callback({ ok: true, enabled: false, connected: false, pending: 0, otherPending: 0 });
    if (message.type === "AE_ARCHIVE_INDEX") return callback({ ok: true, index: {} });
    if (message.type === "AE_NATIVE_STATUS") return callback({ state: "missing" });
    if (message.type === "AE_GITHUB_IMPORT") { window.importedFixture = message; return callback({ ok: true }); }
    callback({ ok: true });
  } },
  storage: { local: { get(_keys, callback) { callback({}); } } },
  permissions: { request(_permissions, callback) { callback(true); } }, downloads: {}
};
document.addEventListener("DOMContentLoaded", async () => {
  const output = document.createElement("p");
  output.id = "browser-check-result";
  document.body.prepend(output);
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  try {
    const first = { id: "browser-fixture", target: "fixture", revision: "one", files: [{ content: "old" }] };
    await AE.backupStore.put(first);
    await AE.backupStore.put({ ...first, revision: "two", files: [{ content: "new" }] });
    await AE.backupStore.acknowledge([first]);
    check((await AE.backupStore.counts()).fixture === 1, "queue metadata count is wrong");
    check((await AE.backupStore.list("other-target", 10)).length === 0, "reading one destination returned another's files");
    check((await AE.backupStore.list()).find(item => item.id === first.id)?.revision === "two", "old acknowledgement erased newer data");
    const script = document.createElement("script");
    script.src = "/src/backup-store.js";
    const loaded = new Promise((resolve, reject) => { script.onload = resolve; script.onerror = reject; });
    document.head.appendChild(script); await loaded;
    const restored = (await AE.backupStore.list()).find(item => item.id === first.id);
    check(restored?.files[0].content === "new", "snapshot did not survive a fresh database connection");
    await AE.backupStore.acknowledge([restored]);
    check(!(await AE.backupStore.list()).some(item => item.id === first.id), "successful upload acknowledgement was not removed");
    const file = new File([JSON.stringify({ session: { conversation_key: "c:fixture", title: "Imported sample" } })], "conversation.json");
    Object.defineProperty(file, "webkitRelativePath", { value: "arena-archive/agent/fixture/conversation.json" });
    await importArchive([file]);
    check(window.importedFixture.rel === "agent/fixture", "import lost conversation folder");
    check(JSON.parse(atob(window.importedFixture.files[0].content)).session.title === "Imported sample", "import changed file bytes");
    output.textContent = "PASS: real IndexedDB persistence, revision acknowledgement, and folder import.";
    output.style.color = "#5ddc7a";
  } catch (error) { output.textContent = "FAIL: " + error.message; output.style.color = "#ff6b6b"; }
});
