/* The 3.0 workspace: offline reader, insights, library health and bulk export. */
const assert=require('node:assert/strict');
const {uiFixture}=require('./ui-harness');
const settle=async f=>{for(let i=0;i<4;i++)await f.tick();};
const wait=ms=>new Promise(r=>setTimeout(r,ms));

const record={
  key:'c:weather',title:'Designing a small, useful weather app',url:'https://arena.ai/c/weather',mode:'agent',subtype:'text',
  rel:'agent/weather',updated_at:'2026-09-05T09:41:00Z',indexed_at:'2026-09-05T09:42:00Z',source:'archive',turns:2,
  models:['orchestrator'],models_pending:false,completeness:'full',warnings:['One attachment was listed but not downloaded.'],
  counts:{messages:2,user_messages:1,assistant_messages:1,battles:0,blocks:3,thinking_blocks:1,thinking_chars:40,tool_calls:1,files:1},
  messages:[
    {role:'user',blocks:[{type:'text',text:'Design a weather app for a small town.'}]},
    {role:'assistant',blocks:[
      {type:'thinking',text:'I should keep the scope small.'},
      {type:'text',text:'Start with one screen: today, tomorrow, and rain.'},
      {type:'tool_call',tool_name:'search',status:'success',arguments:{q:'forecast'},output:{hits:2}}
    ]}
  ],
  battles:[],files:[{name:'wireframe.txt',lane:null,media_type:'text/plain',bytes:120,has_content:true}],
  vote_outcomes:[],payload_bytes:2048,payload_omitted:false
};
const meta={...record};delete meta.messages;delete meta.battles;delete meta.files;

const insights={
  generated_at:'2026-10-21T10:00:00Z',
  totals:{conversations:1,turns:2,messages:2,tool_calls:1,payload_bytes:2048,reasoning_chars:40},
  activity:{months:[{month:'2026-09',count:1}],earlier:0},
  modes:[{mode:'agent',count:1}],
  votes:{ballots:0,manual_votes:0,pending:0,unrevealed_battles:0,outcomes:{a_wins:0,b_wins:0,both_good:0,neither_good:0}},
  models:[{name:'orchestrator',appearances:1,wins:0,verified:false}],
  completeness:[{status:'full',count:1}],
  tools:[{tool:'search',count:1}]
};
const report={generated_at:'2026-10-21T10:01:00Z',archive_count:1,library_count:1,checked:1,matched:1,
  mismatched:[],missing:[],orphaned:[],stale:[],unchecked:[]};

(async()=>{
  const entries=[{key:record.key,title:record.title,mode:'agent',subtype:'text',turns:2,models:['orchestrator'],rel:record.rel,url:record.url,updated_at:record.updated_at,completeness:'full'}];
  const f=await uiFixture('options',{entries,respond:m=>{
    if(m.type==='AE_RESEARCH_STATUS')return {ok:true,library:{available:true,blocked:false,count:1,bytes:2048,last_indexed_at:'2026-09-05T09:42:00Z',error:null},encryption:null};
    if(m.type==='AE_RESEARCH_LIST')return {ok:true,records:[meta]};
    if(m.type==='AE_RESEARCH_GET')return {ok:true,record,has_payload:true};
    if(m.type==='AE_RESEARCH_SEARCH')return {ok:true,results:[{key:record.key,score:1,snippet:{text:'Start with one screen',field:'text'}}],total:1};
    if(m.type==='AE_RESEARCH_INSIGHTS')return {ok:true,insights,library:{count:1,bytes:2048}};
    if(m.type==='AE_RESEARCH_VERIFY')return {ok:true,report};
    if(m.type==='AE_RESEARCH_EXPORT_DATA')return {ok:true,items:[{key:record.key,title:record.title,mode:'agent',updated_at:record.updated_at,json:'{"export":true}',markdown:'# Weather'}]};
    if(m.type==='AE_RESEARCH_EXPORT')return {ok:true,text:'# Weather',filename:'arena_agent_library_test.md'};
    return undefined;
  }});
  await settle(f);
  assert.equal(f.document.getElementById('library-rows').children.length,1);
  assert.equal(f.document.getElementById('total-library').textContent,'1');
  assert.ok(f.document.getElementById('library-scope-note').textContent.includes('Full-text search covers'));

  const row=f.document.getElementById('library-rows').children[0];
  await row.children[0].children[0].fire();await settle(f);
  assert.equal(f.document.getElementById('reader-title').textContent,record.title);
  assert.equal(f.document.getElementById('reader-subtitle').textContent.includes('2 turns'),true);
  assert.equal(f.document.getElementById('reader-body').children.length>0,true);
  assert.ok(f.document.getElementById('reader-body').children.some?.(c=>c.className.includes('reader-messages')));
  assert.equal(f.document.getElementById('reader-export-json').disabled,false);
  await f.fire('reader-export-json');assert.equal(f.last('AE_RESEARCH_EXPORT').format,'json');
  await f.fire('reader-copy');assert.equal(f.copied.at(-1),'# Weather');
  await f.fire('reader-back');await settle(f);
  assert.equal(f.document.getElementById('view-library').classList.contains('hidden'),false);

  const nav=view=>[...f.document.querySelectorAll('[data-view]')].find(el=>el.dataset.view===view);
  await nav('insights').fire();await settle(f);
  assert.equal(f.document.getElementById('view-insights').classList.contains('hidden'),false);
  assert.equal(f.document.getElementById('insights-conversations').textContent,'1');
  assert.equal(f.document.getElementById('insights-tools').textContent,'1');

  await nav('health').fire();await settle(f);
  assert.equal(f.document.getElementById('health-indexed').textContent,'1');
  await f.fire('btn-health-verify');await settle(f);
  assert.ok(f.document.getElementById('health-details').children.length>0);
  assert.ok(f.document.getElementById('progress-msg').textContent.includes('matches'));

  await nav('library').fire();await settle(f);
  await f.fire('btn-bulk-export');await settle(f);
  assert.equal(f.last('AE_RESEARCH_EXPORT_DATA').keys.length,1);
  assert.ok(f.document.getElementById('progress-msg').textContent.includes('Exported 1 conversation'));
  console.log('Offline reader, transcript rendering, JSON/copy export, insights, health verification, and bulk ZIP export passed');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
