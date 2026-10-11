/* Durable, append-only battle stream chunks.
 * chrome.storage.session is small and expires; local chunk records survive reloads
 * and keep large evaluations out of the hot session snapshot.
 * Chunks are privacy-scrubbed before reaching this module. */
var AE = AE || {};
(function () {
  "use strict";
  const PREFIX = "ae_eval_chunk_v1_";
  const BATCH_SIZE = 96;
  let writes = Promise.resolve();

  function area() {
    return chrome.storage && chrome.storage.local;
  }
  function available() {
    const store = area();
    return !!(store && typeof store.set === "function" && typeof store.get === "function");
  }
  function key(id, index) {
    return PREFIX + id + "_" + index;
  }
  function set(values) {
    return new Promise(function (resolve, reject) {
      let done = false;
      function finish(error) {
        if (done) return;
        done = true;
        if (error) reject(error instanceof Error ? error : new Error(String(error)));
        else resolve();
      }
      try {
        const request = area().set(values, function () {
          const error = chrome.runtime && chrome.runtime.lastError;
          finish(error ? new Error(error.message || "local storage write failed") : null);
        });
        if (request && typeof request.then === "function") request.then(function () { finish(); }, finish);
      } catch (error) { finish(error); }
    });
  }
  function get(keys) {
    return new Promise(function (resolve, reject) {
      let done = false;
      function finish(value, error) {
        if (done) return;
        done = true;
        if (error) reject(error instanceof Error ? error : new Error(String(error)));
        else resolve(value || {});
      }
      try {
        const request = area().get(keys, function (value) {
          const error = chrome.runtime && chrome.runtime.lastError;
          finish(value, error ? new Error(error.message || "local storage read failed") : null);
        });
        if (request && typeof request.then === "function") request.then(function (value) { finish(value); }, function (error) { finish(null, error); });
      } catch (error) { finish(null, error); }
    });
  }
  function markFailure(session, error) {
    session.evalArchiveFailed = true;
    session.truncatedEval = true;
    if (typeof addWarning === "function") addWarning(session, "Durable battle capture failed; the exported response may be incomplete.");
    if (AE.recordIssue) AE.recordIssue("capture", "durable_chunk_failed");
  }

  AE.evalArchive = {
    available: available,
    append: function (session, roundKey, text) {
      if (!available()) return false;
      if (!session.evaluationArchiveRefs) session.evaluationArchiveRefs = {};
      let ref = session.evaluationArchiveRefs[roundKey];
      if (!ref) {
        ref = { id: genId("evalraw"), chunks: 0, chars: 0 };
        session.evaluationArchiveRefs[roundKey] = ref;
      }
      const index = ref.chunks++;
      ref.chars += text.length;
      const record = {};
      record[key(ref.id, index)] = text;
      // Serialize writes so each stream's indexed chunks are committed in order.
      const task = writes.then(function () { return set(record); });
      writes = task.catch(function (error) { markFailure(session, error); });
      return true;
    },
    flush: function () { return writes; },
    hydrate: async function (session) {
      await writes;
      const streams = Object.assign({}, session.evaluationStreams || {});
      if (!available()) return streams;
      const refs = session.evaluationArchiveRefs || {};
      for (const roundKey of Object.keys(refs)) {
        const ref = refs[roundKey];
        if (!ref || !ref.id || !ref.chunks) continue;
        const chunks = new Array(ref.chunks);
        let valid = true;
        for (let start = 0; start < ref.chunks; start += BATCH_SIZE) {
          const names = [];
          for (let i = start; i < Math.min(ref.chunks, start + BATCH_SIZE); i++) names.push(key(ref.id, i));
          let values;
          try { values = await get(names); }
          catch (error) { valid = false; break; }
          for (let i = start; i < Math.min(ref.chunks, start + BATCH_SIZE); i++) {
            const piece = values[key(ref.id, i)];
            if (typeof piece !== "string") { valid = false; break; }
            chunks[i] = piece;
          }
          if (!valid) break;
        }
        if (!valid) {
          markFailure(session, new Error("Missing durable chunk"));
          continue; // Never present an incomplete archive as a complete one.
        }
        const joined = chunks.join("");
        if (joined.length !== ref.chars) {
          markFailure(session, new Error("Durable byte-count mismatch"));
          continue;
        }
        streams[roundKey] = joined;
      }
      return streams;
    },
    withFull: async function (session, build) {
      if (!session || !session.evaluationArchiveRefs || !Object.keys(session.evaluationArchiveRefs).length) return build();
      const streams = await this.hydrate(session);
      const preview = session.evaluationStreams;
      session.evaluationStreams = streams;
      try { return await build(); }
      finally { session.evaluationStreams = preview; }
    }
  };
})();
