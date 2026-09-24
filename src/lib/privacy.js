/* Credential filtering shared by capture, history, persistence, and export.
 *
 * The extension intentionally preserves conversation content. This module is
 * only responsible for preventing credentials and transport secrets from being
 * copied into durable state. It is deliberately structural: values are walked
 * before bounded samples are taken, and JSON embedded in strings is parsed when
 * possible. Raw Arena stream grammars must remain byte-for-byte unchanged when
 * they contain no credential-shaped value.
 */
var AE = AE || {};
(function () {
  "use strict";

  const SECRET_NAMES = /^(?:recaptcha.*|grecaptcha.*|captcha.*|authorization|proxyauthorization|cookie|setcookie|apikey|xapikey|secret|clientsecret|password|passwd|token|accesstoken|publicaccesstoken|refreshtoken|idtoken|sessiontoken|authtoken|bearertoken|oauthtoken|oauth2token|githubtoken|personalaccesstoken|pat|jwt|credentials|privatekey|privatekeypem|secretkey|signingkey)$/i;
  const FIELD = "(?:recaptcha[a-z0-9_-]*|g-recaptcha[a-z0-9_-]*|captcha[a-z0-9_-]*|authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|x[-_]?api[-_]?key|client[-_]?secret|secret|password|passwd|(?:public[-_]?)?access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|auth[-_]?token|bearer[-_]?token|oauth2?[-_]?token|github[-_]?token|personal[-_]?access[-_]?token|token|jwt|credentials|private[-_]?key)";
  const FIELD_VALUE = new RegExp("((?:[\\\"']?" + FIELD + "[\\\"']?)\\s*[:=]\\s*)(?:\\\"(?:\\\\.|[^\\\"\\\\])*(?:\\\"|$)|'(?:\\\\.|[^'\\\\])*(?:'|$)|[^&\\s,;}\\]]+)", "gi");
  const QUERY_SECRET = new RegExp("([?&]" + FIELD + "=)[^&#\\s]*", "gi");
  const PEM_PRIVATE = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;
  const OPENSSH_PRIVATE = /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g;

  function normalizedName(name) {
    return String(name == null ? "" : name).replace(/[^a-z0-9]/gi, "");
  }

  function secretName(name) {
    return SECRET_NAMES.test(normalizedName(name));
  }

  function scrubFragment(fragment) {
    const raw = String(fragment || "");
    if (raw.charAt(0) !== "#" || raw.indexOf("=") === -1) return null;
    try {
      const params = new URLSearchParams(raw.slice(1));
      let changed = false;
      Array.from(params.keys()).forEach(function (key) {
        if (!secretName(key)) return;
        params.set(key, "[REDACTED]");
        changed = true;
      });
      return changed ? "#" + params.toString() : null;
    } catch (_) {
      return null;
    }
  }

  /* Return the original string unless a credential-shaped URL component needs
   * changing. This is important for raw evaluation frames, where normalizing a
   * harmless citation URL can make an otherwise valid frame unparseable. */
  AE.scrubCredentialUrl = function (value) {
    const text = String(value == null ? "" : value);
    try {
      const url = new URL(text);
      let changed = false;
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
      const fragment = scrubFragment(url.hash);
      if (fragment !== null) {
        url.hash = fragment;
        changed = true;
      }
      return changed ? url.toString() : text;
    } catch (_) {
      return text.replace(QUERY_SECRET, "$1[REDACTED]");
    }
  };

  function scrubEmbeddedUrls(text) {
    return String(text || "").replace(/\bhttps?:\/\/[^\s<>"']+/gi, function (candidate) {
      let trailing = "";
      while (/[),.;\]}]$/.test(candidate)) {
        trailing = candidate.slice(-1) + trailing;
        candidate = candidate.slice(0, -1);
      }
      return AE.scrubCredentialUrl(candidate) + trailing;
    });
  }

  AE.redactSecretText = function (text) {
    const redacted = String(text == null ? "" : text)
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
        if (depth < 16 && /^\s*[\[{]/.test(v)) {
          try {
            return JSON.stringify(walk(JSON.parse(v), depth + 1));
          } catch (_) {
            // Raw or truncated stream frames still receive textual filtering.
          }
        }
        return AE.redactSecretText(v);
      }
      if (Array.isArray(v)) {
        if (v.length === 2 && typeof v[0] === "string" && secretName(v[0])) {
          return [v[0], "[REDACTED]"];
        }
        return v.map(function (item) { return walk(item, depth + 1); });
      }
      if (!v || typeof v !== "object") return v;
      const out = {};
      Object.keys(v).forEach(function (key) {
        if (secretName(key) || key === "__proto__" || key === "constructor" || key === "prototype") return;
        out[key] = walk(v[key], depth + 1);
      });
      return out;
    }
    return walk(value, 0);
  };

  AE.safeTransportHeaders = function (headers) {
    const out = {};
    ["x-session-settled", "x-stream-version", "x-arena-chat-id"].forEach(function (name) {
      let value = null;
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
