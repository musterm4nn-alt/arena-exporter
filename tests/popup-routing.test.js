const assert=require('node:assert/strict'),{uiFixture}=require('./ui-harness');
(async()=>{
  const f=await uiFixture();assert.equal(f.last('AE_GET_STATE').sessionKey,'c:active-tab-uuid');
  await f.fire('btn-full');assert.equal(f.last('AE_EXPORT').tabId,55);assert.equal(f.last('AE_EXPORT').save,true);assert.equal(f.last('AE_EXPORT').mode,'full_history');
  await f.document.querySelectorAll('input[name="scope"]').find(e=>e.value==='last_message').fire('change');
  f.document.getElementById('export-format').value='markdown';await f.fire('export-format','change');await f.fire('btn-full');
  assert.equal(f.last('AE_EXPORT').mode,'last_message');assert.equal(f.last('AE_EXPORT').format,'markdown');assert.equal(f.document.getElementById('export-label').textContent,'Export Markdown');
  await f.fire('btn-copy');assert.equal(f.last('AE_EXPORT').save,undefined);assert.equal(f.copied.length,1);
  await f.fire('vote-a');assert.equal(f.last('AE_SET_MANUAL_VOTE').sessionKey,'c:active-tab-uuid');
  await f.fire('btn-clear');assert.equal(f.last('AE_CLEAR'),undefined,'Confirmation must precede clearing');await f.fire('confirm-clear');assert.equal(f.last('AE_CLEAR').sessionKey,'c:active-tab-uuid');
  f.setTab({id:81,url:'https://arena.ai/agent/new-tab'});await f.fire('btn-sync');assert.equal(f.last('AE_SYNC').sessionKey,'c:new-tab');
  f.setTab({id:9,url:'https://example.com/'});const before=f.sent.length;await f.fire('btn-full');assert.equal(f.sent.length,before,'Never export an unrelated session');assert.match(f.document.getElementById('progress-msg').textContent,/Select an Arena/);
  const empty=await uiFixture('popup',{tab:{id:9,url:'https://example.com/'}});assert.equal(empty.last('AE_GET_STATE'),undefined);assert.ok(!empty.document.getElementById('empty-state').classList.contains('hidden'));
  const error=await uiFixture('popup',{respond:m=>m.type==='AE_EXPORT'?{ok:false,error:'FILE_FAILED'}:undefined});await error.fire('btn-full');assert.equal(error.document.getElementById('progress-msg').dataset.tone,'error');assert.equal(error.document.getElementById('btn-full').disabled,false);
  console.log('Popup scope, formats, clipboard, tab routing, confirmation, empty and error states passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
