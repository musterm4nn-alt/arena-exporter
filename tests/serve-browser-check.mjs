// Read-only local fixture: real IndexedDB and options UI, synthetic browser APIs.
// Run with Node, then open the printed URL. No requests are made to GitHub.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const relative = pathname === "/" ? "src/options.html" : pathname.slice(1);
  if (!/^(src\/|tests\/browser-check\.js$)/.test(relative) || relative.split("/").includes("..")) {
    response.writeHead(404); response.end(); return;
  }
  const filename = path.resolve(root, relative);
  if (!filename.startsWith(root + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
    response.writeHead(404); response.end(); return;
  }
  let bytes = fs.readFileSync(filename);
  if (relative === "src/options.html") bytes = Buffer.from(bytes.toString().replace("</head>",
    '<script src="/tests/browser-check.js"></script><script src="/src/backup-store.js"></script></head>')
    .replaceAll('href="popup.css"', 'href="/src/popup.css"').replaceAll('src="lib/', 'src="/src/lib/')
    .replace('src="archive-layout.js"', 'src="/src/archive-layout.js"').replace('src="options.js"', 'src="/src/options.js"'));
  response.setHeader("Content-Type", filename.endsWith(".js") ? "text/javascript" : filename.endsWith(".css") ? "text/css" : filename.endsWith(".html") ? "text/html" : "application/octet-stream");
  response.end(bytes);
});
server.listen(0, "127.0.0.1", () => console.log("Browser check: http://127.0.0.1:" + server.address().port));
