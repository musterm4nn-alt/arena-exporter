// Local design/test preview: actual extension UI with synthetic browser APIs.
// The fixture is injected by this server and never included in extension ZIPs.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const server=http.createServer((req,res)=>{
  let decoded;
  try { decoded=decodeURIComponent(new URL(req.url,'http://localhost').pathname); } catch (_) { res.writeHead(400); res.end(); return; }
  const rel=decoded==='/'?'src/options.html':decoded.replace(/^\/+/,'');
  const normalized=path.posix.normalize(rel);
  const allowed=(normalized.startsWith('src/')||normalized==='src'||normalized==='tools/preview-fixture.js') && normalized===rel;
  const file=path.resolve(root,normalized);
  if(!allowed||!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  let bytes=fs.readFileSync(file);
  if(file.endsWith('.html'))bytes=Buffer.from(bytes.toString().replace('</head>','<script src="/tools/preview-fixture.js"></script></head>'));
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':file.endsWith('.woff2')?'font/woff2':'application/octet-stream');
  res.end(bytes);
});
server.listen(Number(process.env.ARENA_PREVIEW_PORT||4178),'127.0.0.1',()=>console.log('Arena UI preview (synthetic data): http://127.0.0.1:'+server.address().port));
