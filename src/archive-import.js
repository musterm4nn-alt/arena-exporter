AEUI.importArchive = async function (selected) {
  const files = Array.from(selected);
  const roots = files.filter(file => /^[^/]+\/(?:agent\/[^/]+|(?:battle|direct|side-by-side)\/[^/]+\/[^/]+)\/conversation\.json$/.test(file.webkitRelativePath));
  if (!roots.length) throw new Error("Select the whole arena-archive folder containing conversation.json files.");
  const indexFile = files.find(file => /^[^/]+\/_index\.json$/.test(file.webkitRelativePath));
  let index = {};
  if (indexFile) { try { index = JSON.parse(await indexFile.text()).chats || {}; } catch (_) { /* reconstruct entries below */ } }
  let count = 0;
  for (const root of roots) {
    const prefix = root.webkitRelativePath.replace(/conversation\.json$/, "");
    const rel = prefix.split("/").slice(1).join("/").replace(/\/$/, "");
    const payload = JSON.parse(await root.text());
    const session = payload.session || {};
    const key = session.conversation_key || session.session_id;
    if (!key) throw new Error("A selected conversation has no conversation identifier: " + rel);
    const group = files.filter(file => file.webkitRelativePath.startsWith(prefix));
    if (group.reduce((size, file) => size + file.size, 0) > 32 * 1024 * 1024) {
      throw new Error("This conversation exceeds the 32 MiB folder-import limit: " + rel);
    }
    const content = [];
    for (const file of group) {
      if (file.size > 32 * 1024 * 1024) throw new Error("A file exceeds the 32 MiB backup limit: " + file.name);
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      content.push({ path: file.webkitRelativePath.slice(prefix.length), encoding: "base64", content: btoa(binary) });
    }
    const entry = Object.assign({}, index[key] || {}, { rel,
      title: (index[key] && index[key].title) || session.title || "",
      updated_at: (index[key] && index[key].updated_at) || new Date(root.lastModified).toISOString() });
    const res = await AEUI.send({ type: "AE_GITHUB_IMPORT", key, rel, files: content, entry });
    if (!res || !res.ok) throw new Error(res && res.error || "Could not queue imported files.");
    AEUI.$("github-import-status").textContent = ++count + " of " + roots.length + " conversation(s) queued.";
  }
  AEUI.$("github-import-status").textContent = count + " conversation(s) queued. Backups will upload automatically; use Back up now to start immediately.";
}

