#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const build = spawnSync(process.execPath, ["tools/build-release.mjs"], { cwd: root, stdio: "inherit", timeout: 60000 });
if (build.error || build.status !== 0) {
  console.error(build.error || "Release build failed");
  process.exit(1);
}
const suites = fs.readdirSync(path.join(root, "tests")).filter(file => file.endsWith(".test.js")).sort();
let failed = 0;
for (const file of suites) {
  const result = spawnSync(process.execPath, [path.join("tests", file)], { cwd: root, encoding: "utf8", timeout: 30000 });
  if (result.error || result.status !== 0) {
    failed++;
    console.error("FAIL " + file + "\n" + (result.stdout || "") + (result.stderr || "") + (result.error || ""));
  } else {
    console.log("PASS " + file);
  }
}
console.log("\n" + (suites.length - failed) + "/" + suites.length + " JavaScript suites passed");
process.exitCode = failed ? 1 : 0;
