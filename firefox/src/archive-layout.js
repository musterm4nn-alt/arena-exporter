/* Folder taxonomy for the on-disk archive. Pure functions; no I/O. */

var AE = AE || {};

AE.ARCHIVE_INDEX = "_index.json";

AE.safeArchivePath = function (rel) {
  const p = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!p || /[\x00-\x1f]/.test(p)) return null;
  const parts = p.split("/");
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i] || parts[i] === ".") continue;
    if (parts[i] === "..") return null;
    out.push(parts[i]);
  }
  return out.length ? out.join("/") : null;
};

/* Keep the complete Arena conversation id in the folder name. Arena uses
 * time-ordered UUIDs, so nearby chats commonly share their first eight
 * characters; truncating at that boundary makes unrelated chats overwrite
 * one another. */
AE.archiveId = function (key) {
  return String(key || "")
    .replace(/^c:|^s:/, "")
    .replace(/[^a-zA-Z0-9-]/g, "");
};

AE.slugify = function (title, conversationId) {
  let base = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (!base) base = "chat";
  const id = AE.archiveId(conversationId);
  return id ? base + "--" + id : base;
};

AE.inferMediaSubtype = function (payload) {
  let image = false, video = false;
  function consider(f) {
    if (!f) return;
    const path = String(f.path || f.archive_path || f.title || f.filename || "");
    const ct = String(f.contentType || f.media_type || f.mimeType || "");
    if (/^video\//i.test(ct) || /\.(mp4|webm|mov)$/i.test(path)) video = true;
    else if (/^image\//i.test(ct) || /\.(png|jpe?g|webp|gif|avif|svg)$/i.test(path)) image = true;
  }
  ((payload && payload.battles) || []).forEach(function (b) {
    (b.contestants || []).forEach(function (c) {
      (c.files || []).forEach(consider);
    });
  });
  if (video) return "video";
  if (image) return "image";
  return null;
};

AE.applyHonestSubtype = function (payload) {
  payload = payload || {};
  const inferred = AE.inferMediaSubtype(payload);
  if (!inferred) return payload;
  (payload.battles || []).forEach(function (b) {
    if (!b) return;
    const cur = String(b.subtype || "text");
    if (cur === "text" || cur === "image" || cur === "video" || !cur) b.subtype = inferred;
  });
  return payload;
};

AE.firstBattleSubtype = function (payload) {
  const battles = (payload && payload.battles) || [];
  if (!battles.length) return null;
  const inferred = AE.inferMediaSubtype(payload);
  const sub = battles[0].subtype || "text";
  if (inferred === "image" || inferred === "video") {
    if (sub === "text" || sub === "image" || sub === "video" || !sub) return inferred;
  }
  if (sub === "web-search" || sub === "web_search") return "web-search";
  if (sub === "webdev") return "code";
  if (sub === "image" || sub === "video" || sub === "code" || sub === "text") return sub;
  return "text";
};

AE.archiveRelFor = function (payload, existingRel) {
  if (existingRel) {
    const locked = AE.safeArchivePath(existingRel);
    if (locked) return locked;
  }
  const battles = (payload && payload.battles) || [];
  const session = (payload && payload.session) || {};
  const key = session.conversation_key || session.session_id || "unknown";
  const conversationId = AE.archiveId(key);
  const title = session.title || (battles[0] && battles[0].prompt) || "chat";
  const slug = AE.slugify(title, conversationId);
  const mode = payload && payload.export && payload.export.source && payload.export.source.mode || "";
  if (/^direct/.test(mode)) return "direct/" + (AE.firstBattleSubtype(payload) || "text") + "/" + slug;
  if (mode === "side-by-side") return "side-by-side/" + (AE.firstBattleSubtype(payload) || "text") + "/" + slug;
  if (!battles.length) return "agent/" + slug;
  const sub = AE.firstBattleSubtype(payload);
  return "battle/" + sub + "/" + slug;
};

AE.padBattleIndex = function (n) {
  return n < 10 ? "0" + n : String(n);
};

function archiveFileName(f, fallback) {
  let raw = (f && (f.path || f.title || f.filename)) || fallback || "file";
  raw = String(raw).replace(/\\/g, "/").replace(/^\/+/, "");
  if (/\.(png|jpe?g|webp|gif|avif|svg|mp4|webm|mov)(\?|$)/i.test(raw) || /^image\//i.test(String((f && f.contentType) || ""))) {
    raw = raw.split("/").pop();
  }
  const name = AE.safeArchivePath(raw);
  return name || AE.safeArchivePath(String(fallback || "file")) || "file";
}

AE.decorateArchivePaths = function (payload, existingRel) {
  payload = payload || {};
  const rel = AE.archiveRelFor(payload, existingRel);
  payload.archive = {
    rel: rel,
    conversation_json: "conversation.json",
    conversation_md: "conversation.md"
  };
  (payload.battles || []).forEach(function (b, i) {
    const idx = i + 1;
    const dir = "battle-" + AE.padBattleIndex(idx);
    b.index = idx;
    b.dir = dir;
    (b.contestants || []).forEach(function (c) {
      if (!c || !c.lane) return;
      c.dir = dir + "/" + c.lane;
      c.response_file = c.dir + "/response.md";
      (c.files || []).forEach(function (f) {
        if (!f || typeof f !== "object") return;
        const name = archiveFileName(f, "file");
        if (!name) return;
        f.archive_path = c.dir + "/" + name;
      });
    });
    (b.workspace_files || []).forEach(function (f) {
      if (!f || typeof f !== "object") return;
      const name = archiveFileName(f, "file");
      if (!name) return;
      f.archive_path = dir + "/workspace/" + name;
    });
  });
  if (!(payload.battles || []).length) {
    (payload.messages || []).forEach(function (m) {
      (m.content || []).forEach(function (block) {
        if (!block || block.type !== "artifact") return;
        const name = archiveFileName(block, "artifact");
        if (!name) return;
        block.archive_path = "files/" + name;
      });
    });
  }
  (payload.agent_files || []).forEach(function (f) {
    if (!f || typeof f !== "object") return;
    if (f.archive_path) return;
    const name = archiveFileName(f, "file");
    f.archive_path = name === "workspace.zip" ? "workspace.zip" : "files/" + name;
  });
  return payload;
};

AE.ARCHIVE_FILE_CAP = 50;
AE.ARCHIVE_JSON_CONTENT_CAP = 200000;

AE.fileHasBytes = function (f) {
  if (!f || typeof f !== "object") return false;
  if (typeof f.content === "string" && f.content.length) return true;
  if (typeof f.dataUrl === "string" && f.dataUrl.indexOf("data:") === 0) return true;
  const v = f.content_or_url;
  if (typeof v === "string" && v.length) {
    if (v.indexOf("data:") === 0) return true;
    if (v.charAt(0) === "<") return true;
  }
  return false;
};

AE.fileUrlOf = function (f) {
  if (!f || typeof f !== "object") return null;
  if (typeof f.url === "string" && /^(https?:|blob:)/i.test(f.url)) return f.url;
  if (typeof f.downloadUrl === "string" && /^(https?:|blob:)/i.test(f.downloadUrl)) return f.downloadUrl;
  if (typeof f.content_or_url === "string" && /^(https?:|blob:)/i.test(f.content_or_url)) return f.content_or_url;
  return null;
};

AE.bytesToWrite = function (f) {
  if (!f) return null;
  if (typeof f.content === "string" && f.content.length) return f.content;
  if (typeof f.dataUrl === "string" && f.dataUrl.indexOf("data:") === 0) return f.dataUrl;
  const v = f.content_or_url;
  if (typeof v !== "string" || !v.length) return null;
  if (v.indexOf("data:") === 0) return v;
  if (v.charAt(0) === "<") return v;
  return null;
};

AE.walkArchiveFiles = function (payload, fn) {
  if (!payload || typeof fn !== "function") return;
  (payload.battles || []).forEach(function (b) {
    (b.contestants || []).forEach(function (c) {
      (c.files || []).forEach(function (f) { if (f) fn(f, { kind: "contestant", battle: b, contestant: c }); });
    });
    (b.workspace_files || []).forEach(function (f) { if (f) fn(f, { kind: "workspace", battle: b }); });
  });
  (payload.messages || []).forEach(function (m) {
    (m.content || []).forEach(function (block) {
      if (block && block.type === "artifact") fn(block, { kind: "artifact", message: m });
    });
  });
  (payload.agent_files || []).forEach(function (f) { if (f) fn(f, { kind: "agent" }); });
};

AE.isFetchableArchiveUrl = function (url) {
  try {
    const u = new URL(String(url), "https://arena.ai/");
    if (u.protocol === "blob:") return true;
    if (u.protocol !== "https:") return false;
    if (/^([a-z0-9-]+\.)*(arena\.ai|lmarena\.ai)$/i.test(u.hostname)) return true;
    if (/(^|\.)r2\.dev$/i.test(u.hostname)) return true;
    if (/(^|\.)r2\.cloudflarestorage\.com$/i.test(u.hostname)) return true;
    return false;
  } catch (e) {
    return false;
  }
};

AE.agentWorkspaceZipUrl = function (payload) {
  if (!payload) return null;
  const mode = payload.export && payload.export.source && payload.export.source.mode;
  if (mode && mode !== "agent") return null;
  if ((payload.battles || []).length) return null;
  const url = (payload.session && payload.session.url) ||
    (payload.export && payload.export.source && payload.export.source.url) || "";
  let id = null;
  const m = /\/api\/chat\/([0-9a-fA-F-]{8,})/i.exec(url);
  if (m) id = m[1];
  if (!id) {
    let key = (payload.session && (payload.session.session_id || payload.session.conversation_key)) || "";
    key = String(key).replace(/^s:|^c:/, "");
    if (/^[0-9a-fA-F-]{8,}$/.test(key)) id = key;
  }
  if (!id) return null;
  let origin = "https://arena.ai";
  try { if (url && /^https?:/i.test(url)) origin = new URL(url).origin; } catch (e) { /* keep default */ }
  return origin + (/\/agent\//.test(url) ? "/agent/" : "/api/chat/") + id + "/download-workspace";
};

AE.collectArtifactUrls = function (payload, cap) {
  cap = cap == null ? AE.ARCHIVE_FILE_CAP : cap;
  const seen = {};
  const out = [];
  AE.walkArchiveFiles(payload, function (f) {
    if (out.length >= cap) return;
    if (AE.fileHasBytes(f)) return;
    const u = AE.fileUrlOf(f);
    if (!u || seen[u]) return;
    if (!AE.isFetchableArchiveUrl(u)) return;
    seen[u] = true;
    out.push(u);
  });
  const zip = AE.agentWorkspaceZipUrl(payload);
  if (zip && !seen[zip] && out.length < cap) out.push(zip);
  return out;
};

AE.listUrlOnlyFiles = function (payload) {
  const out = [];
  AE.walkArchiveFiles(payload, function (f) {
    if (AE.fileHasBytes(f)) return;
    const u = AE.fileUrlOf(f);
    if (!u) return;
    out.push({
      path: f.archive_path || f.path || f.title || u,
      url: u
    });
  });
  return out;
};

AE.decodeArchiveDataUrl = function (dataUrl, contentType) {
  if (typeof dataUrl !== "string" || dataUrl.indexOf("data:") !== 0) return null;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const meta = dataUrl.slice(5, comma);
  const body = dataUrl.slice(comma + 1);
  const isB64 = /;base64/i.test(meta);
  const mime = String(contentType || meta.split(";")[0] || "").toLowerCase();
  const zip = /zip|octet-stream|application\/x-zip/.test(mime);
  if (zip) return { content: dataUrl, binary: true };
  let text = "";
  try {
    if (isB64) {
      const bin = typeof atob === "function" ? atob(body) : "";
      if (typeof TextDecoder === "function") {
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        text = new TextDecoder("utf-8").decode(bytes);
      } else {
        text = bin;
      }
    } else {
      try { text = decodeURIComponent(body); } catch (e) { text = body; }
    }
  } catch (e) {
    return { content: dataUrl, binary: true };
  }
  const textish = !mime || /^text\/|application\/(json|javascript|xml|x-javascript|typescript)/.test(mime) ||
    /\+xml$/.test(mime) || /charset=utf-8/i.test(meta);
  if (textish) return { content: text, binary: false };
  return { content: dataUrl, binary: true };
};

function isZipContentType(ct) {
  ct = String(ct || "").toLowerCase();
  return /zip|octet-stream|application\/x-zip/.test(ct);
}

AE.applyFetchedFiles = function (payload, results) {
  payload = payload || {};
  const byUrl = {};
  (results || []).forEach(function (r) { if (r && r.url) byUrl[r.url] = r; });
  let applied = 0;
  const failed = [];
  AE.walkArchiveFiles(payload, function (f) {
    const u = AE.fileUrlOf(f);
    if (!u) return;
    const r = byUrl[u];
    if (!r) return;
    if (!r.ok || !r.dataUrl) {
      failed.push({ url: u, error: (r && r.error) || "fetch failed" });
      return;
    }
    const decoded = AE.decodeArchiveDataUrl(r.dataUrl, r.contentType);
    if (decoded && decoded.content != null) f.content = decoded.content;
    else f.content = r.dataUrl;
    f.bytes = r.bytes;
    if (r.contentType) f.media_type = r.contentType;
    applied++;
  });
  const zipUrl = AE.agentWorkspaceZipUrl(payload);
  const zr = zipUrl ? byUrl[zipUrl] : null;
  if (zr && zr.ok && zr.dataUrl && isZipContentType(zr.contentType)) {
    if (!payload.agent_files) payload.agent_files = [];
    payload.agent_files.push({
      path: "workspace.zip",
      archive_path: "workspace.zip",
      content: zr.dataUrl,
      bytes: zr.bytes,
      media_type: zr.contentType
    });
    applied++;
  } else if (zr && !zr.ok) {
    failed.push({ url: zipUrl, error: zr.error || "fetch failed" });
  }
  return { applied: applied, failed: failed };
};

function slimPayloadForJson(payload) {
  let copy;
  try { copy = JSON.parse(JSON.stringify(payload)); } catch (e) { return payload; }
  AE.walkArchiveFiles(copy, function (f) {
    if (typeof f.content !== "string") return;
    if (f.content.indexOf("data:") === 0 || f.content.length > AE.ARCHIVE_JSON_CONTENT_CAP) {
      f.content_omitted = true;
      f.content_chars = f.content.length;
      delete f.content;
    }
  });
  return copy;
}

AE.filesToWrite = function (payload) {
  const out = [];
  if (!payload) return out;
  const json = JSON.stringify(slimPayloadForJson(payload), null, 2);
  out.push({ path: "conversation.json", encoding: "utf8", content: json });
  if (AE.renderMarkdown) {
    out.push({ path: "conversation.md", encoding: "utf8", content: AE.renderMarkdown(payload) });
  }
  let fileCount = 0;
  function pushFile(rel, content) {
    if (!rel || content == null) return;
    if (fileCount >= AE.ARCHIVE_FILE_CAP) return;
    fileCount++;
    const encoding = typeof content === "string" && content.indexOf("data:") === 0 ? "dataurl" : "utf8";
    out.push({ path: rel, encoding: encoding, content: content });
  }
  (payload.battles || []).forEach(function (b) {
    (b.contestants || []).forEach(function (c) {
      if (!c) return;
      let resp = c.response || "";
      if (!resp) {
        const mediaNotes = (c.files || []).filter(function (f) {
          const p = String((f && (f.archive_path || f.path || "")) || "");
          return /\.(png|jpe?g|webp|gif|avif|svg|mp4|webm|mov)$/i.test(p);
        }).map(function (f) {
          const name = (f.archive_path || f.path || "file").split("/").pop();
          if (/\.(mp4|webm|mov)$/i.test(name)) return "[" + name + "](" + name + ")";
          return "![" + (c.lane || "image") + "](" + name + ")";
        });
        if (mediaNotes.length) resp = mediaNotes.join("\n");
      }
      if (c.response_file) {
        out.push({ path: c.response_file, encoding: "utf8", content: resp });
      }
      (c.files || []).forEach(function (f) {
        if (!f || !f.archive_path) return;
        pushFile(f.archive_path, AE.bytesToWrite(f));
      });
    });
    (b.workspace_files || []).forEach(function (f) {
      if (!f || !f.archive_path) return;
      pushFile(f.archive_path, AE.bytesToWrite(f));
    });
  });
  if (!(payload.battles || []).length) {
    (payload.messages || []).forEach(function (m) {
      (m.content || []).forEach(function (block) {
        if (!block || block.type !== "artifact" || !block.archive_path) return;
        pushFile(block.archive_path, AE.bytesToWrite(block));
      });
    });
  }
  (payload.agent_files || []).forEach(function (f) {
    if (!f || !f.archive_path) return;
    pushFile(f.archive_path, AE.bytesToWrite(f));
  });
  return out;
};
