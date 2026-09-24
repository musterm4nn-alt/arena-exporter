/* Arena DOM fixture test — pins the markup contract src/lib/dom-extract.js
 * depends on ([role=log] turns, assistant cards, tool rows, artifact cards,
 * .prose). If Arena changes its layout, this fails loudly instead of
 * silently exporting empty turns.
 * Usage: node tests/dom-arena.test.js */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");

// --- minimal fake DOM: tag, [attr="v"], [attr*=v], [attr], .class ---

function parseSimple(part) {
  const out = { tag: null, classes: [], attrs: [] };
  const tagMatch = /^\s*([a-zA-Z][\w-]*)/.exec(part);
  if (tagMatch) out.tag = tagMatch[1].toUpperCase();
  for (const m of part.matchAll(/\.([\w-]+)/g)) out.classes.push(m[1]);
  for (const m of part.matchAll(/\[([\w-]+)(?:([*^$]?=)"([^"]*)")?\]/g)) {
    out.attrs.push({ name: m[1], op: m[2] || null, value: m[3] || null });
  }
  return out;
}

function matches(el, sel) {
  if (sel.tag && el.tagName !== sel.tag) return false;
  for (const c of sel.classes) {
    if (!(` ${el.attrs.class || ""} `.includes(` ${c} `)) && !(el.attrs.class || "").includes(c)) return false;
  }
  for (const a of sel.attrs) {
    const v = el.attrs[a.name];
    if (a.op === null) { if (v == null) return false; continue; }
    if (v == null) return false;
    if (a.op === "=" && v !== a.value) return false;
    if (a.op === "*=" && !v.includes(a.value)) return false;
  }
  return true;
}

let orderSeq = 0;
function element(tag, attrs, text) {
  const el = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    attrs: { ...(attrs || {}) },
    children: [],
    parent: null,
    order: orderSeq++,
    textContent: text || "",
    get innerText() { return this.textContent; },
    get className() { return this.attrs.class || ""; },
    getAttribute(k) { return this.attrs[k] != null ? this.attrs[k] : null; },
    hasAttribute(k) { return this.attrs[k] != null; },
    querySelectorAll(selector) {
      const parts = String(selector).split(",").map(parseSimple);
      const out = [];
      (function walk(node) {
        for (const child of node.children) {
          if (parts.some(p => matches(child, p))) out.push(child);
          walk(child);
        }
      })(this);
      return out;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    cloneNode() {
      const copy = element(this.tagName, { ...this.attrs }, this.textContent);
      copy.children = this.children.map(c => { const cc = c.cloneNode(); cc.parent = copy; return cc; });
      return copy;
    },
    remove() {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter(c => c !== this);
      this.parent = null;
    },
    compareDocumentPosition(other) {
      if (other === this) return 0;
      return other.order > this.order ? 4 : 2; // FOLLOWING : PRECEDING
    }
  };
  return el;
}

function append(parent, child) { child.parent = parent; parent.children.push(child); return child; }

// --- fixture: current Arena structure (see dom-extract.js header comment) ---

const doc = {
  byId: {},
  getElementById(id) { return this.byId[id] || null; },
  querySelectorAll(selector) { return this.root.querySelectorAll(selector); },
  querySelector(selector) { return this.root.querySelector(selector); }
};
doc.root = element("div", {});
const log = append(doc.root, element("div", { role: "log" }));
const userTurn = append(log, element("div", { class: "items-end flex-col" }));
const userProse = append(userTurn, element("div", { class: "prose" }, "Build me a landing page"));
const asstCard = append(log, element("div", { class: "rounded-xl overflow-hidden" }));
const toolRow = append(asstCard, element("div", { role: "button", "aria-label": "Expand" }, "Write cool.html 48 lines"));
const artifact = append(asstCard, element("div", { role: "button", class: "artifact card" }));
append(artifact, element("span", { class: "truncate text-sm" }, "cool.html"));
append(artifact, element("span", { class: "uppercase tracking" }, "HTML"));
const asstProse = append(asstCard, element("div", { class: "prose" }, "Done — open the preview."));

const context = vm.createContext({
  console, Promise, setTimeout, clearTimeout, JSON, Object, Array, String, Date,
  Node: { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 },
  location: { href: "https://arena.ai/c/fixture-turn", origin: "https://arena.ai", pathname: "/c/fixture-turn" },
  document: doc
});
vm.runInContext(fs.readFileSync(path.join(root, "src/lib/vote.js"), "utf8"), context);
vm.runInContext(fs.readFileSync(path.join(root, "src/lib/dom-extract.js"), "utf8"), context);
const AE = context.AE;

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.error("  ✗ " + name); }
}

console.log("Arena turn fixture:");
const out = AE.dom.extract();
check("arena strategy selected", out.strategy === "arena");
check("two turns extracted", out.messages.length === 2);
check("user turn first", out.messages[0].role === "user");
check("user prompt text", out.messages[0].content.some(b => b.type === "text" && b.text === "Build me a landing page"));
check("assistant turn second", out.messages[1].role === "assistant");
const tool = out.messages[1].content.find(b => b.type === "tool_call");
check("modern tool row mapped", !!tool && tool.tool_name === "create_file");
check("tool path kept", !!tool && tool.arguments && tool.arguments.path === "cool.html");
const art = out.messages[1].content.find(b => b.type === "artifact");
check("artifact card kept", !!art && art.title === "cool.html");
check("assistant prose kept", out.messages[1].content.some(b => b.type === "text" && /Done/.test(b.text)));
check("tool regions excluded from prose", !out.messages[1].content.some(b => b.type === "text" && /48 lines/.test(b.text || "")));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
