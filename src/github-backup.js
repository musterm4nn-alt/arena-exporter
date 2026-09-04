/* Private GitHub backups. No credentials enter exports, page scripts or the
 * durable outbox. Git references are advanced only with force:false. */
var AE = AE || {};
(function () {
  "use strict";
  var CONFIG = "ae_github_config", STATUS = "ae_github_status";
  var ALARM = "arena-github-backup", lock = Promise.resolve(), running = false;
  function storageGet(key) {
    return new Promise(function (resolve, reject) {
      chrome.storage.local.get([key], function (value) {
        if (chrome.runtime.lastError) return reject(new Error("Could not read backup settings."));
        resolve(value && value[key] || {});
      });
    });
  }
  function storageSet(key, value) {
    return new Promise(function (resolve, reject) {
      chrome.storage.local.set({ [key]: value }, function () {
        if (chrome.runtime.lastError) return reject(new Error("Could not save backup settings."));
        resolve();
      });
    });
  }
  function exclusive(fn) {
    var next = lock.then(fn);
    lock = next.catch(function () {});
    return next;
  }
  function target(config) { return JSON.stringify([config.repo.toLowerCase(), config.branch, config.folder]); }
  function safePath(path) {
    path = String(path || "");
    if (!path || /[\\\x00-\x1f:]/.test(path) || path[0] === "/" ||
        path.split("/").some(function (part) { return !part || part === "." || part === ".." || part.toLowerCase() === ".git"; })) {
      throw new Error("Invalid backup file path.");
    }
    return path;
  }
  function repoPath(config) { return "/repos/" + config.repo; }
  function refPath(config) { return config.branch.split("/").map(encodeURIComponent).join("/"); }
  async function api(config, path, method, body) {
    if (typeof browser !== "undefined" && browser.permissions) {
      var permissions = await browser.permissions.getAll();
      var required = ["personalCommunications", "websiteContent", "authenticationInfo"];
      if (!permissions.data_collection || required.some(function (name) { return !permissions.data_collection.includes(name); })) {
        throw new Error("Allow GitHub backup data permissions by reconnecting in Settings.");
      }
    }
    var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 20000);
    try {
      var response = await fetch("https://api.github.com" + path, {
        method: method || "GET", credentials: "omit", redirect: "error", signal: controller.signal,
        headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + config.token,
          "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
        body: body == null ? undefined : JSON.stringify(body)
      });
      if (!response.ok) {
        var error = new Error(response.status === 401 ? "GitHub token expired or invalid. Reconnect in Settings." :
          response.status === 403 ? "GitHub denied the request. Check Contents write permission or try again after the rate limit resets." :
          response.status === 404 ? "GitHub repository or branch was not found. Check the repository and token access." :
          "GitHub request failed (HTTP " + response.status + "). Your backup remains queued.");
        error.status = response.status;
        var retry = Number(response.headers.get("retry-after")) * 1000;
        var reset = Number(response.headers.get("x-ratelimit-reset")) * 1000 - Date.now();
        error.retryMs = Math.max(retry || 0, response.headers.get("x-ratelimit-remaining") === "0" ? reset : 0);
        throw error;
      }
      return await response.json();
    } catch (error) {
      if (error.status) throw error;
      throw new Error("GitHub could not be reached. Your backup remains queued and will retry.");
    } finally { clearTimeout(timer); }
  }
  async function privateRepo(config) {
    var repo = await api(config, repoPath(config));
    if (!repo.private) throw new Error("Backups require a private GitHub repository.");
    if (repo.permissions && repo.permissions.push === false) throw new Error("The token needs Contents: read and write for this repository.");
    return repo;
  }
  async function blob(file) {
    var encoded = AE.nativeEncodeFile(safePath(file.path), file.content, file.encoding);
    if (!encoded.ok) throw new Error("Backup file could not be encoded: " + encoded.error);
    var value = encoded.file;
    var bytes = value.encoding === "base64" ? Uint8Array.from(atob(value.content), function (c) { return c.charCodeAt(0); }) : new TextEncoder().encode(value.content);
    var header = new TextEncoder().encode("blob " + bytes.length + "\0");
    var data = new Uint8Array(header.length + bytes.length);
    data.set(header); data.set(bytes, header.length);
    var digest = await crypto.subtle.digest("SHA-1", data);
    return { sha: Array.from(new Uint8Array(digest), function (v) { return v.toString(16).padStart(2, "0"); }).join(""),
      encoding: value.encoding === "utf8" ? "utf-8" : "base64", content: value.content };
  }
  function arm() {
    if (!chrome.alarms) return;
    chrome.alarms.get(ALARM, function (alarm) {
      if (!alarm) chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
    });
  }
  AE.githubStatus = async function () {
    var config = await storageGet(CONFIG), status = await storageGet(STATUS);
    var counts = await AE.backupStore.counts(), currentTarget = config.repo ? target(config) : "";
    return { ok: true, enabled: !!config.enabled, connected: !!config.token,
      repo: config.repo || "", branch: config.branch || "", folder: config.folder || "arena-archive",
      pending: counts[currentTarget] || 0,
      otherPending: Object.keys(counts).reduce(function (total, name) { return total + (name === currentTarget ? 0 : counts[name]); }, 0),
      running: running, lastSuccess: status.lastSuccess || null, error: status.error || null, nextRetry: status.nextRetry || null };
  };
  AE.githubConfigure = function (input) {
    return exclusive(async function () {
      var previous = await storageGet(CONFIG);
      var config = { repo: String(input.repo || "").trim(), branch: String(input.branch || "").trim(),
        folder: safePath(String(input.folder || "arena-archive").trim()), token: String(input.token || previous.token || "").trim(), enabled: true };
      if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(config.repo) || /\/(?:\.|\.\.)$/.test(config.repo)) throw new Error("Enter a repository as owner/name.");
      if (!config.token) throw new Error("Enter a GitHub token with Contents: read and write for your private archive repository.");
      var repo = await privateRepo(config);
      config.branch = config.branch || repo.default_branch || "main";
      if (!/^[A-Za-z0-9_./-]+$/.test(config.branch) || config.branch.includes("..") || config.branch.startsWith("/")) throw new Error("Invalid branch name.");
      try { await api(config, repoPath(config) + "/git/ref/heads/" + refPath(config)); }
      catch (error) {
        if (![404, 409].includes(error.status) || repo.size > 0) throw error;
        await api(config, repoPath(config) + "/contents/" + config.folder.split("/").map(encodeURIComponent).join("/") + "/.arena-backup.json", "PUT", {
          message: "Initialize private Arena archive", branch: config.branch,
          content: btoa('{"format":"arena-archive","version":1}\n')
        });
      }
      await storageSet(CONFIG, config);
      await storageSet(STATUS, { error: null });
      arm();
      return AE.githubStatus();
    });
  };
  AE.githubPause = function (forget) {
    return exclusive(async function () {
      var config = await storageGet(CONFIG);
      config.enabled = false;
      if (forget) delete config.token;
      await storageSet(CONFIG, config);
      return AE.githubStatus();
    });
  };
  AE.githubEnqueue = async function (key, rel, files, entry) {
    var config = await storageGet(CONFIG);
    if (!config.enabled || !config.token) return { queued: false };
    if (typeof key !== "string" || !key) throw new Error("A conversation identifier is required for backup.");
    rel = safePath(rel);
    // Validate before making a durable record; never store the config/token here.
    var prepared = (files || []).map(function (file) {
      return { path: safePath(file.path), content: String(file.content), encoding: file.encoding || null };
    });
    var destination = target(config);
    await AE.backupStore.put({ id: destination + "\n" + rel, target: destination,
      revision: crypto.randomUUID(), key: key, rel: rel, files: prepared, entry: entry || {} });
    arm();
    return { queued: true };
  };
  AE.githubQueueArchive = async function (payload, files, result) {
    if (!result || !result.ok) return;
    try {
      var session = payload.session || {}, key = session.conversation_key || session.session_id;
      var index = await AE.archiveIndexLoad(), source = index[key] || {};
      var entry = { rel: result.rel };
      ["mode", "subtype", "title", "url", "models", "models_pending", "updated_at", "turns"].forEach(function (field) { entry[field] = source[field]; });
      result.backup = await AE.githubEnqueue(key, result.rel, files, entry);
    } catch (error) {
      result.backup = { queued: false, error: "Could not queue the GitHub backup. Retry Write to archive now." };
      await storageSet(STATUS, { error: result.backup.error }).catch(function () {});
    }
  };
  async function upload(config, items) {
    await privateRepo(config);
    var base = repoPath(config), prefix = config.folder + "/", uploaded = new Set();
    var prepared = new Map();
    for (var item of items) {
      for (var file of item.files) prepared.set(prefix + safePath(item.rel) + "/" + safePath(file.path), await blob(file));
    }
    for (var attempt = 0; attempt < 3; attempt++) {
      var head = await api(config, base + "/git/ref/heads/" + refPath(config));
      var commit = await api(config, base + "/git/commits/" + head.object.sha);
      var tree = await api(config, base + "/git/trees/" + commit.tree.sha + "?recursive=1");
      if (tree.truncated) throw new Error("The repository tree is too large to back up safely. Use a dedicated archive repository.");
      var existing = new Map(tree.tree.map(function (node) { return [node.path, node]; }));
      var indexPath = prefix + "_index.json", index = { version: 1, chats: {} };
      if (existing.has(indexPath)) {
        var remote = await api(config, base + "/git/blobs/" + existing.get(indexPath).sha);
        try {
          index = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(remote.content.replace(/\s/g, "")), function (c) { return c.charCodeAt(0); })));
          if (!index.chats || typeof index.chats !== "object" || Array.isArray(index.chats)) throw new Error();
        } catch (_) { throw new Error("The remote archive index is invalid; backup stopped to preserve it."); }
      }
      items.forEach(function (item) { Object.defineProperty(index.chats, item.key, { value: item.entry, enumerable: true, configurable: true, writable: true }); });
      prepared.set(indexPath, await blob({ path: "_index.json", content: JSON.stringify(index, null, 2) }));
      var changes = [];
      for (var pair of prepared) {
        var path = pair[0], content = pair[1], old = existing.get(path);
        if (old && old.type !== "blob") throw new Error("A folder conflicts with a backup file on GitHub.");
        // Do not follow or replace symlink/submodule paths or their parents.
        var parts = path.split("/");
        for (var depth = 1; depth < parts.length; depth++) {
          var ancestor = existing.get(parts.slice(0, depth).join("/"));
          if (ancestor && ancestor.type !== "tree") throw new Error("A file conflicts with the backup folder on GitHub.");
        }
        if (old && old.mode !== "100644" && old.mode !== "100755") throw new Error("A symbolic link conflicts with a backup file on GitHub.");
        if (old && old.sha === content.sha) continue;
        if (!uploaded.has(content.sha)) {
          var created = await api(config, base + "/git/blobs", "POST", { content: content.content, encoding: content.encoding });
          if (created.sha !== content.sha) throw new Error("GitHub returned an unexpected file checksum.");
          uploaded.add(content.sha);
        }
        changes.push({ path: path, mode: "100644", type: "blob", sha: content.sha });
      }
      if (!changes.length) return;
      var nextTree = await api(config, base + "/git/trees", "POST", { base_tree: commit.tree.sha, tree: changes });
      var nextCommit = await api(config, base + "/git/commits", "POST", {
        message: "Back up Arena archive (" + items.length + " conversations)", tree: nextTree.sha, parents: [head.object.sha]
      });
      try {
        await api(config, base + "/git/refs/heads/" + refPath(config), "PATCH", { sha: nextCommit.sha, force: false });
        return;
      } catch (error) {
        if (![409, 422].includes(error.status) || attempt === 2) throw error;
      }
    }
  }
  AE.githubFlush = function (manual) {
    return exclusive(async function () {
      var config = await storageGet(CONFIG), status = await storageGet(STATUS);
      if (!config.enabled || !config.token || (!manual && status.nextRetry > Date.now())) return AE.githubStatus();
      var items = await AE.backupStore.list(target(config), 10);
      if (!items.length) return AE.githubStatus();
      running = true;
      try {
        await upload(config, items);
        await AE.backupStore.acknowledge(items);
        await storageSet(STATUS, { lastSuccess: new Date().toISOString(), error: null, failures: 0 });
      } catch (error) {
        var failures = Math.min((status.failures || 0) + 1, 6);
        await storageSet(STATUS, { lastSuccess: status.lastSuccess || null, error: error.message,
          failures: failures, nextRetry: Date.now() + Math.max(60000 * Math.pow(2, failures - 1), error.retryMs || 0) });
      } finally { running = false; }
      return AE.githubStatus();
    });
  };
  // Register synchronously so browser restarts wake the durable queue.
  if (chrome.alarms) {
    chrome.alarms.onAlarm.addListener(function (alarm) {
      if (alarm.name === ALARM) AE.githubFlush(false).catch(function () {});
    });
    arm();
  }
  // Chrome can keep extension credentials inaccessible to content scripts.
  if (chrome.storage.local.setAccessLevel) {
    try { Promise.resolve(chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })).catch(function () {}); }
    catch (_) { /* Older browser API without Promise support. */ }
  }
})();
