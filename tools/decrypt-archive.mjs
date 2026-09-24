#!/usr/bin/env node
/* Decrypt an Arena Exporter conversation.enc bundle from the command line. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const input = args[0];
const passwordIndex = args.indexOf("--password");
const password = passwordIndex >= 0 ? args[passwordIndex + 1] : process.env.ARENA_ARCHIVE_PASSWORD;
const outputIndex = args.indexOf("--out");
const output = outputIndex >= 0 ? args[outputIndex + 1] : input && input.replace(/\.enc(?:\.json)?$/i, "") + ".decrypted";
if (!input || !password || !output) {
  console.error("Usage: node tools/decrypt-archive.mjs <conversation.enc> --password <password> [--out <directory>]");
  process.exit(2);
}
const envelope = JSON.parse(fs.readFileSync(input, "utf8"));
const version = Number(envelope.version);
if (envelope.format !== "arena-encrypted-archive" || (version !== 1 && version !== 2)) throw new Error("Unsupported encrypted archive format.");
const iterations = Number(envelope.iterations);
if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 2000000) throw new Error("Archive encryption KDF parameters are invalid.");
const b64 = value => Buffer.from(String(value || ""), "base64");
const salt = b64(envelope.salt);
const derived = crypto.pbkdf2Sync(password, salt, iterations, version === 1 ? 32 : 64, "sha256");
const key = version === 1 ? derived : derived.subarray(0, 32);
const ciphertext = b64(envelope.ciphertext);
const tag = ciphertext.subarray(ciphertext.length - 16);
const body = ciphertext.subarray(0, ciphertext.length - 16);
const decipher = crypto.createDecipheriv("aes-256-gcm", key, b64(envelope.iv));
decipher.setAuthTag(tag);
const plain = Buffer.concat([decipher.update(body), decipher.final()]);
const bundle = JSON.parse(plain.toString("utf8"));
if (bundle.format !== "arena-encrypted-archive" || (Number(bundle.version) !== 1 && Number(bundle.version) !== 2) || !Array.isArray(bundle.files)) throw new Error("Encrypted bundle is invalid.");
fs.mkdirSync(output, { recursive: true });
for (const file of bundle.files) {
  const rel = String(file.path || "").replace(/\\/g, "/");
  if (!rel || rel.startsWith("/") || rel.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Bundle contains an unsafe path.");
  const destination = path.resolve(output, rel);
  if (!destination.startsWith(path.resolve(output) + path.sep)) throw new Error("Bundle path escapes output directory.");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const content = String(file.content || "");
  if (file.encoding === "base64") fs.writeFileSync(destination, b64(content));
  else if (file.encoding === "dataurl") {
    const comma = content.indexOf(",");
    const metadata = comma >= 0 ? content.slice(0, comma).toLowerCase() : "";
    const body = comma >= 0 ? content.slice(comma + 1) : content;
    fs.writeFileSync(destination, metadata.includes(";base64") ? b64(body) : Buffer.from(decodeURIComponent(body), "utf8"));
  } else fs.writeFileSync(destination, content, "utf8");
}
console.log(`Decrypted ${bundle.files.length} file(s) into ${output}`);
