const assert=require('node:assert/strict'),{uiFixture}=require('./ui-harness'),view=require('../src/ui-model');
const entries=Array.from({length:25},(_,i)=>({key:'c:'+i,title:i===0?'Unique weather project':'Conversation '+i,mode:i%2?'battle':'agent',subtype:'text',turns:i,models:i%2?['Alpha','Beta']:[],rel:'agent/folder-'+i,url:'https://arena.ai/c/'+i,updated_at:'2026-09-'+String(i+1).padStart(2,'0'),completeness:'full'}));
(async()=>{
  const f=await uiFixture('options',{entries});assert.equal(f.document.getElementById('library-rows').children.length,20);await f.fire('page-next');assert.equal(f.document.getElementById('library-rows').children.length,5);
  f.document.getElementById('library-search').value='UNIQUE weather';await f.fire('library-search','input');assert.equal(f.document.getElementById('library-rows').children.length,1);assert.equal(f.document.getElementById('page-label').textContent,'Page 1 / 1');
  const row=f.document.getElementById('library-rows').children[0];await row.children[4].children[0].children[0].fire();await f.tick();assert.equal(f.last('AE_OPEN_ARCHIVED_FOLDER').key,'c:0');
  await row.children[0].children[0].fire();assert.equal(f.opened.at(-1).url,'https://arena.ai/c/0');
  f.document.getElementById('library-search').value='Nothing matches this';await f.fire('library-search','input');assert.ok(!f.document.getElementById('library-empty').classList.contains('hidden'));await f.fire('empty-reset');assert.equal(f.document.getElementById('library-rows').children.length,20);
  assert.equal(view.filterEntries(entries,'Alpha','agent','recent').length,0);assert.equal(view.filterEntries(entries,'Alpha','battle','recent').length,12);assert.equal(view.filterEntries(entries,'','all','turns')[0].turns,24);
  assert.equal(view.arenaUrl('https://arena.ai.attacker.test/c/a'),false);assert.equal(view.backupLabel({ok:true,connected:true,enabled:true,pending:0}),'GitHub backup ready');assert.equal(view.backupLabel({ok:true,connected:true,enabled:true,pending:0,lastSuccess:'today'}),'Backed up to GitHub');
  await f.fire('btn-diagnostics');assert.equal(f.last('AE_SAVE_TEXT').filename,'arena-exporter-diagnostics.json');
  console.log('Library search, filtering, pagination, folder/Arena actions, empty states, backup labels and diagnostics passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
