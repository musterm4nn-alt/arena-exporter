/* Credential filtering shared by capture, history and export.
 * Redaction is structural first: nested objects, JSON-in-JSON strings and URLs
 * are traversed before bounded diagnostic samples are stored. */
var AE = AE || {};
(function () {
  "use strict";

  var SECRET_NAMES = /^(?:recaptcha.*|grecaptcha.*|captcha.*|authorization|proxyauthorization|cookie|setcookie|apikey|xapikey|secret|clientsecret|password|passwd|token|accesstoken|publicaccesstoken|refreshtoken|idtoken|sessiontoken|authtoken|bearertoken|oauthtoken|oauth2token|githubtoken|personalaccesstoken|pat|jwt|credentials|privatekey)$/i;
  function normalizedName(name) { return String(name || "").replace(/[^a-z0-9]/gi, ""); }
  function secretName(name) { return SECRET_NAMES.test(normalizedName(name)); }

  var FIELD = "(?:recaptcha[a-z0-9_-]*|g-recaptcha[a-z0-9_-]*|captcha[a-z0-9_-]*|authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|x[-_]?api[-_]?key|client[-_]?secret|secret|password|passwd|(?:public[-_]?)?access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|auth[-_]?token|bearer[-_]?token|oauth2?[-_]?token|github[-_]?token|personal[-_]?access[-_]?token|token|jwt|credentials|private[-_]?key)";
  var FIELD_VALUE = new RegExp("((?:[\\\"']?" + FIELD + "[\\\"']?)\\s*[:=]\\s*)(?:\\\"(?:\\\\.|[^\\\"\\\\])*(?:\\\"|$)|'(?:\\\\.|[^'\\\\])*(?:'|$)|[^&\\s,;}\\]]+)", "gi");
  var QUERY_SECRET = new RegExp("([?&]" + FIELD + "=)[^&#\\s]*", "gi");
  var PEM_PRIVATE = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;
  var OPENSSH_PRIVATE = /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g;

  function scrubFragment(url) {
    var hash = String(url.hash || "");
    if (!hash || hash.indexOf("=") === -1) return false;
    try {
      var params = new URLSearchParams(hash.slice(1));
      var changed = false;
      Array.from(params.keys()).forEach(function (key) {
        if (!secretName(key)) return;
        params.set(key, "[REDACTED]");
        changed = true;
      });
      if (changed) url.hash = "#" + params.toString();
      return changed;
    } catch (_) { return false; }
  }

  AE.scrubCredentialUrl = function (value) {
    var text = String(value || "");
    try {
      var url = new URL(text), changed = false;
      if (url.username || url.password) {
        url.username = "";
        url.password = "";
        changed = true;
      }
      Array.from(url.searchParams.keys()).forEach(function (key) {
        if (!secretName(key)) return;
        url.searchParams.set(key, "[REDACTED]");
        changed = true;
      });
      if (scrubFragment(url)) changed = true;
      // Exact preservation matters for raw stream grammars: harmless URLs must
      // remain byte-for-byte unchanged or a citation/tool frame can stop parsing.
      return changed ? url.toString() : text;
    } catch (_) {
      return text.replace(QUERY_SECRET, "$1[REDACTED]");
    }
  };

  function scrubEmbeddedUrls(text) {
    return String(text || "").replace(/\bhttps?:\/\/[^\s<>"']+/gi, function (candidate) {
      var trailing = "";
      while (/[),.;\]}]$/.test(candidate)) {
        trailing = candidate.slice(-1) + trailing;
        candidate = candidate.slice(0, -1);
      }
      return AE.scrubCredentialUrl(candidate) + trailing;
    });
  }

  AE.redactSecretText = function (text) {
    var redacted = String(text || "")
      .replace(PEM_PRIVATE, "[REDACTED_PRIVATE_KEY]")
      .replace(OPENSSH_PRIVATE, "[REDACTED_PRIVATE_KEY]")
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g, "[REDACTED_JWT]")
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/_-]+=*/gi, "[REDACTED_AUTH]")
      .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{12,}/gi, "[REDACTED_GITHUB_TOKEN]")
      .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED_KEY]")
      .replace(/^((?:proxy-)?authorization|cookie|set-cookie)(\s*:\s*)[^\r\n]*/gim, "$1$2[REDACTED]")
      .replace(QUERY_SECRET, "$1[REDACTED]")
      .replace(FIELD_VALUE, '$1"[REDACTED]"');
    return scrubEmbeddedUrls(redacted);
  };

  AE.scrubSecrets = function (value) {
    function walk(v, depth) {
      if (typeof v === "string") {
        // Trigger records and websocket frames often contain JSON inside JSON.
        if (depth < 16 && /^[\s]*[\[{]/.test(v)) {
          try { return JSON.stringify(walk(JSON.parse(v), depth + 1)); } catch (e) { /* raw or truncated frame */ }
        }
        return AE.redactSecretText(v);
      }
      if (Array.isArray(v)) {
        if (v.length === 2 && typeof v[0] === "string" && secretName(v[0])) return [v[0], "[REDACTED]"];
        return v.map(function (item) { return walk(item, depth + 1); });
      }
      if (!v || typeof v !== "object") return v;
      var out = {};
      Object.keys(v).forEach(function (key) {
        if (secretName(key) || key === "__proto__" || key === "constructor" || key === "prototype") return;
        out[key] = walk(v[key], depth + 1);
      });
      return out;
    }
    return walk(value, 0);
  };

  AE.safeTransportHeaders = function (headers) {
    var out = {};
    ["x-session-settled", "x-stream-version", "x-arena-chat-id"].forEach(function (name) {
      var value = null;
      if (headers && typeof headers.get === "function") value = headers.get(name);
      else if (Array.isArray(headers)) headers.forEach(function (pair) {
        if (pair && String(pair[0]).toLowerCase() === name) value = pair[1];
      });
      else if (headers) Object.keys(headers).forEach(function (key) {
        if (key.toLowerCase() === name) value = headers[key];
      });
      if (value != null) out[name] = AE.redactSecretText(value).slice(0, 200);
    });
    return out;
  };
})();
