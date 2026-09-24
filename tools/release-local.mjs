#!/usr/bin/env node
/* Local-only release pipeline. It never pushes, publishes, or contacts GitHub. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const has = flag => args.includes(flag);
const value = flag => {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const next = args[index + 1];
  return next && !next.startsWith("-") ? next : null;
};
const skipTests = has("--skip-tests");
const signKey = value("--sign-key");
const installHost = has("--install-native-host");
const hostPath = value("--host");
const nativeHost = value("--native-host");
const resolveFromRoot = file => path.isAbsolute(file) ? file : path.resolve(root, file);
const outputDir = resolveFromRoot(value("--output") || "dist");
const dryRun = has("--dry-run");
const requireBrowser = has("--require-browser");
const runAcceptance = has("--acceptance") || requireBrowser;

if (has("--help")) {
  console.log("Usage: node tools/release-local.mjs [--skip-tests] [--acceptance] [--require-browser] [--output DIR] [--sign-key PEM_KEY] [--native-host PATH] [--install-native-host --host PATH] [--dry-run]");
  process.exit(0);
}
if (installHost && !hostPath) {
  console.error("--install-native-host requires --host /absolute/path/to/ArenaArchiveHost");
  process.exit(2);
}
if (installHost && process.platform !== "darwin") {
  console.error("--install-native-host is only supported on macOS; omit it for a cross-platform artifact build.");
  process.exit(2);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: "inherit", ...options });
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} ${commandArgs.join(" ")} failed`);
}
function git(argsList) {
  const result = spawnSync("git", argsList, { cwd: root, encoding: "utf8" });
  return { ok: result.status === 0, value: result.status === 0 ? result.stdout.trim() : null };
}
function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function copyIfNeeded(source, destination) {
  if (path.resolve(source) !== path.resolve(destination)) fs.copyFileSync(source, destination);
}

try {
  if (dryRun) {
    console.log("Local release dry run: would run tests, build Chrome/Firefox packages, optionally run browser acceptance, write checksums and a release manifest.");
    if (runAcceptance) console.log(requireBrowser ? "Would require a real Chromium browser." : "Would run browser acceptance when Playwright is available.");
    if (nativeHost) console.log(`Would include native host artifact ${nativeHost}`);
    if (installHost) console.log(`Would install native host from ${hostPath}`);
    if (signKey) console.log(`Would create detached signatures with ${signKey}`);
    process.exit(0);
  }

  if (!skipTests) run(process.execPath, ["tools/run-tests.mjs"]);
  // Keep the release step independent from the test runner's current internals.
  run(process.execPath, ["tools/build-release.mjs"]);

  const buildDir = path.join(root, "dist");
  const version = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).version;
  fs.mkdirSync(outputDir, { recursive: true });
  const expectedZips = [`Arena-Agent-Exporter-${version}-chrome.zip`, `Arena-Agent-Exporter-${version}-firefox.zip`];
  for (const name of expectedZips) {
    const source = path.join(buildDir, name);
    if (!fs.existsSync(source)) throw new Error(`Build did not produce ${name}`);
    copyIfNeeded(source, path.join(outputDir, name));
  }
  if (runAcceptance) {
    const acceptance = [path.join(root, "tools/acceptance.mjs")];
    if (requireBrowser) acceptance.push("--require-browser");
    run(process.execPath, acceptance);
  }

  const artifacts = expectedZips.map(name => {
    const file = path.join(outputDir, name);
    return { name, bytes: fs.statSync(file).size, sha256: sha256(file) };
  });
  if (nativeHost) {
    const source = resolveFromRoot(nativeHost);
    if (!fs.existsSync(source)) throw new Error(`Native host artifact not found: ${source}`);
    const name = path.basename(source);
    const destination = path.join(outputDir, name);
    copyIfNeeded(source, destination);
    artifacts.push({ name, bytes: fs.statSync(destination).size, sha256: sha256(destination), kind: "native-host" });
  }

  const signatures = [];
  if (signKey) {
    const key = resolveFromRoot(signKey);
    if (!fs.existsSync(key)) throw new Error(`Signing key not found: ${key}`);
    for (const item of artifacts) {
      const file = path.join(outputDir, item.name);
      const signature = `${file}.sig`;
      run("openssl", ["dgst", "-sha256", "-sign", key, "-out", signature, file]);
      signatures.push({ name: path.basename(signature), bytes: fs.statSync(signature).size, sha256: sha256(signature) });
    }
  }
  const checksumEntries = artifacts.concat(signatures);
  const checksumFile = path.join(outputDir, `Arena-Agent-Exporter-${version}-SHA256SUMS.txt`);
  fs.writeFileSync(checksumFile, checksumEntries.map(item => `${item.sha256}  ${item.name}`).join("\n") + "\n", "utf8");

  if (installHost) {
    run(process.execPath, [path.join(root, "tools/install-native-host.mjs"), "--host", resolveFromRoot(hostPath), "--browser", "all"]);
  }
  const commit = git(["rev-parse", "HEAD"]);
  const branch = git(["branch", "--show-current"]);
  const status = git(["status", "--porcelain"]);
  const manifest = {
    format: "arena-exporter-local-release",
    version,
    generated_at: new Date().toISOString(),
    source: { commit: commit.ok ? commit.value : null, branch: branch.ok ? branch.value : null, dirty: status.ok ? Boolean(status.value) : null },
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    features: { native_host: Boolean(nativeHost), encrypted_archives: true, streaming_jsonl: true, schema: "2.1" },
    tests: skipTests ? "skipped by explicit flag" : "tools/run-tests.mjs passed",
    acceptance: runAcceptance ? (requireBrowser ? "required browser acceptance passed" : "acceptance command passed (browser may have been skipped)") : "not requested",
    artifacts,
    checksums: path.basename(checksumFile),
    signatures
  };
  const manifestFile = path.join(outputDir, "release-manifest.json");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`Local release ready in ${outputDir}`);
  console.log(`Artifacts: ${artifacts.map(item => item.name).join(", ")}`);
  console.log(`Manifest: ${manifestFile}`);
  console.log(`Checksums: ${checksumFile}`);
} catch (error) {
  console.error(`Local release failed: ${error.message || error}`);
  process.exitCode = 1;
}
