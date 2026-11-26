export async function runNativeFinalizationContract({scenarios,modes=['indexeddb','sqlite']}={}){
 const assert=(value,message)=>{if(!value)throw new Error(message);},results=[];
 const st=await import('/script.js'),ext=await import('/scripts/extensions.js');ext.extension_settings['boxed-lllllabc'].enabled=false;
 const base='/scripts/extensions/third-party/boxed-lllllabc/src/';
 const {nativeChatHash}=await import(base+'backup/native-content.js'),{pendingRecordFingerprint}=await import(base+'backup/pending-journal.js');
 const post=async(url,body)=>{const response=await fetch(url,{method:'POST',headers:st.getRequestHeaders(),body:JSON.stringify(body)});if(!response.ok)throw new Error(url+' '+response.status);return response.json();};
 const avatar=(await post('/api/characters/duplicate',{avatar_url:'default_Seraphina.png'})).path;await ext.getContext().getCharacters();await st.selectCharacterById(ext.getContext().characters.findIndex(row=>row.avatar===avatar));
 for(const mode of modes)for(const scenario of scenarios??['rounds','split','full','stream-finish','stream-stop','post-render','legacy-reload','legacy-followup','legacy-split','legacy-full','unsaved-delete-edit','stale-reload','swipe','swipe-stream']){
  await window.finalizationProgress?.({mode,scenario,phase:'start'});
  const name='finalization-'+crypto.randomUUID(),integrity=crypto.randomUUID();
  const original=Array.from({length:scenario.includes('reload')||scenario.includes('delete')?4:1},(_,i)=>({name:'Audit',is_user:false,is_system:false,mes:'baseline '+i,swipe_id:0,swipes:['baseline '+i],swipe_info:[{extra:{reasoning:''}}],extra:{reasoning:''}}));
  await post('/api/chats/save',{avatar_url:avatar,file_name:name,ch_name:'Audit',force:false,chat:[{chat_metadata:{integrity}},...original]});await ext.getContext().openCharacterChat(name);await st.saveChatConditional();
  const storage=mode==='sqlite'?(await import(base+'storage/sqlite-client.js')).createSqliteStorage({getRequestHeaders:st.getRequestHeaders}):(await import(base+'storage/indexeddb-adapter.js')).createIndexedDbStorage();
  let generationRunning=false;
  const automatic=scenario.startsWith('swipe-auto')||scenario.startsWith('swipe-ui');
  const settings={enabled:true,recentBackupEnabled:true,fullBackupEnabled:scenario.includes('full'),historicalBackupEnabled:true,recentLimit:2,backendVerifyDelayMs:automatic?500:0};
  const mount=async(source)=>{
   const {createContextReader}=await import(source+'context.js'),{createBackupCoordinator}=await import(source+'controllers/backup-coordinator.js'),{createBackendVerifier}=await import(source+'controllers/backend-verifier.js'),{registerBackupEvents}=await import(source+'events.js'),{readBackupRecords}=await import(source+'storage/backup-batches.js');
   const reader=createContextReader({getContext:ext.getContext}),key=reader.readCurrentChat().identity.chatKey;
   const use=async fn=>{const session=await storage.open();try{return await fn(session);}finally{session.close();}},read=store=>use(session=>readBackupRecords(session,key,store));
   if(scenario.startsWith('swipe-ui')){
    const {createStorageControl}=await import(source+'storage/control.js');await createStorageControl().update(state=>({...state,active:mode,previous:null,lastTransfer:null,journal:null}));
    Object.assign(ext.extension_settings['boxed-lllllabc'],settings);await window.boxedLllllabcDebug.refreshNow();
    return {key,read,status:()=>window.boxedLllllabcDebug.getStatus(),close:()=>{ext.extension_settings['boxed-lllllabc'].enabled=false;}};
   }
   let status,verifier;
   const coordinator=createBackupCoordinator({storage,getContextReader:()=>reader,getSettings:()=>settings,getLatestStatus:()=>status,setStatus:s=>status=s,refreshVisiblePanel:async()=>{},prepareBackup:async()=>{verifier?.clearScheduledVerification();await verifier?.whenIdle();},clearScheduledVerification:()=>verifier?.clearScheduledVerification(),scheduleBackendVerification:(...args)=>{if(automatic)verifier.scheduleBackendVerification(...args);},scheduleBackendSnapshotVerification:(...args)=>{if(automatic)verifier.scheduleBackendSnapshotVerification(...args);},readChatCatalog:async()=>({ok:true,entries:[]})});
   verifier=createBackendVerifier({storage,getContextReader:()=>reader,getSettings:()=>settings,getLatestStatus:()=>status,setStatus:s=>status=s,refreshVisiblePanel:async()=>{},readCurrentPending:coordinator.readCurrentPending,updateBackendMeta:coordinator.updateBackendMeta,createDisplayStatus:coordinator.createDisplayStatus,prioritizeFullBackupStatus:coordinator.prioritizeFullBackupStatus,needsFullBackupConfirmation:coordinator.needsFullBackupConfirmation,confirmFullBackup:coordinator.confirmFullBackupAfterBackendVerification,ensurePendingBackups:coordinator.ensurePendingBackups,preparePendingVerification:coordinator.preparePendingVerification,isGenerating:()=>generationRunning||Boolean(st.isGenerating?.()),retryDelays:automatic?[2000,5000,10000]:[]});
   const events=registerBackupEvents({eventSource:st.eventSource,eventTypes:st.event_types,debounceMs:automatic?500:100000,captureTrigger:trigger=>{const captured=coordinator.captureTrigger(trigger);if(scenario.startsWith('swipe')){const chat=structuredClone(ext.getContext().chat);void Promise.resolve(captured?.ready).then(()=>window.auditTrace({mode,scenario,event:trigger.eventName,args:trigger.args,records:captured?.records,chat}));}return captured;},onObserved:()=>{coordinator.noteSourceChange();verifier.clearScheduledVerification();},onBackupNeeded:coordinator.runBackupNow});
   await coordinator.runBackupNow({eventName:'extension-loaded',args:[]});
   return {key,read,coordinator,flush:()=>events.flush(),verify:()=>verifier.verifyBackendNow({chatKey:key}),status:()=>status,close:()=>{events.unregister();verifier.clearScheduledVerification();}};
  };
  await window.finalizationProgress?.({mode,scenario,phase:'mount'});
  let f=await mount(scenario.startsWith('legacy')?'/boxed-yellow-release/src/':base);let legacyCount=0;
  const reply=async()=>{await st.saveReply({type:'normal',getMessage:'native final answer'});await st.saveChatConditional();await st.eventSource.emit(st.event_types.GENERATION_ENDED,ext.getContext().chat.length);};
  const green=async()=>{
   if(automatic){
    await window.finalizationProgress?.({mode,scenario,phase:'automatic-verification'});
    const start=Date.now();let stable=0;
    while(Date.now()-start<45000){
     await new Promise(resolve=>setTimeout(resolve,250));
     const chat=ext.getContext().chat,hash=nativeChatHash(chat);
     let ready=!st.isGenerating()&&!(await f.read('pending_changes')).length&&f.status()?.code==='saved';
     if(ready)ready=nativeChatHash((await f.read('recent_messages')).map(row=>row.raw))===nativeChatHash(chat.slice(-settings.recentLimit));
     if(ready&&settings.fullBackupEnabled)ready=nativeChatHash((await f.read('full_messages')).map(row=>row.raw))===hash;
     if(ready)ready=await window.auditDisk({avatar,name,current:JSON.parse(JSON.stringify(chat))}).then(()=>true,()=>false);
     if(ready)ready=!(await f.read('pending_changes')).length&&f.status()?.code==='saved'&&nativeChatHash(ext.getContext().chat)===hash;
     stable=ready?stable+1:0;if(stable===2)break;
    }
    if(stable!==2)await window.auditTrace({mode,scenario,phase:'automatic-timeout',pending:await f.read('pending_changes'),status:f.status(),recent:await f.read('recent_messages'),chat:structuredClone(ext.getContext().chat)});
    assert(stable===2,'automatic swipe finalization did not reach a stable saved file and backups');
   }else{await window.finalizationProgress?.({mode,scenario,phase:'flush'});await f.flush();await window.finalizationProgress?.({mode,scenario,phase:'verify'});await f.verify();}
   const pending=await f.read('pending_changes');if(scenario.startsWith('swipe'))await window.auditTrace({mode,scenario,phase:'verified',status:f.status(),pending,chat:structuredClone(ext.getContext().chat)});
   assert(pending.length===0&&f.status().code==='saved',scenario+' '+mode+' '+f.status().shortText+' pending='+pending.length);await window.auditDisk({avatar,name,current:JSON.parse(JSON.stringify(ext.getContext().chat))});
   if(scenario.startsWith('swipe')){
    const chat=ext.getContext().chat,recent=await f.read('recent_messages');
    if(nativeChatHash(recent.map(row=>row.raw))!==nativeChatHash(chat.slice(-settings.recentLimit)))await window.auditTrace({mode,scenario,phase:'recent-mismatch',recent,chat:structuredClone(chat),status:f.status(),pending:await f.read('pending_changes')});
    assert(nativeChatHash(recent.map(row=>row.raw))===nativeChatHash(chat.slice(-settings.recentLimit)),'recent swipe backup differs');
    if(settings.fullBackupEnabled)assert(nativeChatHash((await f.read('full_messages')).map(row=>row.raw))===nativeChatHash(chat),'full swipe backup differs');
    if(scenario.startsWith('swipe-ui'))assert(document.querySelector('#boxed-lllllabc-status-line')?.dataset.status==='saved','visible status did not turn green');
   }
  };
  try{
   if(scenario.startsWith('swipe')){
    const {oai_settings}=await import('/scripts/openai.js');oai_settings.stream_openai=scenario.includes('stream');oai_settings.chat_completion_source='openai';oai_settings.openai_model='gpt-4o-mini';
    st.setOnlineStatus('isolated fixture');
    document.querySelector('#send_textarea').value='native swipe user';await st.Generate('normal');await green();
    const first=ext.getContext().chat.at(-1).mes;
    const waitSaved=async(id)=>{
     const deadline=Date.now()+30000;
     while(Date.now()<deadline){
      const message=ext.getContext().chat.at(-1);
      if(message.swipe_id===id&&!st.isGenerating()&&message.swipes[id]===message.mes&&await window.auditDisk({avatar,name,current:JSON.parse(JSON.stringify(ext.getContext().chat))}).then(()=>true,()=>false))return;
      await new Promise(resolve=>setTimeout(resolve,100));
     }
     await window.auditTrace({mode,scenario,phase:'save-timeout',generating:st.isGenerating(),chat:structuredClone(ext.getContext().chat)});throw new Error('native swipe save did not finish');
    };
    await window.finalizationProgress?.({mode,scenario,phase:'new-swipe'});
    document.querySelector('#chat .last_mes .swipe_right').click();
    if(scenario.endsWith('resume'))window.dispatchEvent(new Event('pagehide'));
    if(scenario.endsWith('refresh')||scenario.endsWith('resume')){
     const deadline=Date.now()+15000;let previous;
     while(Date.now()<deadline){
      const text=ext.getContext().chat.at(-1).mes;
      if(text!==previous){previous=text;await window.auditTrace({mode,scenario,phase:'stream-observation',text,generating:st.isGenerating()});}
      if(st.isGenerating()&&text!==first&&text!=='...'&&text.includes('isolated native'))break;
      await new Promise(resolve=>setTimeout(resolve,25));
     }
     assert(st.isGenerating(),'refresh was not during streaming');
     if(scenario.endsWith('resume'))window.dispatchEvent(new Event('pageshow'));else await window.boxedLllllabcDebug.refreshNow();
    }
    await waitSaved(1);await green();
    const message=ext.getContext().chat.at(-1),second=message.mes;
    assert(message.swipes.length===2&&message.swipes[0]===first&&message.swipes[1]===second&&first!==second,'new swipe content missing');
    for(const [selector,expected]of [['swipe_left',first],['swipe_right',second]]){
     document.querySelector('#chat .last_mes .'+selector).click();await waitSaved(selector==='swipe_left'?0:1);await green();
     assert(message.mes===expected&&message.swipes[0]===first&&message.swipes[1]===second,'existing swipe lost');
    }
   }else if(scenario.startsWith('legacy')){
    for(let turn=0;turn<(scenario==='legacy-split'?1:3);turn++){
     await st.sendMessageAsUser('legacy native user '+turn,'');
     if(scenario==='legacy-split'){await f.flush();await f.verify();assert(!(await f.read('pending_changes')).length,'legacy user-only control failed');}
     await reply();await f.flush();
    }
    const old=await f.read('pending_changes'),fingerprints=old.map(pendingRecordFingerprint);legacyCount=old.length;assert(legacyCount>0,'legacy data missing');
    f.close();await ext.getContext().openCharacterChat(name);f=await mount(base);
    assert(JSON.stringify((await f.read('pending_changes')).map(pendingRecordFingerprint))===JSON.stringify(fingerprints),'legacy records were rewritten on load');
    if(scenario==='legacy-followup'){await st.sendMessageAsUser('after reload','');await reply();}
    await green();
   }else if(scenario==='unsaved-delete-edit'||scenario==='stale-reload'){
    await window.auditBlockSave(true);
    if(scenario==='unsaved-delete-edit')await st.deleteMessage(1);
    const chat=ext.getContext().chat;chat[0].mes='protected unsaved B';chat[0].swipes[0]=chat[0].mes;await st.eventSource.emit(st.event_types.MESSAGE_EDITED,0);await f.flush();
    const target=structuredClone(chat);
    if(scenario==='stale-reload'){await window.auditBlockSave(false);await ext.getContext().openCharacterChat(name);await f.flush();}
    await f.verify();const pending=await f.read('pending_changes');assert(pending.length>0&&f.status().code!=='saved','unsaved intent was retired');
    const {readBackendChat}=await import(base+'verifier/backend-reader.js'),{createContextReader}=await import(base+'context.js'),{createPendingRestorePlan}=await import(base+'backup/restore.js');
    const reader=createContextReader({getContext:ext.getContext}),backend=await readBackendChat({current:reader.readCurrentChat()});
    const plan=createPendingRestorePlan({chat:backend.chat.slice(1),chatKey:f.key,pending,chatIntegrity:integrity});
    assert(!plan.blockedReason&&nativeChatHash(plan.targetChat)===nativeChatHash(target),'protected target cannot be restored: '+plan.blockedReason);
    results.push({mode,scenario,pending:pending.length,protectedAndRecoverable:true});continue;
   }else if(scenario.startsWith('stream')){
    generationRunning=true;
    await st.sendMessageAsUser('native streaming user','');
    const {PromptReasoning}=await import('/scripts/reasoning.js'),processor=new st.BoxedFixtureStreamingProcessor('normal',false,new Date(),'',new PromptReasoning());
    processor.messageId=await processor.onStartStreaming('partial');processor.result='partial body';await processor.onProgressStreaming(processor.messageId,processor.result,false);
    await f.flush();await f.verify();assert(f.status().code!=='saved','unsaved partial stream incorrectly confirmed');
    processor.result=scenario==='stream-stop'?'stopped partial body':'complete streamed body';await processor.onProgressStreaming(processor.messageId,processor.result,true);
    if(scenario==='stream-stop'){processor.abortController.abort();await st.eventSource.emit(st.event_types.GENERATION_STOPPED);}
    await processor.onFinishStreaming(processor.messageId,processor.result);generationRunning=false;await green();
   }else{
    for(let turn=0;turn<(scenario==='rounds'?3:1);turn++){
     await window.finalizationProgress?.({mode,scenario,phase:'send-user',turn});
     await st.sendMessageAsUser('native user '+turn,'');
     if(scenario==='split'){await f.flush();await f.verify();assert(f.status().code==='saved','user-only phase not green');}
     await window.finalizationProgress?.({mode,scenario,phase:'reply',turn});await reply();
     if(scenario==='post-render'){
      await f.flush();ext.getContext().chat[1].extra.real_third_party={value:'retain all fields'};await st.saveChatConditional();
     }
     await green();
    }
   }
   results.push({mode,scenario,status:f.status().code,pending:(await f.read('pending_changes')).length,legacyCount,fileVerified:true});
  }finally{f.close();await window.auditBlockSave(false);}
  await window.finalizationProgress?.({mode,scenario,ok:true});
 }
 return results;
}
