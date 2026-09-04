/* Native-messaging archive sink (com.arenaarchive.host).
 *
 * The desktop app is a writer: the extension sends files, the app writes them
 * under a user-chosen root. This helper never sends getRoot/setRoot.
 *
 * Missing host, a failed hello, or no-root → { fallback: true } so the caller
 * can use chrome.downloads without breaking load-unpacked Chrome/Firefox. */
var AE = AE || {};

(function () {
  "use strict";

  AE.NATIVE_HOST = "com.arenaarchive.host";
  AE.NATIVE_BATCH = 80;
  AE.NATIVE_MAX_BYTES = 32 * 1024 * 1024;
  AE.NATIVE_HINT = "Open Arena Archive and pick a folder";

  var HELLO_MS = 4000;
  var WRITE_MS = 20000;
  var lastStatus = { state: "missing", connected: false, error: "host-missing", fallback: true, hint: AE.NATIVE_HINT };
  var lastStatusAt = 0;
  var STATUS_TTL_MS = 4000;
  var idSeq = 0;

  function nextId() {
    idSeq += 1;
    return "ae-" + Date.now().toString(36) + "-" + idSeq;
  }

  function hintMsg(error) {
    return {
      ok: false,
      fallback: true,
      error: error || "connect-error",
      hint: AE.NATIVE_HINT
    };
  }

  function remember(status) {
    lastStatus = status;
    lastStatusAt = Date.now();
    return status;
  }

  AE.nativeLastStatus = function () { return lastStatus; };

  /* POSIX rel relative to the app root. Reject empty, NUL, absolute, drive
   * letters, and any `..` segment — never send those on the wire. */
  AE.nativeSafeRel = function (rel) {
    var p = String(rel == null ? "" : rel).replace(/\\/g, "/");
    if (!p || p.indexOf("\0") !== -1) return null;
    if (p.charAt(0) === "/" || p.charAt(0) === "~") return null;
    if (/^[a-zA-Z]:/.test(p)) return null;
    if (p.indexOf("://") !== -1) return null;
    var parts = p.split("/");
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i] || parts[i] === ".") continue;
      if (parts[i] === "..") return null;
      out.push(parts[i]);
    }
    return out.length ? out.join("/") : null;
  };

  function utf8ToBase64(str) {
    var bytes = new TextEncoder().encode(String(str == null ? "" : str));
    var bin = "";
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function base64DecodedBytes(b64) {
    var s = String(b64 || "").replace(/\s/g, "");
    if (!s) return 0;
    var pad = 0;
    if (s.slice(-2) === "==") pad = 2;
    else if (s.slice(-1) === "=") pad = 1;
    return Math.floor(s.length * 3 / 4) - pad;
  }

  function utf8Bytes(str) {
    return new TextEncoder().encode(String(str == null ? "" : str)).length;
  }

  /**
   * Map an AE.filesToWrite item (or a job) onto a protocol file.
   * utf8 strings → encoding utf8; data-url / binary / base64 → encoding base64.
   */
  AE.nativeEncodeFile = function (rel, content, encodingHint) {
    var safe = AE.nativeSafeRel(rel);
    if (!safe) return { ok: false, error: "illegal path" };
    if (typeof content !== "string") {
      return { ok: false, error: "unsupported content" };
    }
    var hint = String(encodingHint || "");
    var isDataUrl = /^data:[^,]*,/.test(content);
    var asBase64 = hint === "base64" || hint === "dataurl" || isDataUrl;
    var encoding = asBase64 ? "base64" : "utf8";
    var body = content;
    if (asBase64) {
      if (isDataUrl) {
        var comma = content.indexOf(",");
        var meta = content.slice(5, comma);
        var payload = content.slice(comma + 1);
        if (/;base64/i.test(meta)) body = payload.replace(/\s/g, "");
        else {
          try { payload = decodeURIComponent(payload); } catch (e) { /* keep */ }
          body = utf8ToBase64(payload);
        }
      } else if (hint === "base64") {
        body = content.replace(/\s/g, "");
      } else {
        body = utf8ToBase64(content);
      }
    }
    var decoded = encoding === "utf8" ? utf8Bytes(body) : base64DecodedBytes(body);
    if (decoded > AE.NATIVE_MAX_BYTES) {
      return { ok: false, error: "too large (" + decoded + " bytes, max 32MiB)" };
    }
    return { ok: true, file: { rel: safe, encoding: encoding, content: body } };
  };

  function hostMissingMessage(msg) {
    msg = String(msg || "");
    return /not found|does not exist|native messaging host|specified native messaging host|no such native/i.test(msg);
  }

  function connectPort() {
    if (typeof chrome === "undefined" || !chrome.runtime ||
        typeof chrome.runtime.connectNative !== "function") {
      return { ok: false, error: "host-missing" };
    }
    try {
      return { ok: true, port: chrome.runtime.connectNative(AE.NATIVE_HOST) };
    } catch (e) {
      return { ok: false, error: "host-missing", message: String(e) };
    }
  }

  function attachSession(port) {
    var pending = {};
    var closed = false;

    function rejectAll(err) {
      var keys = Object.keys(pending);
      for (var i = 0; i < keys.length; i++) {
        var p = pending[keys[i]];
        delete pending[keys[i]];
        p.reject(err);
      }
    }

    port.onMessage.addListener(function (msg) {
      if (!msg || msg.id == null) return;
      var p = pending[msg.id];
      if (!p) return;
      delete pending[msg.id];
      p.resolve(msg);
    });
    port.onDisconnect.addListener(function () {
      closed = true;
      var errMsg = (chrome.runtime.lastError && chrome.runtime.lastError.message) || "disconnected";
      var err = new Error(errMsg);
      err.hostMissing = hostMissingMessage(errMsg);
      rejectAll(err);
    });

    function request(op, extra, timeoutMs) {
      return new Promise(function (resolve, reject) {
        if (closed) {
          var gone = new Error("disconnected");
          gone.hostMissing = true;
          reject(gone);
          return;
        }
        var id = nextId();
        var msg = Object.assign({ id: id, op: op }, extra || {});
        pending[id] = { resolve: resolve, reject: reject };
        try {
          port.postMessage(msg);
        } catch (e) {
          delete pending[id];
          reject(e);
          return;
        }
        setTimeout(function () {
          if (!pending[id]) return;
          delete pending[id];
          reject(new Error("timeout"));
        }, timeoutMs || WRITE_MS);
      });
    }

    function disconnect() {
      closed = true;
      try { port.disconnect(); } catch (e) { /* already gone */ }
    }

    return { request: request, disconnect: disconnect, port: port };
  }

  /* hello, then a live session. Probe-only callers disconnect themselves. */
  AE.nativeConnect = function () {
    var opened = connectPort();
    if (!opened.ok) {
      remember({
        state: "missing",
        connected: false,
        error: "host-missing",
        fallback: true,
        hint: AE.NATIVE_HINT
      });
      return Promise.resolve(hintMsg("host-missing"));
    }
    var session = attachSession(opened.port);
    return session.request("hello", null, HELLO_MS).then(function (msg) {
      if (!msg || msg.ok !== true) {
        var err = (msg && msg.error) || "hello failed";
        session.disconnect();
        if (err === "no-root") {
          remember({
            state: "no-root",
            connected: true,
            root: null,
            app: msg && msg.app,
            version: msg && msg.version,
            error: "no-root",
            fallback: true,
            hint: AE.NATIVE_HINT
          });
          return Object.assign(hintMsg("no-root"), { app: msg && msg.app, version: msg && msg.version });
        }
        remember({
          state: "error",
          connected: false,
          error: err,
          fallback: true,
          hint: AE.NATIVE_HINT
        });
        return hintMsg(err);
      }
      if (!msg.root) {
        session.disconnect();
        remember({
          state: "no-root",
          connected: true,
          root: null,
          app: msg.app,
          version: msg.version,
          error: "no-root",
          fallback: true,
          hint: AE.NATIVE_HINT
        });
        return Object.assign(hintMsg("no-root"), { app: msg.app, version: msg.version });
      }
      remember({
        state: "ok",
        connected: true,
        root: msg.root,
        app: msg.app,
        version: msg.version,
        fallback: false
      });
      return {
        ok: true,
        fallback: false,
        root: msg.root,
        app: msg.app,
        version: msg.version,
        request: session.request,
        disconnect: session.disconnect
      };
    }, function (err) {
      session.disconnect();
      var missing = !!(err && err.hostMissing) || hostMissingMessage(err && err.message);
      var code = missing ? "host-missing" : ((err && err.message) || "connect-error");
      remember({
        state: missing ? "missing" : "error",
        connected: false,
        error: code,
        fallback: true,
        hint: AE.NATIVE_HINT
      });
      return hintMsg(code);
    });
  };

  AE.nativeStatus = function () {
    if (lastStatusAt && (Date.now() - lastStatusAt) < STATUS_TTL_MS) {
      return Promise.resolve(lastStatus);
    }
    return AE.nativeConnect().then(function (session) {
      if (session && session.ok && session.disconnect) {
        try { session.disconnect(); } catch (e) { /* ignore */ }
      }
      return lastStatus;
    });
  };

  function nativeWriteJobs(session, jobs) {
    var written = [];
    var failed = [];
    var files = [];
    var jobForRel = {};
    (jobs || []).forEach(function (job) {
      var rel = job.full || job.path;
      var enc = AE.nativeEncodeFile(rel, job.content, job.encoding);
      if (!enc.ok) {
        failed.push({ path: job.path, error: enc.error });
        return;
      }
      /* Last-chance: never put a `..` segment on the wire. */
      if (!AE.nativeSafeRel(enc.file.rel) || /(^|\/)\.\.(\/|$)/.test(enc.file.rel)) {
        failed.push({ path: job.path, error: "illegal path" });
        return;
      }
      files.push(enc.file);
      jobForRel[enc.file.rel] = job;
    });

    var batches = [];
    for (var i = 0; i < files.length; i += AE.NATIVE_BATCH) {
      batches.push(files.slice(i, i + AE.NATIVE_BATCH));
    }

    var chain = Promise.resolve();
    batches.forEach(function (batch) {
      chain = chain.then(function () {
        return session.request("write", { files: batch }, WRITE_MS).then(function (msg) {
          if (msg && msg.ok) {
            batch.forEach(function (f) { written.push(jobForRel[f.rel]); });
          } else {
            var err = (msg && msg.error) || "write failed";
            batch.forEach(function (f) {
              failed.push({ path: jobForRel[f.rel].path, error: err });
            });
          }
        }, function (err) {
          var code = (err && err.message) || "write failed";
          batch.forEach(function (f) {
            failed.push({ path: jobForRel[f.rel].path, error: code });
          });
        });
      });
    });
    return chain.then(function () { return { written: written, failed: failed }; });
  }

  AE.writeNativeJobs = nativeWriteJobs;

  AE.writeArchiveNative = function (payload, files) {
    return AE.nativeConnect().then(function (session) {
      if (!session || !session.ok) {
        return {
          ok: false,
          fallback: true,
          error: (session && session.error) || "host-missing",
          hint: (session && session.hint) || AE.NATIVE_HINT
        };
      }
      var writeJobs = function (jobs) { return nativeWriteJobs(session, jobs); };
      var writeFile = function (rel, content) {
        return nativeWriteJobs(session, [{
          path: rel, full: rel, content: content, encoding: "utf8"
        }]).then(function (r) {
          var fail = r.failed && r.failed[0];
          return { ok: r.failed.length === 0, path: rel, error: fail && fail.error };
        });
      };
      return AE.writeArchive(payload, files, {
        prefix: "",
        destinationKey: "native:" + String(session.root).replace(/\\/g, "/").replace(/\/$/, ""),
        writeJobs: writeJobs,
        writeFile: writeFile
      }).then(function (res) {
        try { session.disconnect(); } catch (e) { /* ignore */ }
        if (res) {
          res.sink = "native";
          res.root = session.root;
        }
        return res;
      }, function (err) {
        try { session.disconnect(); } catch (e) { /* ignore */ }
        return { ok: false, error: String(err), fallback: false };
      });
    });
  };

  AE.writeNativeSelftest = function (body) {
    return AE.nativeConnect().then(function (session) {
      if (!session || !session.ok) {
        return {
          ok: false,
          fallback: true,
          error: (session && session.error) || "host-missing",
          hint: (session && session.hint) || AE.NATIVE_HINT
        };
      }
      return nativeWriteJobs(session, [{
        path: "_selftest.txt",
        full: "_selftest.txt",
        content: String(body == null ? "" : body),
        encoding: "utf8"
      }]).then(function (r) {
        try { session.disconnect(); } catch (e) { /* ignore */ }
        if (r.failed && r.failed.length) {
          var err = r.failed[0].error || "write failed";
          return {
            ok: false,
            error: err,
            fallback: err === "no-root",
            hint: AE.NATIVE_HINT,
            path: "_selftest.txt"
          };
        }
        return {
          ok: true,
          path: "_selftest.txt",
          resolved: (session.root ? String(session.root).replace(/\/+$/, "") + "/" : "") + "_selftest.txt",
          sink: "native"
        };
      }, function (err) {
        try { session.disconnect(); } catch (e) { /* ignore */ }
        return { ok: false, error: String(err), fallback: true, hint: AE.NATIVE_HINT };
      });
    });
  };
})();
