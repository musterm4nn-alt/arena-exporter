/* Every conversation action resolves the selected tab immediately before use. */
(function () {
  "use strict";
  var U=AEUI, $=U.$, refreshing=false, scope="full_history", streamTimer=null;
  U.version();
  async function context(snapshot) {
    var tab=await U.activeTab();
    if(!tab || !AEView.arenaUrl(tab.url)) throw new Error("Select an Arena conversation tab first.");
    var key=AEView.conversationKey(tab.url);
    var result={tabId:tab.id, sessionKey:key || "tab:"+tab.id};
    if(snapshot) result.snapshot=await U.tabMessage(tab.id,{type:"AE_DOM_SNAPSHOT"});
    if(result.snapshot && AEView.conversationKey(result.snapshot.url) !== key) throw new Error("The conversation changed. Reopen the extension and try again.");
    return result;
  }
  function render(st, tab) {
    var ready=!!AEView.conversationKey(tab.url) || !!st.messageCount;
    U.show("active-content",ready);U.show("empty-state",!ready);
    $("conversation-title").textContent=st.title || (ready ? "Untitled conversation" : "Ready when you are.");
    $("context-msg").textContent=ready ? "" : "Open a conversation to start capturing.";
    U.show("context-msg",!ready); U.show("conversation-meta",ready);
    var mode=st.mode || (/battle|direct|side-by-side/.exec(tab.url)||[])[0] || "agent";
    $("mode-tag").textContent=AEView.modeLabel(mode).toUpperCase();
    $("conversation-id").textContent=(st.conversationKey || "").replace(/^[cs]:/,"").slice(0,16);
    var failed=st.lastSync && st.lastSync.ok === false;
    var kind=failed || st.captureHealthCritical ? "error" : st.streaming ? "stream" : st.messageCount ? "ok" : "idle";
    $("status-dot").className="dot "+kind;
    $("capture-text").textContent=failed ? "Save failed" : st.captureHealthCritical ? "Check capture" : st.streaming ? "Capturing" : st.messageCount ? "Captured" : "Listening";
    var counts=st.blockCounts || {};
    $("stat-messages").textContent=st.messageCount || 0;$("stat-thinking").textContent=counts.thinking || 0;
    $("stat-tools").textContent=counts.tool_call || 0;$("stat-artifacts").textContent=counts.artifact || 0;
    $("btn-folder").disabled=!AEView.conversationKey(tab.url);
    $("sink-status").textContent=failed ? "Save failed · "+(st.lastSync.error || "Try again") : st.lastSync && st.lastSync.ok ?
      "Saved "+U.date(st.lastSync.at,true) : st.nativeSink && st.nativeSink.state === "ok" ? "Archive app connected" : "Downloads / arena-archive";
    $("archive-dot").className="dot "+(failed ? "error" : st.lastSync && st.lastSync.ok ? "ok" : "idle");
    var warnings=st.warnings || [];
    $("warning-list").replaceChildren();warnings.forEach(function(w){$("warning-list").appendChild(U.element("li","",w));});
    $("warnings-summary").textContent=warnings.length+" capture note"+(warnings.length===1?"":"s");
    U.show("warnings",warnings.length>0);U.show("vote-tools",AEView.mode(mode)==="battle");
    clearTimeout(streamTimer);
    if(st.streaming)streamTimer=setTimeout(function(){refresh(false);},2700);
  }
  async function refresh(snapshot) {
    if(refreshing)return;refreshing=true;
    try {
      var tab=await U.activeTab();
      if(!tab || !AEView.arenaUrl(tab.url)) {
        U.show("active-content",false);U.show("empty-state",true);U.show("conversation-meta",false);
        $("conversation-title").textContent="Ready when you are.";$("context-msg").textContent="Your archive stays with you.";
        $("capture-text").textContent="Standby";$("status-dot").className="dot idle";
      } else {
        var ctx=await context(snapshot === true), res=U.require(await U.send(Object.assign({type:"AE_GET_STATE"},ctx)));render(res.state,tab);
      }
      var results=await Promise.all([U.send({type:"AE_GITHUB_STATUS"}),U.send({type:"AE_PREFERENCES"})]);
      var backup=results[0];$("backup-status").textContent=AEView.backupLabel(backup);
      $("backup-dot").className="dot "+(backup.error ? "warn" : backup.enabled ? "ok" : "idle");
      if(results[1].ok)$("auto-archive").checked=results[1].preferences.autoArchive;
    } catch(error){U.feedback(error.message,"error");}finally{refreshing=false;}
  }
  function updateExportLabel(){
    $("export-label").textContent="Export "+($("export-format").value==="markdown"?"Markdown":"JSON");
    $("scope-hint").textContent=scope==="last_message"?"The last answer, with its triggering prompt.":"Includes messages, reasoning, tools and files.";
  }
  document.querySelectorAll('input[name="scope"]').forEach(function(input){input.addEventListener("change",function(){scope=input.value;updateExportLabel();});});
  U.on("export-format","change",updateExportLabel);
  U.on("btn-full","click",function(){return U.run("btn-full","Preparing export…",async function(){
    var request=Object.assign({type:"AE_EXPORT",mode:scope,format:$("export-format").value,save:true},await context(true));
    var result=U.require(await U.send(request));U.feedback("Saved "+result.filename+(result.savedCount?" + "+result.savedCount+" files":""));
  });});
  U.on("btn-copy","click",function(){return U.run("btn-copy","Preparing clipboard…",async function(){
    var result=U.require(await U.send(Object.assign({type:"AE_EXPORT",mode:scope,format:$("export-format").value},await context(true))));
    await navigator.clipboard.writeText(result.text || result.json);U.feedback("Copied to clipboard.");
  });});
  U.on("btn-sync","click",function(){return U.run("btn-sync","Saving conversation and files…",async function(){
    var result=U.require(await U.send(Object.assign({type:"AE_SYNC"},await context(true))));
    U.feedback(result.completeness==="partial" ? "Saved with capture gaps. Review the capture notes." : "Conversation saved to your archive.",result.completeness==="partial"?"warning":null);await refresh();
  });});
  U.on("btn-folder","click",function(){return U.run("btn-folder","Opening conversation folder…",async function(){
    U.require(await U.send(Object.assign({type:"AE_OPEN_FOLDER"},await context(false))));U.feedback("Opened the conversation folder.");
  });});
  U.on("auto-archive","change",async function(){var desired=$("auto-archive").checked;$("auto-archive").disabled=true;
    try{U.require(await U.send({type:"AE_SET_PREFERENCES",preferences:{autoArchive:desired}}));U.feedback(desired?"Completed turns will archive automatically.":"Automatic archiving paused. Save now still works.");}
    catch(error){$("auto-archive").checked=!desired;U.feedback(error.message,"error");}finally{$("auto-archive").disabled=false;}});
  [["vote-a","A"],["vote-b","B"],["vote-tie","both_good"],["vote-bad","neither_good"],["vote-clear","clear"]].forEach(function(pair){
    U.on(pair[0],"click",function(){return U.run(pair[0],"Saving vote correction…",async function(){U.require(await U.send(Object.assign({type:"AE_SET_MANUAL_VOTE",choice:pair[1]},await context(false))));U.feedback("Vote correction saved.");await refresh();});});
  });
  U.on("btn-clear","click",function(){U.show("reset-confirm",true);});U.on("cancel-clear","click",function(){U.show("reset-confirm",false);});
  U.on("confirm-clear","click",function(){return U.run("confirm-clear","Clearing capture…",async function(){U.require(await U.send(Object.assign({type:"AE_CLEAR"},await context(false))));U.show("reset-confirm",false);U.feedback("Capture cleared. Saved archive files are unchanged.");await refresh();});});
  U.on("btn-domdebug","click",function(){return U.run("btn-domdebug","Collecting page diagnostics…",async function(){
    var ctx=await context(false), result=await U.tabMessage(ctx.tabId,{type:"AE_DOM_DEBUG"});
    if(!result)throw new Error("Reload the Arena tab to enable page diagnostics.");
    U.require(await U.send({type:"AE_SAVE_TEXT",filename:"arena-page-diagnostics.json",text:JSON.stringify(result,null,2),mime:"application/json"}));U.feedback("Page diagnostics saved.");
  });});
  U.on("btn-arena","click",function(){chrome.tabs.create({url:"https://arena.ai/"});});
  ["btn-library","btn-library-empty"].forEach(function(id){U.on(id,"click",function(){U.openWorkspace("library");});});
  U.on("btn-settings","click",function(){U.openWorkspace("preferences");});U.on("backup-status","click",function(){U.openWorkspace("backup");});
  U.subscribe(function(){refresh(false);});refresh(true);
})();
