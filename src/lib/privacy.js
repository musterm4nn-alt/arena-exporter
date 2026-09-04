/* Credential filtering shared by capture, history and export. Never sample or
 * truncate an unfiltered body: that can turn valid JSON into an unredactable fragment. */
var AE = AE || {};
(function () {
  "use strict";
  var SECRET_NAMES = /^(?:recaptcha.*|grecaptcha.*|captcha.*|authorization|proxyauthorization|cookie|setcookie|apikey|secret|clientsecret|password|passwd|token|accesstoken|publicaccesstoken|refreshtoken|idtoken|sessiontoken|authtoken|bearertoken|jwt|credentials|privatekey)$/i;
  function secretName(name) { return SECRET_NAMES.test(String(name || "").replace(/[^a-z0-9]/gi, "")); }
  var FIELD = "(?:recaptcha[a-z0-9_-]*|g-recaptcha[a-z0-9_-]*|captcha[a-z0-9_-]*|authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|client[-_]?secret|secret|password|passwd|(?:public[-_]?)?access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|auth[-_]?token|bearer[-_]?token|token|jwt|credentials|private[-_]?key)";
  var FIELD_VALUE = new RegExp("((?:[\\\"']?" + FIELD + "[\\\"']?)\\s*[:=]\\s*)(?:\\\"(?:\\\\.|[^\\\"\\\\])*(?:\\\"|$)|'(?:\\\\.|[^'\\\\])*(?:'|$)|[^&\\s,;}\\]]+)", "gi");
  var QUERY_SECRET = new RegExp("([?&]" + FIELD + "=)[^&#\\s]*", "gi");
  AE.redactSecretText = function (text) {
    return String(text || "")
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g, "[REDACTED JWT]")
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, "[REDACTED AUTH]")
      .replace(/^((?:proxy-)?authorization|cookie|set-cookie)(\s*:\s*)[^\r\n]*/gim, "$1$2[REDACTED]")
      .replace(QUERY_SECRET, "$1[REDACTED]")
      .replace(FIELD_VALUE, '$1"[REDACTED]"');
  };
  AE.scrubSecrets = function (value) {
    function walk(v, depth) {
      if (typeof v === "string") {
        // Trigger records and websocket frames often contain JSON inside JSON.
        if (depth < 12 && /^[\s]*[\[{]/.test(v)) {
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
