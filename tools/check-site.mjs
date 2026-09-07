#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const site = path.join(root, "site");
const required = ["index.html", "styles.css", "script.js"];
for (const file of required) {
  const full = path.join(site, file);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error("Missing static-site file: site/" + file);
}
const html = fs.readFileSync(path.join(site, "index.html"), "utf8");
for (const phrase of ["Arena Exporter", "Agent", "Battle", "Direct", "Side-by-Side", "Chrome", "Firefox", "GitHub", "privacy"]) {
  if (!html.toLowerCase().includes(phrase.toLowerCase())) throw new Error("Site is missing required content: " + phrase);
}
if (!/href=["']https:\/\/github\.com\/musterm4nn-alt\/arena-exporter/.test(html)) throw new Error("Site needs a repository call-to-action.");
if (/<script[^>]+src=["']https?:\/\//i.test(html) || /<link[^>]+href=["']https?:\/\/[^"']+["'][^>]*rel=["']stylesheet/i.test(html)) {
  throw new Error("Presentation site must not require remote runtime assets.");
}
for (const ref of [...html.matchAll(/(?:href|src)=["']([^"']+)["']/g)].map(m => m[1])) {
  if (/^(?:https?:|#|mailto:|javascript:)/i.test(ref)) continue;
  const clean = ref.split(/[?#]/)[0];
  if (clean && !fs.existsSync(path.join(site, clean))) throw new Error("Broken local site asset: " + ref);
}
const syntax = spawnSync(process.execPath, ["--check", path.join(site, "script.js")], { stdio: "inherit" });
if (syntax.status !== 0) process.exit(syntax.status || 1);
console.log("Static presentation site is self-contained and passed structural checks.");
