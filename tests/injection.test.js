"use strict";
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {worker}=require('./worker-harness');
const root=path.join(__dirname,'..');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

async function checkPackage(folder){
  const manifest=JSON.parse(fs.readFileSync(path.join(folder,'manifest.json'),'utf8'));
  const worlds=[],forwarded=[],injected=new Set();let rpc;
  for(const entry of manifest.content_scripts){
    const listeners=[];
    function XMLHttpRequest(){}
    XMLHttpRequest.prototype={open(){},send(){},addEventListener(){},getResponseHeader(){return '';}};
    const sandbox={console,URL,TextEncoder,TextDecoder,Uint8Array,Response,Request,Headers,Blob,XMLHttpRequest,
      setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,5)),clearTimeout,setInterval:()=>0,clearInterval:()=>{},
      location:{href:'https://arena.ai/c/bundle-check',origin:'https://arena.ai'},
      navigator:{sendBeacon:()=>true},document:{title:'Integration fixture',body:{innerHTML:'',innerText:'',textContent:''},
        querySelector:()=>null,querySelectorAll:()=>[],getElementById:()=>null,addEventListener:()=>{}},
      addEventListener:(type,fn)=>{if(type==='message')listeners.push(fn);},
      fetch:async()=>new Response('{}',{headers:{'Content-Type':'application/json'}}),
      chrome:{runtime:{lastError:null,onMessage:{addListener:fn=>{rpc=fn;}},sendMessage:(m,cb)=>{forwarded.push(m);cb?.({ok:true});}}}};
    sandbox.window=sandbox;
    const context=vm.createContext(sandbox),publicWindow=vm.runInContext('window',context);
    sandbox.postMessage=data=>queueMicrotask(()=>{for(const world of worlds)for(const fn of world.listeners)fn({source:world.publicWindow,origin:'https://arena.ai',data});});
    worlds.push({context,publicWindow,listeners});
    for(const file of entry.js){
      // Mirrors Chrome's file-URL deduplication across execution worlds.
      assert.ok(!injected.has(file),'Each world needs a distinct entry point: '+file);injected.add(file);
      vm.runInContext(fs.readFileSync(path.join(folder,file),'utf8'),context,{filename:file});
    }
    assert.equal(context.AE,undefined,'Helpers remain private to their execution world');
  }
  await tick();await tick();
  assert.ok(forwarded.some(m=>m.evt?.kind==='interceptor_ready'),'MAIN readiness crosses the ISOLATED bridge');
  worlds[0].context.navigator.sendBeacon('/api/create-evaluation',JSON.stringify({prompt:'Bundle transport check',access_token:'private-test-token'}));
  await tick();
  const requests=forwarded.filter(m=>m.evt?.kind==='request');
  assert.ok(requests.length,'Captured requests cross the bridge');
  assert.match(JSON.stringify(requests),/Bundle transport check/);
  assert.ok(!JSON.stringify(requests).includes('private-test-token'),'Credentials are filtered before crossing worlds');
  const snapshot=await new Promise(resolve=>rpc({type:'AE_DOM_SNAPSHOT'},{},resolve));
  assert.equal(snapshot.url,'https://arena.ai/c/bundle-check');assert.equal(snapshot.error,undefined);
  worlds[1].context.document.querySelectorAll=()=>{throw new Error('sensitive-page-detail');};
  const failed=await new Promise(resolve=>rpc({type:'AE_DOM_SNAPSHOT'},{},resolve));
  assert.match(failed.error,/Page capture failed/);assert.ok(!JSON.stringify(failed).includes('sensitive-page-detail'));
}

(async()=>{
  const version=require('../manifest.json').version;
  for(const browser of ['chrome','firefox'])await checkPackage(path.join(root,'dist',`Arena-Agent-Exporter-${version}-${browser}`));
  const f=worker();await f.ready();const icons=[];
  f.context.chrome.action={setIcon:details=>{icons.push(details);return Promise.reject(new Error('test failure'));},setTitle:()=>Promise.resolve()};
  f.context.AE.nativeStatus=async()=>({state:'missing'});f.context.AE.refreshStatusLed();await tick();await tick();
  assert.equal(icons.length,1);
  for(const url of Object.values(icons[0].path)){
    assert.ok(url.startsWith('chrome-extension://arena-test/icons/led/'),'Icon URL resolves from the extension root');
    assert.ok(fs.existsSync(path.join(root,url.replace('chrome-extension://arena-test/',''))));
  }
  assert.ok(f.context.AE.diagnostics().issues.some(i=>i.code==='icon_failed'),'Async icon failures are handled');
  console.log('Packaged MAIN/ISOLATED bridge, snapshot replies, credential filtering and toolbar URLs passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
