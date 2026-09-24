/* Optional password-based encryption for local archive bundles.
 *
 * The persisted verifier is a separate PBKDF2 output, never the AES-GCM key.
 * Passwords and non-extractable CryptoKeys do not enter chrome.storage. A
 * service-worker restart intentionally returns the feature to a locked state.
 */
var AE = AE || {};
(function () {
  "use strict";

  var FORMAT = "arena-encrypted-archive";
  var VERSION = 2;
  var ITERATIONS = 600000;
  var MIN_ITERATIONS = 100000;
  var MAX_ITERATIONS = 2000000;
  var state = { enabled: false, unlocked: false, key: null, verifier: null, invalid: false };

  function bytesToBase64(bytes) {
    var binary = "";
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  function base64ToBytes(value) {
    var binary = atob(String(value || ""));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  function randomBytes(length) {
    var bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
  }
  function checkedIterations(value) {
    var iterations = Number(value || ITERATIONS);
    if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) throw new Error("Archive encryption KDF parameters are invalid.");
    return iterations;
  }
  async function derive(password, salt, iterations, bits) {
    var count = checkedIterations(iterations);
    var material = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(password || "")), { name: "PBKDF2" }, false, ["deriveBits"]);
    var derived = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: base64ToBytes(salt), iterations: count, hash: "SHA-256" }, material, bits || 512);
    return new Uint8Array(derived);
  }
  function splitDerived(bytes) {
    return { key: bytes.slice(0, 32), verifier: bytes.slice(32) };
  }
  function sameBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    var different = 0;
    for (var i = 0; i < a.length; i++) different |= a[i] ^ b[i];
    return different === 0;
  }
  function validRecord(record) {
    if (!record || record.format !== FORMAT || Number(record.version) !== VERSION || record.kdf !== "PBKDF2-SHA-256-512" || !record.enabled) return false;
    if (typeof record.salt !== "string" || typeof record.verifier !== "string") return false;
    try {
      checkedIterations(record.iterations);
      return base64ToBytes(record.salt).length >= 16 && base64ToBytes(record.verifier).length === 32;
    } catch (_) { return false; }
  }
  function publicRecord() {
    return {
      format: FORMAT,
      version: VERSION,
      enabled: state.enabled,
      kdf: "PBKDF2-SHA-256-512",
      iterations: state.verifier ? state.verifier.iterations : ITERATIONS,
      salt: state.verifier ? state.verifier.salt : null,
      verifier: state.verifier ? state.verifier.verifier : null
    };
  }
  async function verifyPassword(password) {
    if (!state.enabled || !state.verifier || state.invalid) throw new Error("Encrypted archives are not configured correctly.");
    if (!password) throw new Error("Enter the current archive password.");
    var candidate = splitDerived(await derive(password, state.verifier.salt, state.verifier.iterations));
    if (!sameBytes(candidate.verifier, base64ToBytes(state.verifier.verifier))) throw new Error("The archive password is incorrect.");
    return candidate.key;
  }
  async function importKey(keyBytes) {
    return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }

  AE.archiveEncryption = {
    format: FORMAT,
    version: VERSION,
    iterations: ITERATIONS,
    restore: function (record) {
      state.enabled = !!(record && record.enabled);
      state.unlocked = false;
      state.key = null;
      state.invalid = state.enabled && !validRecord(record);
      state.verifier = state.enabled && !state.invalid ? {
        salt: String(record.salt),
        iterations: checkedIterations(record.iterations),
        verifier: String(record.verifier)
      } : null;
    },
    status: function () {
      return {
        enabled: state.enabled,
        unlocked: state.unlocked && !state.invalid,
        configured: !!state.verifier && !state.invalid,
        error: state.invalid ? "invalid_configuration" : null,
        format: FORMAT,
        version: VERSION,
        kdf: "PBKDF2-SHA-256-512",
        iterations: state.verifier ? state.verifier.iterations : ITERATIONS
      };
    },
    fingerprint: function () {
      return state.verifier ? state.verifier.salt + ":" + state.verifier.verifier : null;
    },
    configure: async function (password, enabled) {
      if (!enabled) {
        if (state.enabled && !state.invalid) await verifyPassword(password);
        state.enabled = false;
        state.unlocked = false;
        state.key = null;
        state.verifier = null;
        state.invalid = false;
        return publicRecord();
      }
      if (state.enabled) throw new Error("Unlock or disable the current archive encryption before changing its password.");
      if (!password || String(password).length < 8) throw new Error("Use an archive password with at least 8 characters.");
      var salt = bytesToBase64(randomBytes(16));
      var derived = splitDerived(await derive(password, salt, ITERATIONS));
      var key = await importKey(derived.key);
      state.enabled = true;
      state.unlocked = true;
      state.invalid = false;
      state.verifier = { salt: salt, iterations: ITERATIONS, verifier: bytesToBase64(derived.verifier) };
      state.key = key;
      return publicRecord();
    },
    unlock: async function (password) {
      var keyBytes = await verifyPassword(password);
      state.key = await importKey(keyBytes);
      state.unlocked = true;
      return AE.archiveEncryption.status();
    },
    lock: function () {
      state.unlocked = false;
      state.key = null;
    },
    isUnlocked: function () { return state.enabled && state.unlocked && !state.invalid && !!state.key; },
    encryptText: async function (text) {
      if (!AE.archiveEncryption.isUnlocked()) throw new Error("Unlock encrypted archives before saving.");
      var iv = randomBytes(12);
      var ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, state.key, new TextEncoder().encode(String(text || "")));
      return JSON.stringify({
        format: FORMAT,
        version: VERSION,
        kdf: "PBKDF2-SHA-256-512",
        iterations: state.verifier.iterations,
        salt: state.verifier.salt,
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(new Uint8Array(ciphertext))
      });
    },
    encryptFiles: async function (files) {
      var bundle = {
        format: FORMAT,
        version: VERSION,
        created_at: new Date().toISOString(),
        files: (files || []).map(function (file) {
          return { path: file.path, encoding: file.encoding || "utf8", content: file.content };
        })
      };
      return AE.archiveEncryption.encryptText(JSON.stringify(bundle));
    },
    decryptEnvelope: async function (text, password) {
      var envelope = typeof text === "string" ? JSON.parse(text) : text;
      var envelopeVersion = envelope && Number(envelope.version);
      if (!envelope || envelope.format !== FORMAT || (envelopeVersion !== 1 && envelopeVersion !== VERSION)) throw new Error("Unsupported encrypted archive format.");
      if (!password) throw new Error("Enter the archive password.");
      var derivedBytes = await derive(password, envelope.salt, envelope.iterations, envelopeVersion === 1 ? 256 : 512);
      var keyBytes = envelopeVersion === 1 ? derivedBytes : splitDerived(derivedBytes).key;
      var key = await importKey(keyBytes);
      var plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(envelope.iv) }, key, base64ToBytes(envelope.ciphertext));
      var bundle = JSON.parse(new TextDecoder().decode(plain));
      if (!bundle || bundle.format !== FORMAT || ![1, VERSION].includes(Number(bundle.version)) || !Array.isArray(bundle.files)) throw new Error("Encrypted archive bundle is invalid.");
      bundle.files.forEach(function (file) {
        var rel = String(file.path || "").replace(/\\/g, "/");
        if (!rel || rel.startsWith("/") || rel.split("/").some(function (part) { return !part || part === "." || part === ".."; })) throw new Error("Encrypted archive contains an unsafe path.");
        if (typeof file.content !== "string") throw new Error("Encrypted archive contains an invalid file payload.");
      });
      return bundle;
    }
  };
})();
