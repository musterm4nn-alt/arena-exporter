#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("Expected a three-part release version");

function sourceFiles(relative) {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const name = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Release sources must not contain symlinks: " + name);
    if (entry.isDirectory()) return sourceFiles(name);
    return entry.isFile() ? [name] : [];
  });
}

// All generated paths stay beneath this checkout. Refuse output symlinks and
// leave unrelated files alone; ZIPs use this explicit source list only.
function write(relative, content) {
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) throw new Error("Output escapes the checkout: " + relative);
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("Output is a symlink: " + current);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

const background = fs.readFileSync(path.join(root, manifest.background.service_worker), "utf8");
const importCall = /importScripts\(([^]*?)\);/.exec(background);
if (!importCall) throw new Error("Cannot find the background dependency list");
const scripts = [...importCall[1].matchAll(/"([^"]+)"/g)].map(match => path.posix.join("src", match[1]));
scripts.push(manifest.background.service_worker);
if (scripts.length < 2 || scripts.some(file => !fs.statSync(path.join(root, file)).isFile())) throw new Error("Missing background dependency");

const firefox = structuredClone(manifest);
delete firefox.key;
firefox.optional_permissions = (firefox.optional_permissions || []).filter(permission => permission !== "downloads.ui");
if (!firefox.optional_permissions.length) delete firefox.optional_permissions;
firefox.background = { scripts };

const shared = new Map([...sourceFiles("src"), ...sourceFiles("icons"), "CHANGELOG.md", "docs/export-schema.md", "docs/github-backup.md"].map(file => [file, fs.readFileSync(path.join(root, file))]));

function readme(browser) {
  const install = browser === "chrome"
    ? "1. Open `chrome://extensions` and enable Developer mode.\n2. Choose **Load unpacked** and select this folder.\n3. Reload the Arena tab. When updating an existing installation, use its **Reload** button.\n"
    : "Requires Firefox " + firefox.browser_specific_settings.gecko.strict_min_version + "+.\n\n1. Open `about:debugging#/runtime/this-firefox`.\n2. Choose **Load Temporary Add-on** and select this folder's `manifest.json`.\n3. Reload the Arena tab. Temporary installations must be loaded again after restarting Firefox.\n";
  return "# Arena Agent Exporter " + manifest.version + " (" + (browser === "chrome" ? "Chrome" : "Firefox") + ")\n\n" + install +
    "\nCaptures Agent, Battle, Direct and Side-by-Side chats. Use **Write to archive now** or **Export full chat** in the popup. Turns also archive automatically.\n\n" +
    "Files go to `Downloads/arena-archive/`, or to the folder selected in the optional Arena Archive native app. Agent model identities remain unset when Arena does not reveal them.\n\n" +
    "Use **Open conversation folder** for the selected Arena chat. Connect a private repository in **Settings → GitHub backups** for automatic backups and existing-archive import. See [GitHub backup setup](docs/github-backup.md).\n\n" +
    "See [release notes](CHANGELOG.md), [export metadata](docs/export-schema.md), and the [repository README](https://github.com/musterm4nn-alt/arena-exporter#readme).\n\n" +
    "Generated with `node tools/build-release.mjs`; edit the shared source in the repository root.\n";
}

// A small dependency-free ZIP writer. Fixed timestamps and sorted entries make
// repeat builds byte-for-byte reproducible. Packages here are well below ZIP64 limits.
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ value >>> 8;
  return (value ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  if (entries.size >= 65535) throw new Error("Too many ZIP entries");
  const local = [], directory = [];
  let offset = 0;
  for (const [filename, bytes] of [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const name = Buffer.from(filename), data = deflateRawSync(bytes, { level: 9 }), crc = crc32(bytes);
    if (offset + data.length + name.length + 30 >= 0xffffffff) throw new Error("Package requires ZIP64");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0x21, 12); // 1980-01-01
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    header.copy(entry, 6, 4, 28);
    entry.writeUInt32LE(offset, 42);
    directory.push(entry, name);
    offset += header.length + name.length + data.length;
  }
  const table = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(table.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, table, end]);
}

for (const browser of ["chrome", "firefox"]) {
  const files = new Map(shared);
  files.set("manifest.json", Buffer.from(JSON.stringify(browser === "chrome" ? manifest : firefox, null, 2) + "\n"));
  files.set("README.md", Buffer.from(readme(browser)));
  const name = "Arena-Agent-Exporter-" + manifest.version + "-" + browser;
  for (const [file, bytes] of files) {
    write("dist/" + name + "/" + file, bytes);
    if (browser === "firefox") write("firefox/" + file, bytes);
  }
  write("dist/" + name + ".zip", zip(files));
  console.log(name + ": " + files.size + " files, unpacked folder and ZIP ready");
}
