/* DOM-based extraction — fallback + completeness check.
 * Strategy (most robust first): data-testid/data-* attributes → ARIA
 * roles/labels → class heuristics. Before scraping, collapsed disclosure
 * controls (thinking panels, tool-call accordions) are expanded so the full
 * chain-of-thought is recoverable from the rendered page. */
var AE = AE || {};
AE.dom = {};

(function () {
  "use strict";

  var EXPAND_LABEL_RE = /(show|expand|view|reveal)[\s\S]{0,20}(thinking|reasoning|steps?|details?|tool|actions?|process)|^(thinking|show more)$/i;

  /* ---------- expand-before-scrape ---------- */

  AE.dom.expandCollapsed = function () {
    var clicked = 0;
    try {
      document.querySelectorAll("details:not([open])").forEach(function (d) {
        try { d.open = true; clicked++; } catch (e) {}
      });
      var nodes = document.querySelectorAll('button, [role="button"], summary');
      nodes.forEach(function (b) {
        var label = ((b.getAttribute("aria-label") || "") + " " + (b.textContent || "")).trim().replace(/\s+/g, " ");
        if (label && label.length < 60 && EXPAND_LABEL_RE.test(label)) {
          try { b.click(); clicked++; } catch (e) {}
        }
      });
      // arena.ai: collapsed file-operation rows inside the chat log.
      var log = document.querySelector('[role="log"]');
      if (log) {
        log.querySelectorAll('[role="button"][aria-expanded="false"][aria-label="Expand"]').forEach(function (b) {
          try { b.click(); clicked++; } catch (e) {}
        });
      }
    } catch (e) { /* ignore */ }
    // Give the app a beat to render expanded content before scraping.
    return new Promise(function (resolve) {
      setTimeout(function () { resolve(clicked); }, clicked ? 500 : 50);
    });
  };

  /* ---------- message container discovery ---------- */

  var CONTAINER_SELECTORS = [
    '[data-testid*="message" i]',
    '[data-testid*="turn" i]',
    '[data-testid*="chat-item" i]',
    '[data-message-id]',
    '[data-role]',
    '[id^="message-" i]'
  ];
  var FALLBACK_SELECTOR = '[class*="message" i]';

  function contains(root, el) {
    return root !== el && root.contains(el);
  }

  function findContainers() {
    var found = [];
    for (var i = 0; i < CONTAINER_SELECTORS.length; i++) {
      try { found = Array.from(document.querySelectorAll(CONTAINER_SELECTORS[i])); } catch (e) {}
      if (found.length >= 2) break;
    }
    if (found.length < 2) {
      try { found = Array.from(document.querySelectorAll(FALLBACK_SELECTOR)); } catch (e) {}
    }
    // Keep only elements with real content, drop ones nested inside another candidate.
    var candidates = found.filter(function (el) {
      return el && ((el.innerText || "").trim().length > 0 || el.querySelector("pre"));
    });
    return candidates.filter(function (el) {
      return !candidates.some(function (other) { return contains(other, el); });
    });
  }

  /* ---------- role inference ---------- */

  function inferRole(el, index, total) {
    var sig = [
      el.getAttribute("data-role") || "",
      el.getAttribute("data-testid") || "",
      el.getAttribute("class") || "",
      el.getAttribute("aria-label") || ""
    ].join(" ").toLowerCase();
    if (/(^|[\s_-])(user|human|prompt)([\s_-]|$)/.test(sig)) return "user";
    if (/(^|[\s_-])(assistant|agent|model|bot|ai)([\s_-]|$)/.test(sig)) return "assistant";
    // Weak positional heuristic; export meta marks DOM-sourced data.
    return index % 2 === 0 ? "user" : "assistant";
  }

  /* ---------- structured regions inside a container ---------- */

  var THINKING_SELECTORS = [
    '[data-testid*="thinking" i]',
    '[class*="thinking" i]',
    '[class*="reasoning" i]',
    '[aria-label*="thinking" i]'
  ];
  var TOOL_SELECTORS = [
    '[data-testid*="tool" i]',
    '[class*="tool-call" i]',
    '[class*="toolcall" i]',
    '[class*="tool_use" i]'
  ];
  var COMMAND_SELECTORS = [
    '[data-testid*="command" i]',
    '[class*="terminal" i]',
    '[class*="console-output" i]',
    '[class*="shell" i]'
  ];
  var ARTIFACT_SELECTORS = [
    '[data-testid*="artifact" i]',
    '[class*="artifact" i]',
    '[class*="preview-card" i]'
  ];

  function firstMatch(root, selectors) {
    for (var i = 0; i < selectors.length; i++) {
      try {
        var els = root.querySelectorAll(selectors[i]);
        if (els.length) return Array.from(els);
      } catch (e) {}
    }
    return [];
  }

  function clip(text, n) {
    text = (text || "").trim().replace(/\s+/g, " ");
    return text.length > n ? text.slice(0, n) + "…" : text;
  }

  /* ---------- arena.ai-specific extraction (from live DOM recon) ----------
   * Structure: [role="log"] → wrapper div → per-turn divs.
   *   user turns:      div[class*="items-end"][class*="flex-col"] bubbles
   *   assistant turns: div[class*="rounded-xl"][class*="overflow-hidden"] cards
   *     containing tool/file-op rows ([role=button][aria-label="Expand"]),
   *     artifact cards (class*=artifact with iframe srcdoc previews), and
   *     .prose response text. */

  function byDocOrder(a, b) {
    if (a === b) return 0;
    var rel = a.compareDocumentPosition(b);
    if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  function toArray(list) { return Array.prototype.slice.call(list); }

  function extractUserContent(el) {
    var text = "";
    toArray(el.querySelectorAll(".prose")).forEach(function (p) {
      var t = (p.innerText || "").trim();
      if (t) text += (text ? "\n\n" : "") + t;
    });
    if (!text) text = (el.innerText || "").trim();
    if (!text) return [];
    return [{ type: "text", text: text, format: "markdown", source: "dom" }];
  }

  function extractAssistantContent(el) {
    var content = [];

    // Tool / file-operation rows: "Write  cool.html  48 lines"
    toArray(el.querySelectorAll('[role="button"][aria-label="Expand"]')).forEach(function (row) {
      var verbEl = row.querySelector('span[class*="text-text-secondary"]');
      var fileEl = row.querySelector('span[class*="font-mono"]');
      var verb = verbEl ? verbEl.innerText.trim() : "";
      var file = fileEl ? fileEl.innerText.trim() : "";
      var summary = clip(row.innerText, 400);
      if (!summary) return;
      content.push({
        type: "tool_call",
        tool_name: verb || "unknown",
        call_id: null,
        arguments: file ? { file: file } : null,
        summary: summary,
        status: "success",
        source: "dom"
      });
    });

    // Artifact cards (title + type badge + iframe preview holding file source)
    toArray(el.querySelectorAll('div[role="button"][class*="artifact"]')).forEach(function (card) {
      var titleEl = card.querySelector('span[class*="truncate"][class*="text-sm"]');
      var badgeEl = card.querySelector('span[class*="uppercase"]');
      var iframe = card.querySelector("iframe");
      var srcdoc = iframe ? (iframe.getAttribute("srcdoc") || "") : "";
      content.push({
        type: "artifact",
        artifact_type: badgeEl ? badgeEl.innerText.trim().toLowerCase() : "unknown",
        title: titleEl ? titleEl.innerText.trim() : null,
        content_or_url: srcdoc ? srcdoc.slice(0, 16000) : null,
        truncated: srcdoc.length > 16000,
        source: "dom"
      });
    });

    // Response prose, excluding already-captured regions
    var clone = el.cloneNode(true);
    toArray(clone.querySelectorAll('[role="button"][aria-label="Expand"], div[role="button"][class*="artifact"], iframe')).forEach(function (n) {
      n.remove();
    });
    var text = "";
    toArray(clone.querySelectorAll(".prose")).forEach(function (p) {
      var t = (p.innerText || "").trim();
      if (t) text += (text ? "\n\n" : "") + t;
    });
    if (text) content.push({ type: "text", text: text, format: "markdown", source: "dom" });

    return content;
  }

  function extractArenaTurns() {
    var log = document.querySelector('[role="log"]');
    if (!log) return null;
    var userEls = toArray(log.querySelectorAll('div[class*="items-end"][class*="flex-col"]'));
    var asstEls = toArray(log.querySelectorAll('div[class*="rounded-xl"][class*="overflow-hidden"]'));
    var merged = userEls.map(function (el) { return { el: el, role: "user" }; })
      .concat(asstEls.map(function (el) { return { el: el, role: "assistant" }; }));
    if (!merged.length) return null;
    merged.sort(function (a, b) { return byDocOrder(a.el, b.el); });

    var messages = [];
    merged.forEach(function (turn, i) {
      var content = turn.role === "user" ? extractUserContent(turn.el) : extractAssistantContent(turn.el);
      if (!content.length) return;
      messages.push({
        id: "dom_msg_" + i,
        turn_index: i,
        role: turn.role,
        timestamp: null,
        content: content
      });
    });
    return messages;
  }

  /* ---------- main extraction ---------- */

  AE.dom.extract = function () {
    var messages = null;
    var strategy = "arena";
    try { messages = extractArenaTurns(); } catch (e) { messages = null; }
    if (!messages || !messages.length) {
      messages = extractGenericMessages();
      strategy = "generic";
    }
    return {
      source: "dom",
      url: location.href,
      extracted_at: new Date().toISOString(),
      strategy: strategy,
      messages: messages
    };
  };

  /* Generic container heuristic — fallback for unknown layouts. */
  function extractGenericMessages() {
    var containers = findContainers();
    var messages = [];

    containers.forEach(function (el, i) {
      var role = inferRole(el, i, containers.length);
      var content = [];

      // Thinking / reasoning regions
      firstMatch(el, THINKING_SELECTORS).forEach(function (t) {
        var text = (t.innerText || "").trim();
        if (text) content.push({ type: "thinking", text: text, source: "dom" });
      });

      // Tool calls
      firstMatch(el, TOOL_SELECTORS).forEach(function (t) {
        var text = (t.innerText || "").trim();
        if (!text) return;
        content.push({
          type: "tool_call",
          tool_name: guessToolName(t),
          call_id: null,
          arguments: null,
          summary: clip(text, 800),
          status: "unknown",
          source: "dom"
        });
      });

      // Commands / terminal output
      firstMatch(el, COMMAND_SELECTORS).forEach(function (c) {
        var text = (c.innerText || "").trim();
        if (text) content.push({ type: "command", command: clip(text, 1000), source: "dom" });
      });

      // Artifacts
      firstMatch(el, ARTIFACT_SELECTORS).forEach(function (a) {
        var text = (a.innerText || "").trim();
        if (text) {
          content.push({
            type: "artifact",
            artifact_type: "unknown",
            title: clip(text, 120),
            content_or_url: null,
            source: "dom"
          });
        }
      });

      // Visible text: clone the node and strip structured regions so prose
      // isn't duplicated alongside thinking/tool blocks.
      var clone = el.cloneNode(true);
      var stripSelectors = THINKING_SELECTORS.concat(TOOL_SELECTORS, COMMAND_SELECTORS, ARTIFACT_SELECTORS);
      stripSelectors.forEach(function (sel) {
        try { clone.querySelectorAll(sel).forEach(function (n) { n.remove(); }); } catch (e) {}
      });
      var text = (clone.innerText || "").trim();
      if (text) content.push({ type: "text", text: text, format: "markdown", source: "dom" });

      // Code blocks are captured separately to preserve fences/language hints.
      el.querySelectorAll("pre").forEach(function (pre) {
        var codeEl = pre.querySelector("code");
        var lang = "";
        var cls = (codeEl || pre).className || "";
        var m = /language-([\w+-]+)/.exec(cls);
        if (m) lang = m[1];
        var code = (codeEl || pre).innerText;
        if (code && code.trim()) {
          content.push({ type: "text", format: "code", language: lang || null, text: code, source: "dom" });
        }
      });

      if (content.length) {
        messages.push({
          id: "dom_msg_" + i,
          turn_index: i,
          role: role,
          timestamp: null,
          content: content
        });
      }
    });

    return messages;
  }

  function guessToolName(el) {
    var label = el.getAttribute("aria-label") || el.getAttribute("data-testid") || "";
    var firstLine = ((el.innerText || "").split("\n")[0] || "").trim();
    return clip(label || firstLine || "unknown", 60);
  }

  /* ---------- diagnostics (selector recon) ---------- */

  var DEBUG_ROOT_SELECTORS = [
    "main", "[role='main']", "#main", "#root", "#__next", "#app",
    "[id*='chat' i]", "[class*='chat' i]", "[class*='conversation' i]", "[class*='thread' i]"
  ];

  /* The dump exists to tune selectors, and the popup invites the user to share
   * it — so it must carry structure, not content. Text nodes and content-ish
   * attributes are clipped to a recognisable stub; class/data/role attributes
   * (the things selectors actually match on) keep a generous budget. */
  var DEBUG_TEXT_KEEP = 24;
  var DEBUG_ATTR_KEEP = 40;
  var DEBUG_STRUCTURAL_ATTR_KEEP = 300;
  var DEBUG_HTML_CAP = 40000;
  var STRUCTURAL_ATTR_RE = /^(class|id|role|type|name|data-[\w-]+|aria-(?:expanded|hidden|roledescription|selected|checked|pressed|disabled|level))$/i;
  var DROP_ATTR_RE = /^(srcdoc|src|href|content|value|alt|placeholder)$/i;

  function stub(len) { return "…[+" + len + " chars]"; }

  function redactAttributes(el) {
    var attrs = el.attributes;
    if (!attrs) return;
    for (var i = attrs.length - 1; i >= 0; i--) {
      var name = attrs[i].name;
      var value = attrs[i].value || "";
      if (!value) continue;
      if (DROP_ATTR_RE.test(name) || value.indexOf("data:") === 0) {
        /* srcdoc holds whole generated files; data: URLs hold whole images. */
        try { el.setAttribute(name, "[redacted " + value.length + " chars]"); } catch (e) {}
        continue;
      }
      var structural = STRUCTURAL_ATTR_RE.test(name);
      var cap = structural ? DEBUG_STRUCTURAL_ATTR_KEEP : DEBUG_ATTR_KEEP;
      if (value.length > cap) {
        /* Structural values (class lists) are truncated because their prefix is
         * still useful for selectors; content values are replaced outright. */
        var replacement = structural ? value.slice(0, cap) + stub(value.length - cap)
                                     : "[redacted " + value.length + " chars]";
        try { el.setAttribute(name, replacement); } catch (e) {}
      }
    }
  }

  function sanitizedOuterHTML(el) {
    var clone;
    try { clone = el.cloneNode(true); } catch (e) { return ""; }
    try {
      var walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT, null);
      var texts = [];
      while (walker.nextNode()) texts.push(walker.currentNode);
      texts.forEach(function (n) {
        var t = n.nodeValue || "";
        /* Anything longer than a UI label is prose. Replace it whole — keeping
         * even a short prefix would still leak the opening of every message. */
        if (t.trim().length > DEBUG_TEXT_KEEP) n.nodeValue = "[text " + t.length + " chars]";
      });
      redactAttributes(clone);
      var all = clone.querySelectorAll("*");
      for (var i = 0; i < all.length; i++) redactAttributes(all[i]);
    } catch (e) { /* best effort — fall through to whatever the clone holds */ }
    return clone.outerHTML || "";
  }

  /* Same idea for the extractor's own output: keep the shape, drop the prose. */
  var DEBUG_KEEP_KEYS = {
    type: 1, role: 1, format: 1, source: 1, strategy: 1, id: 1, turn_index: 1,
    tool_name: 1, artifact_type: 1, status: 1, language: 1, lane: 1, call_id: 1,
    truncated: 1, timestamp: 1, extracted_at: 1, url: 1
  };

  AE.dom.redact = function (value, key) {
    if (Array.isArray(value)) return value.map(function (v) { return AE.dom.redact(v); });
    if (value && typeof value === "object") {
      var out = {};
      Object.keys(value).forEach(function (k) { out[k] = AE.dom.redact(value[k], k); });
      return out;
    }
    if (typeof value === "string" && !DEBUG_KEEP_KEYS[key] && value.length > DEBUG_TEXT_KEEP) {
      return "[text " + value.length + " chars]";
    }
    return value;
  };

  AE.dom.debugInfo = function () {
    var info = {
      url: location.href,
      title: document.title,
      body_class: String(document.body.className || "").slice(0, 300),
      next_data: !!window.document.getElementById("__NEXT_DATA__"),
      redacted: true,
      redaction_note: "Text longer than " + DEBUG_TEXT_KEEP + " chars removed entirely; srcdoc/src/href/value/alt and data: URLs removed; class/data/role/aria attributes preserved for selector tuning.",
      selector_hits: {},
      containers: []
    };

    CONTAINER_SELECTORS.concat([FALLBACK_SELECTOR]).forEach(function (sel) {
      try { info.selector_hits[sel] = document.querySelectorAll(sel).length; }
      catch (e) { info.selector_hits[sel] = "error"; }
    });

    // Sample the outer HTML of likely chat roots so real selectors can be
    // derived offline. Bounded hard, and redacted so the dump is shareable.
    var seenRoots = new Set();
    DEBUG_ROOT_SELECTORS.forEach(function (sel) {
      var els;
      try { els = document.querySelectorAll(sel); } catch (e) { return; }
      Array.prototype.forEach.call(els, function (el) {
        if (seenRoots.has(el) || info.containers.length >= 6) return;
        seenRoots.add(el);
        var html = sanitizedOuterHTML(el);
        info.containers.push({
          selector: sel,
          tag: el.tagName,
          id: el.id || null,
          className: String(el.className || "").slice(0, 300),
          html_chars: (el.outerHTML || "").length,
          html_redacted_chars: html.length,
          html: html.slice(0, DEBUG_HTML_CAP)
        });
      });
    });

    return info;
  };

  /* ---------- battle vote + attribution from DOM ----------
   * Arena's ballot has four semantic outcomes: A is better, B is better,
   * Both are good, and Neither. The click is captured by content.js, while
   * this DOM pass handles exports made after a reload and maps revealed model
   * names / green result cards to lanes. */

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

  AE.dom.normalizeVoteChoice = normalizeVoteChoice;

  AE.dom.isPlaceholderModel = function (name) {
    return AE.isPlaceholderModel ? AE.isPlaceholderModel(name) : /^(?:response|model)\s*[ab]$/i.test(String(name || "").trim());
  };

  /* A ballot control says "A is better" or "Both are good". Anything longer is
   * page prose, and normalizeVoteChoice is loose enough to find "both ... good"
   * or "neither" inside an expanded thinking panel — which is exactly how real
   * exports ended up with fabricated outcomes. Match short labels only. */
  var VOTE_LABEL_MAX = 80;

  /* Shared by the content-script click handler and Node click tests. */
  AE.dom.voteFromPath = function (path) {
    if (!path || !path.length) return null;
    for (var i = 0; i < path.length; i++) {
      var node = path[i];
      if (!node || node.nodeType !== 1) continue;
      var tag = String(node.tagName || "").toLowerCase();
      var testid = String(node.getAttribute ? node.getAttribute("data-testid") : "" || "");
      var voteAttr = (node.hasAttribute && (node.hasAttribute("data-vote") || node.hasAttribute("data-choice"))) ||
        /vote|better|neither|both/i.test(testid);
      var isControl = tag === "button" || tag === "input" ||
        (node.getAttribute && node.getAttribute("role") === "button") || voteAttr;
      var labelParts = [];
      if (node.getAttribute) {
        ["aria-label", "title", "data-vote", "data-choice", "data-testid"].forEach(function (a) {
          labelParts.push(node.getAttribute(a) || "");
        });
      }
      labelParts.push(node.value || "");
      var attrLabel = labelParts.join(" ").replace(/\s+/g, " ").trim();
      var nodeText = String(node.textContent || "").replace(/\s+/g, " ").trim();
      var label = (attrLabel + " " + nodeText).replace(/\s+/g, " ").trim();
      var choice = label.length <= VOTE_LABEL_MAX ? normalizeVoteChoice(label) : null;
      if (!choice && attrLabel && attrLabel.length <= VOTE_LABEL_MAX) {
        choice = normalizeVoteChoice(attrLabel);
        if (choice) label = attrLabel;
      }
      if (!choice && nodeText && nodeText.length <= VOTE_LABEL_MAX) {
        choice = normalizeVoteChoice(nodeText);
        if (choice) label = nodeText;
      }
      if (!choice) continue;
      var shortAB = /^(?:model\s*)?[ab]$/i.test(String(label || "").replace(/\s+/g, " ").trim());
      if (!isControl && !shortAB) {
        /* Phrase on a non-control (div) is OK; lone A/B is not. */
      }
      if (!isControl && shortAB) continue;
      if (shortAB && !voteAttr && !inBallotSubtree(node)) continue;
      return { node: node, choice: choice, label: label };
    }
    return null;
  };

  function inBallotSubtree(node) {
    var n = node;
    while (n && n.nodeType === 1) {
      var sig = [
        (n.getAttribute && n.getAttribute("data-testid")) || "",
        (n.getAttribute && n.getAttribute("aria-label")) || "",
        n.className || "",
        n.id || ""
      ].join(" ").toLowerCase();
      if (/vote|ballot|preference|which.?better|neither|both.?good/.test(sig)) return true;
      n = n.parentElement;
    }
    return false;
  }

  function stripTags(html) {
    var t = String(html || "").replace(/<[^>]+>/g, " ");
    t = t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
         .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
    return t.replace(/\s+/g, " ").trim();
  }

  function paneResponseText(pane) {
    var parts = [];
    var prose = pane.querySelectorAll(".prose");
    for (var i = 0; i < prose.length; i++) {
      var t = (prose[i].innerText || "").trim();
      if (t) parts.push(t);
    }
    if (parts.length) return parts.join("\n\n");
    // Fallback: whole pane text minus the "Message from X" header line.
    var all = (pane.innerText || "").replace(/Message from\s+[^\n]+\n?/, "");
    return all.replace(/\s+$/g, "").trim();
  }

  function sliceResponsesBetweenHeaders(models) {
    var html = document.body.innerHTML || "";
    var re = /Message from\s+([^<"]{1,60})/g;
    var m, matches = [];
    while ((m = re.exec(html))) matches.push({ end: re.lastIndex, next: m.index });
    var last = matches.slice(-2);
    var out = [null, null];
    for (var i = 0; i < last.length; i++) {
      var start = last[i].end;
      var end = (i + 1 < last.length) ? last[i + 1].next : html.length;
      if (end - start > 20000) end = start + 20000;
      out[i] = stripTags(html.slice(start, end));
    }
    return out;
  }

  function compactText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function controlLabel(el) {
    if (!el) return "";
    return compactText([
      el.getAttribute("aria-label") || "",
      el.getAttribute("title") || "",
      el.getAttribute("data-vote") || "",
      el.getAttribute("data-choice") || "",
      el.getAttribute("data-testid") || "",
      el.getAttribute("name") || "",
      el.getAttribute("value") || "",
      el.textContent || ""
    ].join(" "));
  }

  function isVoteControl(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = String(el.tagName || "").toLowerCase();
    return tag === "button" || tag === "input" || el.getAttribute("role") === "button" ||
      el.hasAttribute("data-vote") || el.hasAttribute("data-choice") ||
      /vote|better|neither|both/i.test(String(el.getAttribute("data-testid") || ""));
  }

  function isVisible(el) {
    if (!el) return false;
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
    var cls = String(el.className || "").toLowerCase();
    if (/(^|[\s_:\-])hidden(?:$|[\s_:\-])/.test(cls)) return false;
    try {
      var style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
    } catch (e) { /* computed style unavailable in a diagnostic context */ }
    return true;
  }

  function hasTruthyState(el) {
    var attrs = ["aria-pressed", "aria-selected", "aria-checked", "data-selected", "data-checked", "data-active", "data-state", "data-voted"];
    for (var i = 0; i < attrs.length; i++) {
      var value = el.getAttribute(attrs[i]);
      if (value && /^(true|yes|on|selected|checked|active|pressed|chosen|voted)$/i.test(value)) return true;
    }
    try {
      if (el.matches(":checked, :selected")) return true;
    } catch (e) { /* selector may not apply to this element */ }
    var cls = String(el.className || "").toLowerCase();
    if (/(^|[\s_-])(?:selected|checked|pressed|chosen|current|voted)(?:$|[\s_-])/.test(cls)) return true;
    return false;
  }

  function collectVoteControls() {
    var out = [];
    var selector = 'button, [role="button"], input[type="button"], input[type="submit"], [data-vote], [data-choice], [data-testid*="vote" i], [aria-label*="better" i]';
    var els;
    try { els = document.querySelectorAll(selector); } catch (e) { return out; }
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!isVoteControl(el)) continue;
      var label = controlLabel(el);
      var choice = normalizeVoteChoice(label);
      if (!choice) continue;
      out.push({
        el: el,
        choice: choice,
        label: label,
        selected: hasTruthyState(el),
        visible: isVisible(el),
        disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true"
      });
    }
    return out;
  }

  function selectedVoteFromControls(controls) {
    var selected = controls.filter(function (c) { return c.selected; });
    var choices = [];
    selected.forEach(function (c) {
      if (choices.indexOf(c.choice) === -1) choices.push(c.choice);
    });
    if (!choices.length) return null;
    // A UI that highlights both individual lanes is equivalent to "Both are good".
    if (choices.indexOf("both_good") !== -1) return { choice: "both_good", label: selected[0].label, source: "dom_selection" };
    if (choices.indexOf("neither_good") !== -1) return { choice: "neither_good", label: selected[0].label, source: "dom_selection" };
    if (choices.indexOf("A") !== -1 && choices.indexOf("B") !== -1) return { choice: "both_good", label: "A and B selected", source: "dom_selection" };
    if (choices.length === 1) return { choice: choices[0], label: selected[0].label, source: "dom_selection" };
    return null;
  }

  function headerCandidates() {
    var candidates = [];
    var els;
    try { els = document.querySelectorAll("body *"); } catch (e) { return candidates; }
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var text = compactText(el.textContent || "");
      if (text.length < 13 || text.length > 100) continue;
      var m = text.match(/^Message\s+from\s+(.{1,80})$/i);
      if (!m) continue;
      candidates.push({ name: compactText(m[1]), node: el });
    }
    // Keep the innermost exact-text element when wrappers repeat the header.
    return candidates.filter(function (candidate, index, all) {
      return !all.some(function (other, j) {
        return j !== index && other.node !== candidate.node &&
          other.node.contains(candidate.node) &&
          compactText(other.node.textContent || "") === compactText(candidate.node.textContent || "");
      });
    });
  }

  function sortHeaders(headers) {
    return headers.slice().sort(function (a, b) {
      if (a.node === b.node) return 0;
      var rel = a.node.compareDocumentPosition(b.node);
      if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
  }

  function headerForGreenElement(green, headers) {
    if (!green) return null;
    // Most Arena result borders are on the pane/card that contains its header.
    for (var i = 0; i < headers.length; i++) {
      if (green === headers[i].node || green.contains(headers[i].node)) return headers[i];
    }
    // If the positive class is on a descendant of the pane, climb until the
    // ancestor contains exactly one revealed model header.
    var cur = green.parentElement;
    while (cur && cur !== document.body) {
      var local = headers.filter(function (h) { return cur.contains(h.node); });
      if (local.length === 1) return local[0];
      cur = cur.parentElement;
    }
    // Last-resort document-order attribution for split/custom DOM nodes.
    var best = null;
    for (var j = 0; j < headers.length; j++) {
      var relation = headers[j].node.compareDocumentPosition(green);
      if (relation & Node.DOCUMENT_POSITION_FOLLOWING) best = headers[j];
    }
    return best;
  }

  AE.dom.battleInfo = function () {
    var models = [];
    var vote = null;
    var winnerModel = null;
    var greenLanes = [];
    var negativeLanes = [];
    var controls = [];
    var ballotVisible = false;
    try {
      controls = collectVoteControls();
      ballotVisible = controls.some(function (c) { return c.visible && !c.disabled; });
      vote = selectedVoteFromControls(controls);

      var headers = sortHeaders(headerCandidates());
      // A /c/ page can hold several battles. Attribute the current result to the
      // latest pair, matching the latest evaluation stream captured by the SW.
      var lastTwo = headers.slice(-2);
      models = lastTwo.map(function (h) { return h.name; }).filter(function (n) {
        return n && !(AE.isPlaceholderModel && AE.isPlaceholderModel(n));
      });

      var greenSelector = '[class*="border-interactive-positive" i], [class*="bg-interactive-positive" i], [data-winner="true"], [aria-label*="winner" i]';
      var greenEls = document.querySelectorAll(greenSelector);
      for (var gi = 0; gi < greenEls.length; gi++) {
        var header = headerForGreenElement(greenEls[gi], lastTwo);
        if (!header) continue;
        var lane = lastTwo.indexOf(header) === 0 ? "A" : lastTwo.indexOf(header) === 1 ? "B" : null;
        if (lane && greenLanes.indexOf(lane) === -1) greenLanes.push(lane);
      }
      var negativeSelector = '[class*="border-interactive-negative" i], [class*="border-negative" i], [class*="border-red" i]';
      var negativeEls = document.querySelectorAll(negativeSelector);
      for (var ni = 0; ni < negativeEls.length; ni++) {
        var negativeHeader = headerForGreenElement(negativeEls[ni], lastTwo);
        if (!negativeHeader) continue;
        var negativeLane = lastTwo.indexOf(negativeHeader) === 0 ? "A" : lastTwo.indexOf(negativeHeader) === 1 ? "B" : null;
        if (negativeLane && negativeLanes.indexOf(negativeLane) === -1) negativeLanes.push(negativeLane);
      }
      if (!vote && greenLanes.length === 1 && models.length === 2) {
        winnerModel = models[greenLanes[0] === "A" ? 0 : 1];
      }

      // ---- Pane-aware pass (more accurate winner + response text) ----
      // Each battle pane is a carousel slide containing its own "Message from"
      // header, result card, and response prose. When present, use slide
      // containment for the winner (exact) and extract the visible response.
      var responses = [null, null];
      var slides = document.querySelectorAll('[aria-roledescription="slide"]');
      if (slides.length >= 2) {
        var slidePanes = [];
        for (var si = 0; si < slides.length; si++) {
          var sm = (slides[si].innerHTML || "").match(/Message from\s+([^<"]{1,60})/);
          slidePanes.push({
            model: sm ? sm[1].trim() : null,
            green: !!slides[si].querySelector('[class*="border-interactive-positive" i]'),
            response: paneResponseText(slides[si])
          });
        }
        var lastSlides = slidePanes.slice(-2);
        if (lastSlides.length === 2 && lastSlides[0].model && lastSlides[1].model) {
          var slideModels = [lastSlides[0].model, lastSlides[1].model].filter(function (n) {
            return n && !(AE.isPlaceholderModel && AE.isPlaceholderModel(n));
          });
          if (slideModels.length === 2) models = slideModels;
          responses = [lastSlides[0].response, lastSlides[1].response];
          var greenIdx = -1;
          for (var g2 = 0; g2 < 2; g2++) if (lastSlides[g2].green) greenIdx = g2;
          var greenCount = lastSlides.filter(function (p) { return p.green; }).length;
          if (greenCount === 1) { winnerModel = models[greenIdx]; greenLanes = [greenIdx === 0 ? "A" : "B"]; }
        }
      } else {
        // Fallback: response text = rendered HTML between consecutive headers.
        responses = sliceResponsesBetweenHeaders(models);
      }

      // A selected ballot control is stronger than the presence of its label.
      // `preVoteBallot` is therefore false after a selected/disabled result,
      // unlike the old body-wide text regex which stayed true on /c/ pages.
      if (!vote) {
        var disabledChoices = controls.filter(function (c) { return c.disabled; }).map(function (c) { return c.choice; });
        var uniqueDisabled = disabledChoices.filter(function (x, i, a) { return a.indexOf(x) === i; });
        if (uniqueDisabled.length === 1 && !ballotVisible) {
          vote = { choice: uniqueDisabled[0], label: "disabled ballot control", source: "dom_disabled_control" };
        }
      }
    } catch (e) { /* ignore */ }
    return {
      models: models,
      anonymous: models.length < 2,
      preVoteBallot: ballotVisible && !vote,
      ballotVisible: ballotVisible,
      vote: vote,
      vote_choice: vote ? vote.choice : null,
      greenLanes: greenLanes,
      negativeLanes: negativeLanes,
      winnerModel: winnerModel,
      responses: responses
    };
  };

  /* ---------- attachment fetching (ported from v1.4.0 fork) ----------
   * Fetch artifact bytes same-origin (credentials included so preview-token
   * URLs work while logged in) and return them as data URLs. Bounded.
   * Only arena.ai (and blob:) URLs are fetched — a redirected content_or_url
   * must not become a credentialed request to a third party. */
  var ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024;

  AE.dom.isAllowedAttachmentUrl = function (url) {
    try {
      var base = "https://arena.ai/";
      try {
        if (typeof location !== "undefined" && location.href) base = location.href;
      } catch (e) { /* tests */ }
      var u = new URL(String(url), base);
      if (u.protocol === "blob:") return true;
      if (u.protocol !== "https:") return false;
      return /^([a-z0-9-]+\.)*arena\.ai$/i.test(u.hostname);
    } catch (e) {
      return false;
    }
  };

  AE.dom.fetchAttachment = function (url) {
    if (!AE.dom.isAllowedAttachmentUrl(url)) {
      return Promise.resolve({ url: url, ok: false, error: "blocked origin" });
    }
    return fetch(url, { credentials: "include", cache: "no-store" })
      .then(function (resp) {
        if (!resp.ok) return { url: url, ok: false, error: "HTTP " + resp.status };
        var ct = "";
        try { ct = (resp.headers.get("content-type") || "").split(";")[0]; } catch (e) { /* ignore */ }
        return resp.blob().then(function (blob) {
          if (blob.size > ATTACHMENT_MAX_BYTES) {
            return { url: url, ok: false, error: "too large (" + Math.round(blob.size / 1024) + " KB)" };
          }
          return new Promise(function (resolve) {
            var fr = new FileReader();
            fr.onload = function () { resolve({ url: url, ok: true, dataUrl: fr.result, bytes: blob.size, contentType: ct }); };
            fr.onerror = function () { resolve({ url: url, ok: false, error: "read error" }); };
            try { fr.readAsDataURL(blob); } catch (e) { resolve({ url: url, ok: false, error: "read error" }); }
          });
        });
      })
      .catch(function (e) {
        return { url: url, ok: false, error: String((e && e.message) || e).slice(0, 120) };
      });
  };
})();

