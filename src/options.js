/* Archive workspace: library, optional GitHub backup, preferences and diagnostics. */
(function () {
  "use strict";
  var U=AEUI,$=U.$,entries=[],mode="all",page=0,pageSize=20,backup=null,diagnostic=null,importing=false;
  U.version();
  function navigate(view) {
    if(!["library","backup","preferences","diagnostics"].includes(view))view="library";
    document.querySelectorAll(".view").forEach(function(el){el.classList.toggle("hidden",el.id!=="view-"+view);});
    document.querySelectorAll("[data-view]").forEach(function(el){if(el.dataset.view===view)el.setAttribute("aria-current","page");else el.removeAttribute("aria-current");});
    document.title="Arena Exporter · "+view[0].toUpperCase()+view.slice(1);
    if(location.hash!=="#"+view)history.replaceState(null,"","#"+view);
    U.feedback("");
    if(view==="diagnostics")loadDiagnostics();
    if(view==="preferences")loadArenaTabs();
  }
  document.querySelectorAll("[data-view]").forEach(function(el){el.addEventListener("click",function(){navigate(el.dataset.view);});});
  window.addEventListener("hashchange",function(){navigate(location.hash.slice(1));});

  function openConversation(entry) {
    if(!AEView.arenaUrl(entry.url)) { U.feedback("This older archive has no Arena link. Use its folder button instead.","error");return; }
    chrome.tabs.create({url:entry.url});
  }
  function renderLibrary() {
    var filtered=AEView.filterEntries(entries,$("library-search").value,mode,$("library-sort").value), pages=Math.max(1,Math.ceil(filtered.length/pageSize));
    page=Math.min(page,pages-1);$("library-rows").replaceChildren();
    $("total-chats").textContent=entries.length;$("nav-count").textContent=entries.length;
    $("total-turns").textContent=entries.reduce(function(n,e){return n+(e.turns||0);},0).toLocaleString();
    $("result-count").textContent=filtered.length+" conversation"+(filtered.length===1?"":"s");
    U.show("library-loading",false);U.show("library-table-wrap",filtered.length>0);U.show("library-empty",filtered.length===0);
    $("empty-title").textContent=entries.length?"No conversations match just yet.":"A home for your next great answer.";
    $("empty-description").textContent=entries.length?"Try another search or clear your filters.":"Open an Arena conversation and choose Save now in the extension. Completed turns can also be saved automatically.";
    U.show("empty-reset",entries.length>0);U.show("empty-open-arena",entries.length===0);
    filtered.slice(page*pageSize,(page+1)*pageSize).forEach(function(e){
      var tr=U.element("tr"),titleCell=U.element("td"),title=U.element("button","conversation-link",e.title || "Untitled conversation");
      title.title=e.rel || e.title;title.addEventListener("click",function(){openConversation(e);});titleCell.appendChild(title);
      var sub=U.element("div","conversation-secondary");sub.appendChild(U.element("span","mode-chip "+AEView.mode(e.mode),AEView.modeLabel(e.mode).toUpperCase()));
      sub.appendChild(U.element("span","",e.subtype&&e.subtype!=="text"?e.subtype:e.completeness==="partial"?"Partial capture":""));titleCell.appendChild(sub);tr.appendChild(titleCell);
      var models=U.element("td");(e.models.length?e.models:[e.models_pending?"Awaiting reveal":"Not revealed"]).forEach(function(name){models.appendChild(U.element("span","model-name",name));});tr.appendChild(models);
      tr.appendChild(U.element("td","",e.turns));var date=U.element("td","date-cell",U.date(e.updated_at));date.title=e.updated_at || "";tr.appendChild(date);
      var actions=U.element("td"),row=U.element("div","row-actions"),folder=U.element("button","","▱"),arena=U.element("button","","↗");
      folder.title="Open folder: "+e.title;folder.setAttribute("aria-label",folder.title);
      folder.addEventListener("click",async function(){folder.disabled=true;U.feedback("Opening conversation folder…");
        try{U.require(await U.send({type:"AE_OPEN_ARCHIVED_FOLDER",key:e.key}));U.feedback("Opened the conversation folder.");}catch(error){U.feedback(error.message,"error");}finally{folder.disabled=false;}});
      arena.title="Open on Arena: "+e.title;arena.setAttribute("aria-label",arena.title);arena.disabled=!AEView.arenaUrl(e.url);arena.addEventListener("click",function(){openConversation(e);});
      row.append(folder,arena);actions.appendChild(row);tr.appendChild(actions);$("library-rows").appendChild(tr);
    });
    $("page-label").textContent="Page "+(page+1)+" / "+pages;$("page-prev").disabled=page===0;$("page-next").disabled=page===pages-1;
  }
  async function loadLibrary(){var r=U.require(await U.send({type:"AE_LIBRARY"}));entries=r.entries||[];renderLibrary();}
  U.on("library-search","input",function(){page=0;renderLibrary();});U.on("library-sort","change",function(){page=0;renderLibrary();});
  document.querySelectorAll("[data-mode]").forEach(function(button){button.addEventListener("click",function(){mode=button.dataset.mode;page=0;
    document.querySelectorAll("[data-mode]").forEach(function(el){el.setAttribute("aria-pressed",String(el===button));});renderLibrary();});});
  U.on("empty-reset","click",function(){$("library-search").value="";mode="all";page=0;document.querySelectorAll("[data-mode]").forEach(function(el){el.setAttribute("aria-pressed",String(el.dataset.mode==="all"));});renderLibrary();});
  U.on("page-prev","click",function(){page--;renderLibrary();});U.on("page-next","click",function(){page++;renderLibrary();});
  ["btn-open-arena","empty-open-arena"].forEach(function(id){U.on(id,"click",function(){chrome.tabs.create({url:"https://arena.ai/"});});});
  U.on("btn-refresh","click",function(){return U.run("btn-refresh","Reading archive…",async function(){await loadLibrary();U.feedback("Library is up to date.");});});

  function renderBackup(st,populate) {
    backup=st;
    if(!st || !st.ok){$("github-status").textContent=st&&st.error||"Unable to read backup status.";$("backup-summary").textContent="Offline";return;}
    if(populate){$("github-repo").value=st.repo||"";$("github-branch").value=st.branch||"";$("github-folder").value=st.folder||"arena-archive";}
    var label=AEView.backupLabel(st);$("github-state-label").textContent=label;$("github-dot").className="dot "+(st.error?"warn":st.enabled&&st.lastSuccess?"ok":"idle");
    $("github-status").textContent=(st.error || (st.running?"Uploading queued conversations. Keep this browser open.":st.enabled?"New archive writes are queued automatically.":st.connected?"New saves stay local until you resume backup.":"Connect a private repository to begin."))+
      (st.nextRetry?" Retry: "+U.date(st.nextRetry,true)+".":"")+(st.otherPending?" "+st.otherPending+" items belong to a previous destination.":"");
    $("github-destination").textContent=st.repo||"Not connected";$("github-pending").textContent=(st.pending||0)+" conversations";$("github-last").textContent=U.date(st.lastSuccess,true);
    $("github-now").disabled=!st.enabled||st.running;$("github-pause").disabled=!st.connected||st.running;$("github-pause").textContent=st.enabled?"Pause":"Resume";
    $("github-disconnect").disabled=!st.connected||st.running;$("github-import").disabled=!st.enabled||importing;
    $("backup-summary").textContent=st.error?"Check":st.running?"Syncing":!st.connected?"Off":!st.enabled?"Paused":st.pending?st.pending+" queued":st.lastSuccess?"Saved":"Ready";
    $("backup-summary-note").textContent=st.lastSuccess&&!st.pending&&!st.error?"Last upload "+U.date(st.lastSuccess):st.enabled?"Your private repository":"Connect in GitHub backup";
  }
  function githubPermission(){
    if(typeof browser!=="undefined")return browser.permissions.request({origins:["https://api.github.com/*"],data_collection:["personalCommunications","websiteContent","authenticationInfo"]});
    return new Promise(function(resolve){chrome.permissions.request({origins:["https://api.github.com/*"]},function(granted){void chrome.runtime.lastError;resolve(granted);});});
  }
  U.reconcile=function(){if(backup)renderBackup(backup);};
  U.on("github-form","submit",function(event){event.preventDefault();var permission=githubPermission();
    return U.run("github-connect","Connecting to your private repository…",async function(){
      if(!await permission)throw new Error("Allow GitHub access to enable backup.");
      var st=U.require(await U.send({type:"AE_GITHUB_CONFIGURE",config:{repo:$("github-repo").value,branch:$("github-branch").value,folder:$("github-folder").value,token:$("github-token").value}}));
      $("github-token").value="";renderBackup(st,true);U.feedback("Connected. New archive writes will be backed up automatically.");
    });
  });
  U.on("github-now","click",function(){return U.run("github-now","Uploading queued conversations…",async function(){
    var st;do{st=U.require(await U.send({type:"AE_GITHUB_FLUSH"}));renderBackup(st);$("github-now").disabled=true;}while(st.enabled&&st.pending&&!st.error);
    if(st.error)throw new Error(st.error);U.feedback(st.pending?"Backup paused. Remaining conversations stay queued.":"Backup queue is up to date.");
  });});
  U.on("github-pause","click",function(){return U.run("github-pause",backup&&backup.enabled?"Pausing backup…":"Resuming backup…",async function(){
    var st=U.require(await U.send(backup.enabled?{type:"AE_GITHUB_PAUSE"}:{type:"AE_GITHUB_CONFIGURE",config:{repo:backup.repo,branch:backup.branch,folder:backup.folder,token:""}}));
    renderBackup(st);U.feedback(st.enabled?"Automatic backup resumed.":"Backup paused. Local archiving continues.");
  });});
  U.on("github-disconnect","click",function(){return U.run("github-disconnect","Removing the saved connection…",async function(){
    renderBackup(U.require(await U.send({type:"AE_GITHUB_PAUSE",forget:true})));$("github-token").value="";U.feedback("Disconnected. Existing local files and GitHub commits are preserved.");
  });});
  U.on("github-import","change",async function(event){if(!event.target.files.length)return;importing=true;event.target.disabled=true;
    try{await U.importArchive(event.target.files);}catch(error){$("github-import-status").textContent=error.message+" Previously queued conversations remain queued.";}
    finally{importing=false;event.target.value="";renderBackup(await U.send({type:"AE_GITHUB_STATUS"}));}});

  U.on("auto-archive","change",async function(){var wanted=$("auto-archive").checked;$("auto-archive").disabled=true;
    try{U.require(await U.send({type:"AE_SET_PREFERENCES",preferences:{autoArchive:wanted}}));U.feedback(wanted?"Completed turns will archive automatically.":"Automatic archiving paused. Manual saves still work.");}
    catch(error){$("auto-archive").checked=!wanted;U.feedback(error.message,"error");}finally{$("auto-archive").disabled=false;}});
  var silentSupported=!!(chrome.downloads&&chrome.downloads.setUiOptions)&&typeof browser==="undefined";
  $("chk-silent").disabled=!silentSupported;if(!silentSupported)$("silent-note").textContent="Unavailable in this browser.";
  U.on("chk-silent","change",async function(){var wanted=$("chk-silent").checked;
    var permission=wanted?new Promise(function(resolve){chrome.permissions.request({permissions:["downloads.ui"]},function(granted){void chrome.runtime.lastError;resolve(granted);});}):Promise.resolve(true);
    $("chk-silent").disabled=true;
    try{if(!await permission)throw new Error("Download UI permission was not granted.");var res=U.require(await U.send({type:"AE_SET_SILENT",enabled:wanted}));
      if(wanted&&!res.suppressed)throw new Error("This browser could not suppress the download bubble.");U.feedback(wanted?"Quiet downloads enabled.":"Normal download UI restored.");}
    catch(error){$("chk-silent").checked=!wanted;U.feedback(error.message,"error");}finally{$("chk-silent").disabled=false;}});
  U.on("btn-selftest","click",function(){return U.run("btn-selftest","Writing a small archive test file…",async function(){
    var res=U.require(await U.send({type:"AE_TEST_ARCHIVE"}));$("selftest-result").textContent="Write verified: "+(res.resolved||res.path);U.feedback("Archive write completed and verified.");
  });});
  async function loadArenaTabs(){
    try{var tabs=(await chrome.tabs.query({})).filter(function(t){return AEView.arenaUrl(t.url);}),prev=$("history-tab").value;$("history-tab").replaceChildren();
      if(!tabs.length){var empty=U.element("option","","Open an Arena tab first");empty.value="";$("history-tab").appendChild(empty);}
      tabs.forEach(function(t){var op=U.element("option","",t.title||t.url);op.value=String(t.id);$("history-tab").appendChild(op);});
      if(tabs.some(function(t){return String(t.id)===prev;}))$("history-tab").value=prev;$("btn-history").disabled=!tabs.length;
    }catch(error){U.feedback(error.message,"error");}
  }
  U.on("btn-history","click",function(){return U.run("btn-history","Reading Arena history…",async function(){
    var id=Number($("history-tab").value);if(!id)throw new Error("Choose a signed-in Arena tab first.");
    $("history-status").textContent="Archiving your history. Keep this page and the Arena tab open.";
    var result=U.require(await U.send({type:"AE_HISTORY_BACKFILL",tabId:id}));
    var failed=Array.isArray(result.failed)?result.failed.length:Number(result.failed||0);
    $("history-status").textContent="History import finished. "+(result.written||0)+" saved, "+(result.skipped||0)+" skipped, "+failed+" failed.";
    U.feedback(failed?"History import finished with "+failed+" failed conversations. Retry to recover them.":"History import finished.",failed?"warning":null);await loadLibrary();
  });});
  async function loadDiagnostics(){try{diagnostic=U.require(await U.send({type:"AE_DIAGNOSTICS"})).diagnostics;$("diagnostic-output").value=JSON.stringify(diagnostic,null,2);}catch(error){U.feedback(error.message,"error");}}
  U.on("btn-diagnostics-refresh","click",loadDiagnostics);
  U.on("btn-diagnostics","click",function(){return U.run("btn-diagnostics","Preparing diagnostics…",async function(){
    await loadDiagnostics();if(!diagnostic)throw new Error("No diagnostic report is available.");
    U.require(await U.send({type:"AE_SAVE_TEXT",filename:"arena-exporter-diagnostics.json",text:JSON.stringify(diagnostic,null,2),mime:"application/json"}));U.feedback("Diagnostics saved without conversation content.");
  });});
  async function refresh(){
    try{await Promise.all([loadLibrary(),U.send({type:"AE_GITHUB_STATUS"}).then(function(st){renderBackup(st);}),U.send({type:"AE_PREFERENCES"}).then(function(r){if(r.ok)$("auto-archive").checked=r.preferences.autoArchive;})]);}
    catch(error){U.feedback(error.message,"error");U.show("library-loading",false);}
  }
  async function init(){
    navigate(location.hash.slice(1));
    await refresh();renderBackup(await U.send({type:"AE_GITHUB_STATUS"}),true);
    var native=await U.send({type:"AE_NATIVE_STATUS"});$("native-status").textContent=native.state==="ok"?"Arena Archive app connected. Its selected folder is used for saves.":native.state==="no-root"?"Choose a folder in the Arena Archive app. Downloads is used until then.":"Using your browser's download folder. Install the optional Arena Archive app to choose another destination.";
    if(native.state==="ok")$("archive-path").textContent="Arena Archive / selected folder";
    chrome.storage.local.get(["ae_silent_writes"],function(r){void chrome.runtime.lastError;$("chk-silent").checked=silentSupported&&!!(r&&r.ae_silent_writes);});
    await loadArenaTabs();
  }
  U.subscribe(refresh);init().catch(function(error){U.feedback(error.message,"error");});
})();
