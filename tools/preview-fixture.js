/* Synthetic fixture only. No requests to Arena or GitHub. */
(function(){
  const query=new URLSearchParams(location.search),fixture=query.get('fixture'),listeners=[],storageListeners=[];
  const data={ae_preferences:{autoArchive:true},ae_silent_writes:false};
  let backup={ok:true,enabled:false,connected:false,pending:0,lastSuccess:null,error:null,repo:'',branch:'main',folder:'arena-archive'};
  const rows=[
    ['Designing a small, useful weather app','agent','code',12,[], '2026-09-05T09:41:00Z'],
    ['A better way to explain quantum tunneling','battle','text',4,['Model revealed · A','Model revealed · B'],'2026-09-05T08:25:00Z'],
    ['Comparing two approaches to async Rust','side-by-side','code',7,['Selected model · A','Selected model · B'],'2026-09-04T19:10:00Z'],
    ['The weekend reading list','direct','web-search',3,['Selected model'],'2026-09-04T16:42:00Z'],
    ['An illustrated field guide to local birds','agent','image',18,[],'2026-09-04T13:30:00Z'],
    ['What makes a great public space?','battle','text',2,[],'2026-09-03T10:15:00Z']
  ];
  const entries=fixture==='empty'?[]:rows.map((r,i)=>({key:'c:example-'+i,title:r[0],mode:r[1],subtype:r[2],turns:r[3],models:r[4],updated_at:r[5],url:'https://arena.ai/c/example-'+i,rel:r[1]+'/example-'+i,completeness:i===5?'partial':'full',models_pending:i===5}));
  const tab={id:7,url:fixture==='empty'?'https://example.com/':'https://arena.ai/c/example-0',title:rows[0][0]};
  const state={conversationKey:'c:example-0',title:rows[0][0],url:tab.url,mode:'agent',messageCount:24,blockCounts:{thinking:12,tool_call:36,artifact:8},endpointCount:4,endpoints:[],warnings:fixture==='error'?['An attachment download failed. Retry Save now.']:[],lastSync:{ok:fixture!=='error',error:fixture==='error'?'FILE_FAILED':null,at:'2026-09-05T09:41:00Z',rel:'agent/weather-app--example-0',completeness:'full'},streaming:fixture==='streaming',nativeSink:{state:'missing'}};
  const notify=()=>listeners.forEach(fn=>fn({type:'AE_UI_CHANGED'}));
  const respond=async m=>{
    if(m.type==='AE_LIBRARY')return {ok:true,entries};
    if(m.type==='AE_GET_STATE')return {ok:true,state};
    if(m.type==='AE_GITHUB_STATUS')return backup;
    if(m.type==='AE_PREFERENCES')return {ok:true,preferences:data.ae_preferences};
    if(m.type==='AE_SET_PREFERENCES'){data.ae_preferences=m.preferences;notify();return {ok:true,preferences:m.preferences};}
    if(m.type==='AE_GITHUB_CONFIGURE'){
      if(!/^[\w.-]+\/[\w.-]+$/.test(m.config.repo))return {ok:false,error:'Enter a repository as owner/name.'};
      backup={...backup,...m.config,token:undefined,enabled:true,connected:true,pending:0};notify();return backup;
    }
    if(m.type==='AE_GITHUB_PAUSE'){backup={...backup,enabled:false,...(m.forget?{connected:false}: {})};notify();return backup;}
    if(m.type==='AE_GITHUB_FLUSH'){backup={...backup,pending:0,lastSuccess:new Date().toISOString()};notify();return backup;}
    if(m.type==='AE_NATIVE_STATUS')return {state:'missing'};
    if(m.type==='AE_SET_SILENT'){data.ae_silent_writes=m.enabled;return {ok:true,suppressed:m.enabled};}
    if(m.type==='AE_EXPORT')return fixture==='error'?{ok:false,error:'Simulated interrupted download.'}:{ok:true,filename:'arena_example.'+(m.format==='markdown'?'md':'json'),json:'{"example":true}',text:m.format==='markdown'?'# Example\nSynthetic preview only.':undefined};
    if(m.type==='AE_SYNC')return fixture==='error'?{ok:false,error:'Simulated archive write failure.'}:{ok:true,completeness:'full'};
    if(['AE_OPEN_FOLDER','AE_OPEN_ARCHIVED_FOLDER','AE_SAVE_TEXT','AE_CLEAR','AE_GITHUB_IMPORT'].includes(m.type))return {ok:true};
    if(m.type==='AE_TEST_ARCHIVE')return {ok:true,resolved:'Downloads/arena-archive/_selftest.txt'};
    if(m.type==='AE_SET_MANUAL_VOTE')return {ok:true,state};
    if(m.type==='AE_HISTORY_BACKFILL')return {ok:true,written:6,skipped:0,failed:0};
    if(m.type==='AE_DIAGNOSTICS')return {ok:true,diagnostics:{version:'2.1.0',schema:'2.1',created_at:'2026-09-05T10:00:00Z',capture:{sessions:6,events:1824,storage_errors:0},auto_archive:data.ae_preferences.autoArchive,issues:[],privacy:'Synthetic preview. No conversation content, URLs or credentials.'}};
    return {ok:false,error:'Unsupported preview action: '+m.type};
  };
  window.chrome={runtime:{id:'preview',lastError:null,getManifest:()=>({version:'2.1.0'}),getURL:file=>location.origin+'/'+file,onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:(m,cb)=>respond(m).then(r=>cb&&cb(r))},
    storage:{local:{get:(keys,cb)=>{let r={};keys.forEach(k=>r[k]=data[k]);if(cb)cb(r);else return Promise.resolve(r);},set:async o=>Object.assign(data,o)},onChanged:{addListener:fn=>storageListeners.push(fn)}},
    permissions:{request:(_p,cb)=>cb(true)},downloads:{setUiOptions:()=>{}},tabs:{query:async()=>[tab],create:async o=>{if(o.url.startsWith(location.origin))location.href=o.url;return {id:8};},sendMessage:(_id,m,cb)=>cb(m.type==='AE_DOM_SNAPSHOT'?{url:tab.url,messages:[],pageData:null}:m.type==='AE_DOM_DEBUG'?{redacted:true}:{ok:true})}};
  document.addEventListener('DOMContentLoaded',()=>{const badge=document.createElement('div');badge.textContent='DESIGN PREVIEW · SYNTHETIC DATA';badge.style.cssText='font:9px monospace;position:fixed;bottom:3px;right:8px;color:#819790;z-index:99;pointer-events:none';document.body.appendChild(badge);});
})();
