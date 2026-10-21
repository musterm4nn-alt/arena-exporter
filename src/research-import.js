/* Index an existing arena-archive folder into the local library.
 *
 * Only conversation.json is read. Attachments stay where they are; the archive
 * folder remains the source of truth and this is a bounded, searchable copy.
 */
AEUI.importResearch = async function (selected, onProgress) {
  const files = Array.from(selected || []);
  const candidates = files.filter(function (file) {
    const name = String(file.webkitRelativePath || file.name || "");
    return /(^|\/)conversation\.json$/i.test(name);
  });
  if (!candidates.length) {
    throw new Error("Choose the whole arena-archive folder: no plaintext conversation.json files were found. Encrypted conversation.enc bundles are not indexed.");
  }
  let imported = 0;
  const skipped = [];
  const batchSize = 6;
  for (let start = 0; start < candidates.length; start += batchSize) {
    const batch = candidates.slice(start, start + batchSize);
    const items = [];
    for (const file of batch) {
      const path = String(file.webkitRelativePath || file.name || "conversation.json");
      if (file.size > 4 * 1024 * 1024) {
        skipped.push({ path: path, reason: "larger than 4 MiB" });
        continue;
      }
      try {
        const text = await file.text();
        const parts = path.split("/").slice(0, -1);
        const root = parts.findIndex(function (part) { return /^(?:agent|battle|direct|side-by-side)$/i.test(part); });
        const rel = (root === -1 ? parts.slice(1) : parts.slice(root)).join("/");
        items.push({ path: path, text: text, rel: rel || null, lastModified: file.lastModified || null });
      } catch (error) {
        skipped.push({ path: path, reason: String(error.message || error) });
      }
    }
    if (items.length) {
      const result = await AEUI.send({ type: "AE_RESEARCH_IMPORT", items: items });
      if (!result || !result.ok) throw new Error(result && result.error || "The local library could not be updated.");
      imported += result.imported || 0;
      (result.skipped || []).forEach(function (item) { skipped.push(item); });
    }
    if (onProgress) onProgress(imported, candidates.length, skipped.length);
  }
  return { imported: imported, skipped: skipped, total: candidates.length };
};
