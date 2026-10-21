/* Pure search and filtering over local library records.
 *
 * Queries are AND by default, support quoted phrases and -exclusions, and are
 * matched against the title, message text and (optionally) reasoning/tool
 * evidence. Results carry a bounded snippet so the workspace never needs the
 * full transcript in memory.
 */
var AE = AE || {};
(function () {
  "use strict";

  const MAX_RESULTS = 200;
  const SNIPPET_BEFORE = 80;
  const SNIPPET_AFTER = 160;

  function lower(value) {
    return String(value == null ? "" : value).toLowerCase();
  }

  function parse(query) {
    const terms = [], phrases = [], excludes = [];
    const source = String(query || "");
    const pattern = /"([^"]+)"|(\S+)/g;
    let match;
    while ((match = pattern.exec(source))) {
      const quoted = match[1] != null;
      const raw = String(quoted ? match[1] : match[2] || "").trim();
      if (!raw) continue;
      const negated = !quoted && raw.charAt(0) === "-" && raw.length > 1;
      let value = lower(negated ? raw.slice(1) : raw);
      value = value.replace(/^"+|"+$/g, "");
      if (!value) continue;
      if (negated) {
        if (excludes.indexOf(value) === -1) excludes.push(value);
      } else if (quoted) {
        if (phrases.indexOf(value) === -1) phrases.push(value);
      } else if (terms.indexOf(value) === -1) {
        terms.push(value);
      }
    }
    return { terms: terms, phrases: phrases, excludes: excludes, empty: terms.length === 0 && phrases.length === 0 && excludes.length === 0 };
  }

  function countOf(haystack, needle) {
    if (!haystack || !needle) return 0;
    let count = 0, index = 0;
    while ((index = haystack.indexOf(needle, index)) !== -1) {
      count++;
      index += needle.length;
      if (count >= 20) break;
    }
    return count;
  }

  function haystacks(record, scope) {
    const text = lower(record && record.text);
    return {
      title: lower(record && record.title),
      text: text,
      detail: scope === "all" ? lower(record && record.detail) : ""
    };
  }

  function voteState(record) {
    const outcomes = Array.isArray(record && record.vote_outcomes) ? record.vote_outcomes : [];
    return { hasBallot: outcomes.length > 0, outcomes: outcomes };
  }

  function passesFilters(record, options, now) {
    if (!record) return false;
    if (options.mode && options.mode !== "all" && lower(record.mode) !== lower(options.mode)) return false;
    if (options.model && options.model !== "all") {
      const models = Array.isArray(record.models) ? record.models : [];
      if (models.indexOf(options.model) === -1) return false;
    }
    if (options.vote && options.vote !== "all") {
      const state = voteState(record);
      if (options.vote === "any" && !state.hasBallot) return false;
      if (options.vote === "none" && state.hasBallot) return false;
      if (options.vote !== "any" && options.vote !== "none" && state.outcomes.indexOf(options.vote) === -1) return false;
    }
    if (options.days && options.days !== "all") {
      const days = Number(options.days);
      const updated = Date.parse(record.updated_at || "");
      if (Number.isFinite(days) && Number.isFinite(updated) && updated < now - days * 86400000) return false;
    }
    return true;
  }

  function scoreRecord(record, query, scope) {
    const fields = haystacks(record, scope);
    let score = 0;
    const terms = query.terms;
    for (let i = 0; i < terms.length; i++) {
      const term = terms[i];
      const inTitle = countOf(fields.title, term);
      const inText = countOf(fields.text, term);
      const inDetail = countOf(fields.detail, term);
      if (!inTitle && !inText && !inDetail) return -1;
      score += inTitle * 6 + inText * 2 + inDetail;
    }
    const hay = [fields.title, fields.text, fields.detail].join("\n");
    for (let i = 0; i < query.excludes.length; i++) {
      if (hay.indexOf(query.excludes[i]) !== -1) return -1;
    }
    for (let i = 0; i < query.phrases.length; i++) {
      if (hay.indexOf(query.phrases[i]) === -1) return -1;
      score += 10;
    }
    return score;
  }

  function snippetFor(record, query, scope) {
    const candidates = [{ field: "text", value: String(record.text || "") }];
    if (scope === "all") candidates.push({ field: "detail", value: String(record.detail || "") });
    for (let c = 0; c < candidates.length; c++) {
      const hay = candidates[c].value;
      const low = hay.toLowerCase();
      let best = -1, bestTerm = "";
      for (let i = 0; i < query.terms.length; i++) {
        const index = low.indexOf(query.terms[i]);
        if (index !== -1 && (best === -1 || index < best)) { best = index; bestTerm = query.terms[i]; }
      }
      if (best === -1) continue;
      const start = Math.max(0, best - SNIPPET_BEFORE);
      const end = Math.min(hay.length, best + bestTerm.length + SNIPPET_AFTER);
      const body = hay.slice(start, end).replace(/\s+/g, " ").trim();
      return {
        field: candidates[c].field,
        text: (start > 0 ? "…" : "") + body + (end < hay.length ? "…" : "")
      };
    }
    const title = String(record.title || "");
    return { field: "title", text: title.length > 240 ? title.slice(0, 240) + "…" : title };
  }

  function search(records, options) {
    options = options || {};
    const now = options.now == null ? Date.now() : options.now;
    const query = parse(options.query);
    const list = Array.isArray(records) ? records : [];
    const scored = [];
    list.forEach(function (record) {
      if (!passesFilters(record, options, now)) return;
      let score = 0;
      if (!query.empty) {
        score = scoreRecord(record, query, options.scope || "text");
        if (score < 0) return;
      }
      scored.push({ record: record, score: score });
    });
    const sort = options.sort || (query.empty ? "recent" : "relevance");
    scored.sort(function (a, b) {
      if (sort === "title") return String(a.record.title || "").localeCompare(String(b.record.title || ""));
      if (sort === "turns") return (b.record.turns || 0) - (a.record.turns || 0);
      if (sort === "relevance" && !query.empty && b.score !== a.score) return b.score - a.score;
      return String(b.record.updated_at || "").localeCompare(String(a.record.updated_at || ""));
    });
    const total = scored.length;
    const limit = Math.max(0, Math.min(MAX_RESULTS, Number(options.limit) || MAX_RESULTS));
    const offset = Math.max(0, Number(options.offset) || 0);
    return {
      total: total,
      query: { terms: query.terms, phrases: query.phrases, excludes: query.excludes },
      results: scored.slice(offset, offset + limit).map(function (entry) {
        return {
          key: entry.record.key,
          score: entry.score,
          match: query.empty ? "metadata" : countOf(haystacks(entry.record, "all").title, query.terms[0] || "") ? "title" : "content",
          snippet: query.empty ? snippetFor(entry.record, query, options.scope || "text") : snippetFor(entry.record, query, options.scope || "text")
        };
      })
    };
  }

  AE.search = { parse: parse, search: search, MAX_RESULTS: MAX_RESULTS };
  if (typeof module !== "undefined" && module.exports) module.exports = AE.search;
})();
