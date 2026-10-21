/* Synthetic fixture only. No requests to Arena or GitHub. */
(function(){
  const query=new URLSearchParams(location.search),fixture=query.get('fixture'),listeners=[],storageListeners=[];
  const data={ae_preferences:{autoArchive:true},ae_silent_writes:false};
  let encryption={enabled:false,unlocked:false,format:'arena-encrypted-archive',version:2};
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
  const libraryRecords=fixture==='empty'?[]:entries.map((e,i)=>({
    key:e.key,title:e.title,url:e.url,mode:e.mode,subtype:e.subtype,rel:e.rel,updated_at:e.updated_at,
    indexed_at:'2026-09-05T09:42:00Z',source:'archive',turns:e.turns,models:e.models,models_pending:e.models_pending,
    completeness:e.completeness,warnings:i===5?['One attachment download failed.']:[],
    counts:{messages:e.turns?2:0,user_messages:1,assistant_messages:1,battles:e.mode==='battle'?1:0,blocks:3,thinking_blocks:1,thinking_chars:180,tool_calls:e.subtype==='code'?2:0,files:e.subtype==='image'?1:0},
    messages:[{role:'user',blocks:[{type:'text',text:'A synthetic question about '+e.title.toLowerCase()+'.'}]},{role:'assistant',blocks:[{type:'thinking',text:'Preview reasoning only.'},{type:'text',text:'This is a synthetic transcript for '+e.title+'. It exists so the offline reader, search highlighting, and export actions can be reviewed without contacting Arena.'}]}],
    battles:e.mode==='battle'?[{mode:'battle',prompt:'Which answer explains the idea more clearly?',outcome:i===5?'pending':'a_wins',vote_choice:i===5?null:'A',vote_source:'dom',anonymous:false,winner:'A',winner_model:'Model revealed · A',contestants:[{lane:'A',model:'Model revealed · A',verified:true,response:'A calm, concrete explanation with one worked example.',reasoning:null,tool_calls:[]},{lane:'B',model:'Model revealed · B',verified:true,response:'A shorter answer that gestures at the idea.',reasoning:null,tool_calls:[]}]}]:[],
    files:e.subtype==='image'?[{name:'sketch.png',lane:null,media_type:'image/png',bytes:84211,has_content:true}]:[],
    vote_outcomes:e.mode==='battle'&&i!==5?['a_wins']:[],payload_bytes:4096+i*512,payload_omitted:false
  }));
  const libraryMeta=record=>{const copy={...record};delete copy.messages;delete copy.battles;delete copy.files;return copy;};
  const libraryStatus=()=>({available:true,blocked:encryption.enabled,count:libraryRecords.length,bytes:libraryRecords.reduce((n,r)=>n+r.payload_bytes,0),last_indexed_at:libraryRecords.length?'2026-09-05T09:42:00Z':null,error:null});
  const searchLibrary=options=>{
    const query=String(options&&options.query||'').toLowerCase();
    const body=record=>{
      const parts=[record.title];
      (record.messages||[]).forEach(message=>(message.blocks||[]).forEach(block=>parts.push(block.text||block.tool_name||'')));
      (record.battles||[]).forEach(battle=>{parts.push(battle.prompt||'');(battle.contestants||[]).forEach(c=>parts.push(c.response||''));});
      return parts.filter(Boolean).join('\n');
    };
    const terms=query.match(/"[^"]+"|\S+/g)||[];
    const results=libraryRecords.map(record=>{
      let score=0, snippet=null;
      terms.forEach(term=>{
        const needle=term.replace(/^-|^"|"$/g,'').toLowerCase();
        if(!needle)return;
        if(record.title.toLowerCase().includes(needle))score+=4;
        const haystack=body(record);
        const at=haystack.toLowerCase().indexOf(needle);
        if(at!==-1){score+=2;if(!snippet)snippet={text:haystack.slice(Math.max(0,at-60),at+160),field:'text'};}
        if((record.title||'').toLowerCase().includes(needle))score+=1;
      });
      return score?{key:record.key,score:score,snippet:snippet}:null;
    }).filter(Boolean).sort((a,b)=>b.score-a.score);
    return {results:results,total:results.length};
  };
  const insightsFixture=()=>{
    const totals={conversations:libraryRecords.length,turns:libraryRecords.reduce((n,r)=>n+r.turns,0),messages:libraryRecords.reduce((n,r)=>n+r.counts.messages,0),tool_calls:libraryRecords.reduce((n,r)=>n+r.counts.tool_calls,0),payload_bytes:libraryRecords.reduce((n,r)=>n+r.payload_bytes,0),reasoning_chars:libraryRecords.reduce((n,r)=>n+r.counts.thinking_chars,0)};
    const by=list=>Object.entries(list.reduce((map,value)=>{map[value]=(map[value]||0)+1;return map;},{})).map(([label,value])=>({label:label,value:value}));
    return {generated_at:new Date().toISOString(),totals:totals,
      activity:{months:[{month:'2026-09',count:libraryRecords.length}],earlier:0},
      modes:by(libraryRecords.map(r=>r.mode)),votes:{ballots:1,manual_votes:0,pending:1,unrevealed_battles:0,outcomes:{a_wins:1,b_wins:0,both_good:0,neither_good:0}},
      models:[{name:'Model revealed · A',appearances:2,wins:1,verified:true},{name:'Model revealed · B',appearances:2,wins:0,verified:true}],
      completeness:by(libraryRecords.map(r=>r.completeness)),
      tools:[{tool:'browser.search',count:2},{tool:'python',count:1}]};
  };
  const verifyFixture=()=>({generated_at:new Date().toISOString(),archive_count:libraryRecords.length,library_count:libraryRecords.length,checked:libraryRecords.length,matched:libraryRecords.length,mismatched:[],missing:[],orphaned:[],stale:[],unchecked:[]});
  const exportItem=record=>({key:record.key,title:record.title,rel:record.rel,mode:record.mode,updated_at:record.updated_at,json:JSON.stringify({session:{conversation_key:record.key,title:record.title},export:{mode:record.mode,source:{url:record.url}},messages:record.messages,battles:record.battles},null,2),markdown:'# '+record.title+'\n\nSynthetic preview export.\n'});
  const findRecord=key=>libraryRecords.find(r=>r.key===key)||null;
  const tab={id:7,url:fixture==='empty'?'https://example.com/':'https://arena.ai/c/example-0',title:rows[0][0]};
  const state={conversationKey:'c:example-0',title:rows[0][0],url:tab.url,mode:'agent',messageCount:24,blockCounts:{thinking:12,tool_call:36,artifact:8},endpointCount:4,endpoints:[],warnings:fixture==='error'?['An attachment download failed. Retry Save now.']:[],lastSync:{ok:fixture!=='error',error:fixture==='error'?'FILE_FAILED':null,at:'2026-09-05T09:41:00Z',rel:'agent/weather-app--example-0',completeness:'full'},streaming:fixture==='streaming',nativeSink:{state:'missing'}};
  const notify=()=>listeners.forEach(fn=>fn({type:'AE_UI_CHANGED'}));
  const respond=async m=>{
    if(m.type==='AE_LIBRARY')return {ok:true,entries};
    if(m.type==='AE_RESEARCH_STATUS')return {ok:true,library:libraryStatus(),encryption};
    if(m.type==='AE_RESEARCH_LIST')return {ok:true,records:libraryRecords.map(libraryMeta)};
    if(m.type==='AE_RESEARCH_SEARCH')return {ok:true,...searchLibrary(m.options)};
    if(m.type==='AE_RESEARCH_HAS')return {ok:true,indexed:!!findRecord(m.key)};
    if(m.type==='AE_RESEARCH_GET'){const record=findRecord(m.key);return record?{ok:true,record,has_payload:true}:{ok:false,error:'This conversation is not in the local library.'};}
    if(m.type==='AE_RESEARCH_INSIGHTS')return {ok:true,insights:insightsFixture(),library:libraryStatus()};
    if(m.type==='AE_RESEARCH_VERIFY')return {ok:true,report:verifyFixture()};
    if(m.type==='AE_RESEARCH_EXPORT_DATA')return {ok:true,items:(m.keys||[]).slice(0,12).map(key=>findRecord(key)).filter(Boolean).map(exportItem)};
    if(m.type==='AE_RESEARCH_EXPORT'){const record=findRecord(m.key);if(!record)return {ok:false,error:'This conversation is not in the local library.'};const item=exportItem(record);return {ok:true,text:m.format==='markdown'?item.markdown:item.json,filename:'arena_'+record.mode+'_library_preview.'+(m.format==='markdown'?'md':'json'),mime:'text/plain'};}
    if(m.type==='AE_RESEARCH_IMPORT')return {ok:true,imported:(m.items||[]).length,skipped:[]};
    if(m.type==='AE_RESEARCH_CLEAR'){const n=libraryRecords.length;libraryRecords.splice(0);notify();return {ok:true,cleared:n};}
    if(m.type==='AE_RESEARCH_REMOVE'){const keys=m.keys||[];let n=0;for(let i=libraryRecords.length-1;i>=0;i--){if(keys.includes(libraryRecords[i].key)){libraryRecords.splice(i,1);n++;}}notify();return {ok:true,removed:n};}
    if(m.type==='AE_GET_STATE')return {ok:true,state};
    if(m.type==='AE_GITHUB_STATUS')return backup;
    if(m.type==='AE_PREFERENCES')return {ok:true,preferences:{...data.ae_preferences,archiveEncryption:{enabled:encryption.enabled}},encryption};
    if(m.type==='AE_SET_PREFERENCES'){data.ae_preferences={...data.ae_preferences,...m.preferences};notify();return {ok:true,preferences:data.ae_preferences};}
    if(m.type==='AE_SET_ARCHIVE_ENCRYPTION'){encryption={...encryption,enabled:!!m.enabled,unlocked:!!m.enabled};notify();return {ok:true,encryption,preferences:{...data.ae_preferences,archiveEncryption:{enabled:encryption.enabled}}};}
    if(m.type==='AE_UNLOCK_ARCHIVE_ENCRYPTION'){encryption={...encryption,unlocked:true};notify();return {ok:true,encryption,preferences:{...data.ae_preferences,archiveEncryption:{enabled:true}}};}
    if(m.type==='AE_LOCK_ARCHIVE_ENCRYPTION'){encryption={...encryption,unlocked:false};notify();return {ok:true,encryption,preferences:{...data.ae_preferences,archiveEncryption:{enabled:encryption.enabled}}};}
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
    if(m.type==='AE_DIAGNOSTICS')return {ok:true,diagnostics:{version:'3.0.0',schema:'2.1',created_at:'2026-09-05T10:00:00Z',capture:{sessions:6,events:1824,storage_errors:0},auto_archive:data.ae_preferences.autoArchive,archive_encryption:encryption,library:libraryStatus(),issues:[],privacy:'Synthetic preview. No conversation content, URLs or credentials.'}};
    return {ok:false,error:'Unsupported preview action: '+m.type};
  };
  window.chrome={runtime:{id:'preview',lastError:null,getManifest:()=>({version:'3.0.0'}),getURL:file=>location.origin+'/'+file,onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:(m,cb)=>respond(m).then(r=>cb&&cb(r))},
    storage:{local:{get:(keys,cb)=>{let r={};keys.forEach(k=>r[k]=data[k]);if(cb)cb(r);else return Promise.resolve(r);},set:async o=>Object.assign(data,o)},onChanged:{addListener:fn=>storageListeners.push(fn)}},
    permissions:{request:(_p,cb)=>cb(true)},downloads:{setUiOptions:()=>{}},tabs:{query:async()=>[tab],create:async o=>{if(o.url.startsWith(location.origin))location.href=o.url;return {id:8};},sendMessage:(_id,m,cb)=>cb(m.type==='AE_DOM_SNAPSHOT'?{url:tab.url,messages:[],pageData:null}:m.type==='AE_DOM_DEBUG'?{redacted:true}:{ok:true})}};
  document.addEventListener('DOMContentLoaded',()=>{const badge=document.createElement('div');badge.textContent='DESIGN PREVIEW · SYNTHETIC DATA';badge.style.cssText='font:9px monospace;position:fixed;bottom:3px;right:8px;color:#819790;z-index:99;pointer-events:none';document.body.appendChild(badge);});
})();
