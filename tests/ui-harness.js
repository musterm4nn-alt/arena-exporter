// Exercises production document handlers; does not emulate visual layout.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function documentFixture(html){
  const all=[],ids=new Map();
  function element(tag,attrs={}){
    const classes=new Set((attrs.class||'').split(/\s+/).filter(Boolean));
    const e={tagName:tag.toUpperCase(),id:attrs.id||'',dataset:{},attributes:{...attrs},children:[],listeners:{},style:{},textContent:'',value:attrs.value||'',checked:'checked' in attrs,disabled:'disabled' in attrs,title:attrs.title||'',
      classList:{add:(...c)=>c.forEach(x=>classes.add(x)),remove:(...c)=>c.forEach(x=>classes.delete(x)),contains:c=>classes.has(c),toggle:(c,b)=>{b=b===undefined?!classes.has(c):b;b?classes.add(c):classes.delete(c);return b;}},
      setAttribute(k,v){this.attributes[k]=String(v);if(k.startsWith('data-'))this.dataset[k.slice(5)]=String(v);},removeAttribute(k){delete this.attributes[k];},getAttribute(k){return this.attributes[k]??null;},
      addEventListener(k,fn){(this.listeners[k] ||= []).push(fn);},appendChild(c){this.children.push(c);return c;},append(...c){this.children.push(...c);},replaceChildren(...c){this.children=[...c];},
      async fire(type='click',event={}){if(this.disabled)return;for(const fn of this.listeners[type]||[])await fn({target:this,preventDefault(){},...event});}};
    Object.entries(attrs).forEach(([k,v])=>{if(k.startsWith('data-'))e.dataset[k.slice(5)]=v;});
    Object.defineProperty(e,'className',{get:()=>[...classes].join(' '),set:v=>{classes.clear();String(v).split(/\s+/).filter(Boolean).forEach(c=>classes.add(c));}});
    all.push(e);if(e.id)ids.set(e.id,e);return e;
  }
  for(const m of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)){const attrs={};for(const a of m[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g))attrs[a[1]]=a[2]??'';element(m[1],attrs);}
  const query=s=>all.filter(e=>s[0]==='.'?e.classList.contains(s.slice(1)):s==='input[name="scope"]'?e.tagName==='INPUT'&&e.attributes.name==='scope':/^\[([\w-]+)\]$/.test(s)?s.slice(1,-1) in e.attributes:false);
  return {getElementById:id=>ids.get(id)||null,createElement:tag=>element(tag),querySelectorAll:query,title:'',elements:ids,all};
}
async function uiFixture(page='popup',options={}){
  const root=path.join(__dirname,'../src'),html=fs.readFileSync(path.join(root,page+'.html'),'utf8'),document=documentFixture(html),sent=[],opened=[],copied=[],listeners=[];
  let tab=options.tab||{id:55,url:'https://arena.ai/c/active-tab-uuid'};
  const state={conversationKey:'c:active-tab-uuid',title:'My conversation',mode:'battle',messageCount:2,blockCounts:{},endpoints:[],warnings:[],lastSync:null};
  const defaults={AE_GET_STATE:{ok:true,state},AE_GITHUB_STATUS:{ok:true,connected:false,enabled:false,pending:0},AE_PREFERENCES:{ok:true,preferences:{autoArchive:true}},AE_LIBRARY:{ok:true,entries:options.entries||[]},AE_DIAGNOSTICS:{ok:true,diagnostics:{version:'2.1.0'}},AE_NATIVE_STATUS:{state:'missing'}};
  const context=vm.createContext({console,URL,Blob,TextEncoder,TextDecoder,Uint8Array,btoa,atob,setTimeout,clearTimeout,document,location:{hash:'#library'},history:{replaceState:(_a,_b,hash)=>context.location.hash=hash},navigator:{clipboard:{writeText:async t=>copied.push(t)}},
    chrome:{runtime:{id:'test',lastError:null,getManifest:()=>({version:'2.1.0'}),getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:(m,cb)=>{sent.push(m);const res=options.respond?options.respond(m):undefined;Promise.resolve(res??defaults[m.type]??{ok:true,json:'{"capture":true}',filename:'test.json'}).then(cb);}},
      tabs:{query:async()=>[tab],create:async o=>opened.push(o),sendMessage:(_id,m,cb)=>cb(m.type==='AE_DOM_SNAPSHOT'?{url:options.snapshotUrl||tab.url,messages:[]}:{ok:true})},storage:{onChanged:{addListener:()=>{}},local:{get:(keys,cb)=>cb?cb({}):Promise.resolve({})}},permissions:{request:(_p,cb)=>cb(true)},downloads:{setUiOptions:()=>{}}}});
  context.window=context;context.addEventListener=()=>{};
  if(document.getElementById('export-format'))document.getElementById('export-format').value='json';
  if(document.getElementById('library-sort'))document.getElementById('library-sort').value='recent';
  for(const script of [...html.matchAll(/<script src="([^"]+)"/g)].map(m=>m[1]))vm.runInContext(fs.readFileSync(path.join(root,script),'utf8'),context,{filename:script});
  const tick=()=>new Promise(resolve=>setImmediate(resolve));await tick();await tick();
  return {document,sent,opened,copied,context,tick,setTab:t=>tab=t,last:type=>sent.filter(m=>m.type===type).at(-1),async fire(id,type='click'){const el=document.getElementById(id);if(!el)throw new Error('Missing control '+id);await el.fire(type);await tick();}};
}
module.exports={uiFixture};
