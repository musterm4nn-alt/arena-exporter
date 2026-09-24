/* Read public page hydration data without executing scripts or depending on
 * bundle module ids. Catalog labels describe a selection, not a hidden Agent model. */
var AE = AE || {};
(function () {
  "use strict";
  AE.catalogModelLabel = function (row) {
    if (!row || typeof row !== "object") return null;
    const values = [row.publicName, row.displayName, row.name];
    for (let i = 0; i < values.length; i++) {
      if (typeof values[i] === "string" && values[i] && !AE.isPlaceholderModel(values[i])) return values[i];
    }
    return null;
  };
  AE.catalogModel = function (catalog, id) {
    if (!id || !catalog || !Array.isArray(catalog.models)) return null;
    return catalog.models.find(function (row) { return row.id === id; }) || null;
  };
  AE.cleanModelCatalog = function (rows, url) {
    const seen = {};
    const fields = ["id", "name", "publicName", "displayName", "organization", "provider", "userSelectable", "rank", "rankByModality"];
    const models = [];
    (Array.isArray(rows) ? rows : []).slice(0, 4000).forEach(function (row) {
      if (!row || typeof row.id !== "string" || row.id.length > 160 || seen[row.id]) return;
      seen[row.id] = true;
      const clean = {};
      fields.forEach(function (field) {
        const value = row[field];
        if (value == null) return;
        if (typeof value === "string") clean[field] = value.slice(0, 300);
        else if (typeof value === "number" || typeof value === "boolean") clean[field] = value;
        else if (typeof value === "object" && JSON.stringify(value).length < 3000) clean[field] = value;
      });
      models.push(clean);
    });
    return { source_url: url || null, captured_at: new Date().toISOString(), models: models };
  };
  AE.assistantMetadata = function (message) {
    const source = Object.assign({}, message || {}, (message && (message.metadata || message.messageMetadata)) || {});
    const out = {};
    ["nodeId", "manifestNodeId", "pending", "requiresReview", "feedback"].forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
    });
    return AE.scrubSecrets(out);
  };
  AE.transcriptMetadata = function (transcript) {
    const out = {};
    ["pagination", "transcriptReadStrategy", "productMode", "feedbackType", "customFeedbackArm"].forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(transcript || {}, key)) out[key] = transcript[key];
    });
    if (transcript && transcript.session) out.session = AE.scrubSecrets(transcript.session);
    return AE.scrubSecrets(out);
  };
  AE.pageDataFromObjects = function (objects, url, references) {
    const result = { catalog: null, transcript: null };
    let visits = 0;
    const visited = new Set();
    function resolve(value, depth) {
      if (depth > 12) return value;
      if (typeof value === "string" && /^\$[a-f0-9]+$/i.test(value) && references) {
        const ref = references[value.slice(1)];
        if (ref !== undefined && ref !== value) return resolve(ref, depth + 1);
      }
      if (Array.isArray(value)) return value.map(function (v) { return resolve(v, depth + 1); });
      return value;
    }
    function walk(value, depth) {
      if (++visits > 80000 || depth > 35) return;
      value = resolve(value, 0);
      if (!value || typeof value !== "object" || visited.has(value)) return;
      visited.add(value);
      if (value.initialModels) {
        const rows = resolve(value.initialModels, 0);
        if (Array.isArray(rows)) result.catalog = AE.cleanModelCatalog(rows, url);
      }
      const messages = resolve(value.messages, 0);
      if (Array.isArray(messages) && messages.some(function (m) { return m && m.role && Array.isArray(m.parts); })) {
        result.transcript = Object.assign({}, value, { messages: messages });
      }
      Object.keys(value).forEach(function (key) {
        if (key !== "initialModels" && key !== "messages") walk(value[key], depth + 1);
      });
    }
    (Array.isArray(objects) ? objects : [objects]).forEach(function (o) { walk(o, 0); });
    return result;
  };
  AE.parsePageData = function (source, url) {
    source = String(source || "").slice(0, 8 * 1024 * 1024);
    const chunks = [];
    const re = /self\.__next_f\.push\(\s*\[\s*1\s*,\s*("(?:\\.|[^"\\])*")\s*\]\s*\)/g;
    let match;
    while ((match = re.exec(source))) {
      try { chunks.push(JSON.parse(match[1])); } catch (e) { /* incomplete script */ }
    }
    const flight = chunks.length ? chunks.join("") : source;
    const objects = [], references = {};
    flight.split(/\r?\n/).forEach(function (line) {
      const row = /^([a-f0-9]+):(?:J)?([\[{].*)$/i.exec(line);
      if (!row) return;
      try {
        references[row[1]] = JSON.parse(row[2]);
        objects.push(references[row[1]]);
      } catch (e) { /* non-JSON Flight row or a partial stream */ }
    });
    if (!objects.length) {
      try { objects.push(JSON.parse(flight)); } catch (e) { /* HTML without hydration data */ }
    }
    return AE.pageDataFromObjects(objects, url, references);
  };
})();
