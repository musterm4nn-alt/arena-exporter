#!/usr/bin/env node
/* Dependency-free validator for the JSON Schema keywords used by the project. */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
const { worker } = require("../tests/worker-harness");
const exportSchema = JSON.parse(fs.readFileSync(path.join(root, "schemas/export-2.1.schema.json"), "utf8"));
const streamSchema = JSON.parse(fs.readFileSync(path.join(root, "schemas/streaming-2.1.schema.json"), "utf8"));
const input = process.argv[2];
let payload;
let jsonlText = null;
if (input && /\.jsonl$/i.test(input)) {
  jsonlText = fs.readFileSync(path.resolve(input), "utf8");
  const first = jsonlText.split(/\r?\n/).find(Boolean);
  if (!first) throw new Error("JSONL input is empty");
  payload = null;
} else if (input) {
  payload = JSON.parse(fs.readFileSync(path.resolve(input), "utf8"));
} else {
  const w = worker();
  await w.ready();
  const tab = { id: 91, url: "https://arena.ai/c/schema-fixture" };
  await w.event({ kind: "page_context", url: tab.url, conversationKey: "c:schema-fixture", title: "Schema fixture" }, tab);
  await w.event({ kind: "json", url: "https://arena.ai/api/chat/schema-fixture", data: { role: "user", content: "Schema prompt" } }, tab);
  await w.event({ kind: "json", url: "https://arena.ai/api/chat/schema-fixture", data: { role: "assistant", content: "Schema answer" } }, tab);
  payload = await w.export("c:schema-fixture");
  jsonlText = w.context.AE.renderJsonl(payload);
}

function resolveRef(ref, schema) {
  if (!ref.startsWith("#/")) throw new Error(`Unsupported schema reference: ${ref}`);
  return ref.slice(2).split("/").reduce((value, key) => value && value[key.replace(/~1/g, "/").replace(/~0/g, "~")], schema);
}
function typeMatches(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}
function validate(schema, value, rootSchema, label, errors = []) {
  if (schema.$ref) {
    validate(resolveRef(schema.$ref, rootSchema), value, rootSchema, label, errors);
    return errors;
  }
  if (schema.oneOf) {
    const branchErrors = schema.oneOf.map((branch, index) => {
      const current = [];
      validate(branch, value, rootSchema, `${label} (oneOf ${index})`, current);
      return current;
    });
    if (branchErrors.filter(items => items.length === 0).length !== 1) errors.push(`${label}: must match exactly one schema branch`);
    return errors;
  }
  if (Object.prototype.hasOwnProperty.call(schema, "const") && value !== schema.const) errors.push(`${label}: expected ${JSON.stringify(schema.const)}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(type => typeMatches(value, type))) errors.push(`${label}: expected ${types.join(" or ")}`);
  }
  if (schema.type === "object" || (!schema.type && value !== null && typeof value === "object" && !Array.isArray(value))) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return errors;
    for (const required of schema.required || []) if (!Object.prototype.hasOwnProperty.call(value, required)) errors.push(`${label}: missing ${required}`);
    const properties = schema.properties || {};
    for (const [key, child] of Object.entries(properties)) if (Object.prototype.hasOwnProperty.call(value, key)) validate(child, value[key], rootSchema, `${label}.${key}`, errors);
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!Object.prototype.hasOwnProperty.call(properties, key)) errors.push(`${label}: unexpected ${key}`);
  }
  if ((schema.type === "array" || (!schema.type && Array.isArray(value))) && Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${label}: expected at least ${schema.minItems} item(s)`);
    if (schema.items) value.forEach((child, index) => validate(schema.items, child, rootSchema, `${label}[${index}]`, errors));
  }
  if ((schema.type === "number" || schema.type === "integer") && typeof value === "number" && schema.minimum != null && value < schema.minimum) errors.push(`${label}: below minimum`);
  if (schema.type === "string" && typeof value === "string" && schema.format === "date-time" && Number.isNaN(Date.parse(value))) errors.push(`${label}: invalid date-time`);
  return errors;
}
function assertValid(schema, value, label) {
  const errors = validate(schema, value, schema, label);
  if (errors.length) throw new Error(errors.slice(0, 12).join("; "));
}

if (payload) assertValid(exportSchema, payload, "export");
if (jsonlText) {
  const records = jsonlText.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  records.forEach((record, index) => assertValid(streamSchema, record, `jsonl[${index}]`));
}
console.log(`Schema validation passed for export 2.1${payload ? ` (${payload.messages.length} messages, ${payload.battles.length} battles)` : " JSONL"}.`);
