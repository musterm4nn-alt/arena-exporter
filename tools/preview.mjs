// Local design/test preview: actual extension UI with synthetic browser APIs.
// The fixture is injected by this server and never included in extension ZIPs.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost'), rel=decodeURIComponent(url.pathname==='/'?'/src/options.html':url.pathname).slice(1);
  const file=path.resolve(root,rel);
  if(!file.startsWith(root+path.sep)||!(/^(src\/|tools\/preview-fixture\.js$)/.test(rel))||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  let bytes=fs.readFileSync(file);
  if(file.endsWith('.html'))bytes=Buffer.from(bytes.toString().replace('</head>','<script src="/tools/preview-fixture.js"></script></head>'));
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':file.endsWith('.woff2')?'font/woff2':'application/octet-stream');
  res.end(bytes);
});
server.listen(Number(process.env.ARENA_PREVIEW_PORT||4178),'127.0.0.1',()=>console.log('Arena UI preview (synthetic data): http://127.0.0.1:'+server.address().port));
