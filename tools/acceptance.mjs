#!/usr/bin/env node
/* Optional real-browser acceptance for the redesigned UI.
 *
 * The repository has no runtime npm dependencies. If Playwright is installed
 * locally, this script drives Chromium against the synthetic preview. Pass
 * --require-browser in CI/local release work to make a missing browser a hard
 * failure. With --extension it loads the generated Chrome package and checks
 * the real options page; without Playwright it performs dependency-free HTTP
 * smoke checks and reports an explicit browser skip.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromeExtensionId } from "./native-host-manifest.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const requireBrowser = args.includes("--require-browser");
const extensionMode = args.includes("--extension");
const browserArgIndex = args.indexOf("--browser");
const browserExecutable = browserArgIndex >= 0 ? args[browserArgIndex + 1] : process.env.ACCEPTANCE_BROWSER || undefined;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function startPreview() {
  return freePort().then(port => {
    const child = spawn(process.execPath, [path.join(root, "tools/preview.mjs")], {
      cwd: root,
      env: { ...process.env, ARENA_PREVIEW_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.stderr.on("data", chunk => { output += chunk.toString(); });
    const ready = (async () => {
      const deadline = Date.now() + 10000;
      while (!output.includes("Arena UI preview") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      if (!output.includes("Arena UI preview")) throw new Error(`preview server did not start: ${output}`);
      return `http://127.0.0.1:${port}`;
    })();
    return { child, ready, port };
  });
}

async function getText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

async function httpSmoke() {
  const preview = await startPreview();
  try {
    const base = await preview.ready;
    const popup = await getText(`${base}/src/popup.html`);
    const options = await getText(`${base}/src/options.html`);
    if (!popup.includes("Open archive workspace") || !popup.includes("Conversation tools")) throw new Error("popup landmarks missing");
    if (!options.includes("Your archive, in one place.") || !options.includes("GitHub backup")) throw new Error("workspace landmarks missing");
    if (/<script[^>]+src="https?:\/\//i.test(popup + options)) throw new Error("remote script reference found");
    if ((await fetch(`${base}/src/../README.md`)).status !== 404) throw new Error("preview path traversal was not rejected");
    for (const asset of ["src/popup.css", "src/ui-model.js", "src/ui-common.js", "src/popup.js", "src/options.js", "src/fonts/DepartureMono-Regular.woff2"]) {
      await getText(`${base}/${asset}`);
    }
    console.log(`HTTP acceptance passed at ${base}`);
  } finally {
    preview.child.kill();
  }
}

async function playwrightAcceptance() {
  let playwright;
  try { playwright = await import("playwright"); }
  catch (error) {
    const message = "SKIP: Playwright is not installed; run `npm install --no-save playwright` or use --require-browser in a browser-enabled environment.";
    if (requireBrowser) throw new Error(message);
    console.log(message);
    return;
  }
  const chromium = playwright.chromium || (playwright.default && playwright.default.chromium);
  if (!chromium) throw new Error("Playwright module does not expose Chromium.");
  const launchOptions = { headless: !args.includes("--headed") };
  if (browserExecutable) launchOptions.executablePath = browserExecutable;
  let context;
  let page;
  let profile;
  try {
    if (extensionMode) {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
      const packageDir = path.join(root, "dist", `Arena-Agent-Exporter-${manifest.version}-chrome`);
      if (!fs.existsSync(path.join(packageDir, "manifest.json"))) throw new Error("build the Chrome package before --extension acceptance");
      profile = fs.mkdtempSync(path.join(os.tmpdir(), "arena-exporter-acceptance-"));
      context = await chromium.launchPersistentContext(profile, { ...launchOptions, args: [`--disable-extensions-except=${packageDir}`, `--load-extension=${packageDir}`] });
      let worker = context.serviceWorkers()[0];
      if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 10000 });
      const id = new URL(worker.url()).hostname;
      const expectedId = chromeExtensionId(manifest.key);
      if (!/^[a-p]{32}$/.test(id) || id !== expectedId) throw new Error(`unexpected extension service-worker host: ${id}`);
      page = await context.newPage();
      await page.goto(`chrome-extension://${id}/src/options.html#library`, { waitUntil: "domcontentloaded" });
      const title = await page.title();
      if (!/Arena Exporter/.test(title)) throw new Error(`extension options page did not load: ${title}`);
      const body = await page.locator("body").innerText();
      if (!body.includes("Conversations") || !body.includes("GitHub backup")) throw new Error("extension workspace landmarks missing");
      console.log("Real unpacked Chrome extension acceptance passed: options page loaded.");
    } else {
      const preview = await startPreview();
      try {
        const base = await preview.ready;
        context = await chromium.launch(launchOptions);
        page = await context.newPage({ viewport: { width: 1280, height: 900 } });
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(`${base}/src/options.html`);
        await page.getByRole("button", { name: "GitHub backup" }).click();
        if (!page.url().endsWith("#backup")) throw new Error("backup navigation did not update the URL");
        await page.getByRole("button", { name: "Preferences" }).click();
        if (!page.url().endsWith("#preferences")) throw new Error("preferences navigation did not update the URL");
        await page.getByRole("button", { name: "Diagnostics" }).click();
        if (!page.url().endsWith("#diagnostics")) throw new Error("diagnostics navigation did not update the URL");
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${base}/src/options.html`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        if (overflow) throw new Error("mobile workspace has horizontal overflow");
        if (errors.length) throw new Error("preview page errors: " + errors.join("; "));
        console.log("Playwright preview acceptance passed: navigation, diagnostics, and mobile layout.");
      } finally { preview.child.kill(); }
    }
  } finally {
    if (context) await context.close().catch(() => {});
    if (profile) fs.rmSync(profile, { recursive: true, force: true });
  }
}

try {
  await httpSmoke();
  await playwrightAcceptance();
} catch (error) {
  console.error(`Acceptance failed: ${error.message || error}`);
  process.exitCode = 1;
}
