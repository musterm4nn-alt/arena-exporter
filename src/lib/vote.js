/* Shared battle-vote normalization.
 *
 * Single source for ballot-label parsing, used by the background battle
 * reconstruction (src/battles.js) and the isolated-world DOM extractor
 * (src/lib/dom-extract.js). Both worlds must agree exactly: a loose matcher
 * turns page prose into fabricated votes, a strict one drops real ballots.
 * Classic-script globals — loaded via importScripts / content bundle, and
 * before src/battles.js and src/lib/dom-extract.js wherever they run.
 */
var AE = AE || {};
AE.dom = AE.dom || {};

function normalizeVoteChoice(value) {
  var t = String(value == null ? "" : value).replace(/\s+/g, " ").trim().toLowerCase();
  if (!t) return null;
  if (/\bneither\b|\bnone\s+(?:are|is)\s+good\b/.test(t)) return "neither_good";
  if (/\bboth\b.*\b(?:good|great|fine|acceptable|better)\b/.test(t) || /\bboth\s+are\s+good\b/.test(t)) return "both_good";
  if (/(?:^|\b)(?:model\s*)?a(?:\b|\s).*(?:\bbetter\b|\bwin(?:s|ner)?\b|\bprefer(?:red)?\b)/.test(t) ||
      /(?:^|\b)(?:choose|select|vote\s+for)\s+(?:model\s*)?a\b/.test(t)) return "A";
  if (/(?:^|\b)(?:model\s*)?b(?:\b|\s).*(?:\bbetter\b|\bwin(?:s|ner)?\b|\bprefer(?:red)?\b)/.test(t) ||
      /(?:^|\b)(?:choose|select|vote\s+for)\s+(?:model\s*)?b\b/.test(t)) return "B";
  if (/^(?:vote|choice|option|model)[ _-]*a(?:[_ -]?(?:better|winner|win))?$/.test(t)) return "A";
  if (/^(?:vote|choice|option|model)[ _-]*b(?:[_ -]?(?:better|winner|win))?$/.test(t)) return "B";
  if (/^a$/.test(t)) return "A";
  if (/^b$/.test(t)) return "B";
  if (/^both(?:[_ -]good)?$/.test(t)) return "both_good";
  if (/^(?:neither|none)(?:[_ -]good)?$/.test(t)) return "neither_good";
  return null;
}

function normalizeBattleVoteChoice(value) {
  return normalizeVoteChoice(value);
}

AE.normalizeVoteChoice = normalizeVoteChoice;
AE.normalizeBattleVoteChoice = normalizeBattleVoteChoice;
AE.dom.normalizeVoteChoice = normalizeVoteChoice;
