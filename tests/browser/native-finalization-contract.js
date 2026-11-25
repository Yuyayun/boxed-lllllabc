export async function runNativeFinalizationContract({scenarios}={}){
 const assert=(value,message)=>{if(!value)throw new Error(message);},results=[];
 const st=await import('/script.js'),ext=await import('/scripts/extensions.js');ext.extension_settings['boxed-lllllabc'].enabled=false;
 const base='/scripts/extensions/third-party/boxed-lllllabc/src/';
 const {nativeChatHash}=await import(base+'backup/native-content.js'),{pendingRecordFingerprint}=await import(base+'backup/pending-journal.js');
 const post=async(url,body)=>{const response=await fetch(url,{method:'POST',headers:st.getRequestHeaders(),body:JSON.stringify(body)});if(!response.ok)throw new Error(url+' '+response.status);return response.json();};
 const avatar=(await post('/api/characters/duplicate',{avatar_url:'default_Seraphina.png'})).path;await ext.getContext().getCharacters();await st.selectCharacterById(ext.getContext().characters.findIndex(row=>row.avatar===avatar));
 for(const mode of ['indexeddb','sqlite'])for(const scenario of scenarios??['rounds','split','full','stream-finish','stream-stop','post-render','legacy-reload','legacy-followup','legacy-split','legacy-full','unsaved-delete-edit','stale-reload']){
  await window.finalizationProgress?.({mode,scenario,phase:'start'});
  const name='finalization-'+crypto.randomUUID(),integrity=crypto.randomUUID();
  const original=Array.from({length:scenario.includes('reload')||scenario.includes('delete')?4:1},(_,i)=>({name:'Audit',is_user:false,is_system:false,mes:'baseline '+i,swipe_id:0,swipes:['baseline '+i],swipe_info:[{extra:{reasoning:''}}],extra:{reasoning:''}}));
  await post('/api/chats/save',{avatar_url:avatar,file_name:name,ch_name:'Audit',force:false,chat:[{chat_metadata:{integrity}},...original]});await ext.getContext().openCharacterChat(name);await st.saveChatConditional();
  const storage=mode==='sqlite'?(await import(base+'storage/sqlite-client.js')).createSqliteStorage({getRequestHeaders:st.getRequestHeaders}):(await import(base+'storage/indexeddb-adapter.js')).createIndexedDbStorage();
  let generationRunning=false;
  const settings={enabled:true,recentBackupEnabled:true,fullBackupEnabled:scenario==='full'||scenario==='legacy-full',historicalBackupEnabled:true,recentLimit:2,backendVerifyDelayMs:0};
  const mount=async(source)=>{
   const {createContextReader}=await import(source+'context.js'),{createBackupCoordinator}=await import(source+'controllers/backup-coordinator.js'),{createBackendVerifier}=await import(source+'controllers/backend-verifier.js'),{registerBackupEvents}=await import(source+'events.js'),{readBackupRecords}=await import(source+'storage/backup-batches.js');
   const reader=createContextReader({getContext:ext.getContext}),key=reader.readCurrentChat().identity.chatKey;
   const use=async fn=>{const session=await storage.open();try{return await fn(session);}finally{session.close();}},read=store=>use(session=>readBackupRecords(session,key,store));
   let status,verifier;
   const coordinator=createBackupCoordinator({storage,getContextReader:()=>reader,getSettings:()=>settings,getLatestStatus:()=>status,setStatus:s=>status=s,refreshVisiblePanel:async()=>{},prepareBackup:async()=>{verifier?.clearScheduledVerification();await verifier?.whenIdle();},clearScheduledVerification(){},scheduleBackendVerification(){},scheduleBackendSnapshotVerification(){},readChatCatalog:async()=>({ok:true,entries:[]})});
   verifier=createBackendVerifier({storage,getContextReader:()=>reader,getSettings:()=>settings,getLatestStatus:()=>status,setStatus:s=>status=s,refreshVisiblePanel:async()=>{},readCurrentPending:coordinator.readCurrentPending,updateBackendMeta:coordinator.updateBackendMeta,createDisplayStatus:coordinator.createDisplayStatus,prioritizeFullBackupStatus:coordinator.prioritizeFullBackupStatus,needsFullBackupConfirmation:coordinator.needsFullBackupConfirmation,confirmFullBackup:coordinator.confirmFullBackupAfterBackendVerification,ensurePendingBackups:coordinator.ensurePendingBackups,preparePendingVerification:coordinator.preparePendingVerification,isGenerating:()=>generationRunning||Boolean(st.isGenerating?.()),retryDelays:[]});
   const events=registerBackupEvents({eventSource:st.eventSource,eventTypes:st.event_types,debounceMs:100000,captureTrigger:coordinator.captureTrigger,onObserved:()=>{coordinator.noteSourceChange();verifier.clearScheduledVerification();},onBackupNeeded:coordinator.runBackupNow});
   await coordinator.runBackupNow({eventName:'extension-loaded',args:[]});
   return {key,read,coordinator,flush:()=>events.flush(),verify:()=>verifier.verifyBackendNow({chatKey:key}),status:()=>status,close:()=>{events.unregister();verifier.clearScheduledVerification();}};
  };
  await window.finalizationProgress?.({mode,scenario,phase:'mount'});
  let f=await mount(scenario.startsWith('legacy')?'/boxed-yellow-release/src/':base);let legacyCount=0;
  const reply=async()=>{await st.saveReply({type:'normal',getMessage:'native final answer'});await st.saveChatConditional();await st.eventSource.emit(st.event_types.GENERATION_ENDED,ext.getContext().chat.length);};
  const green=async()=>{await window.finalizationProgress?.({mode,scenario,phase:'flush'});await f.flush();await window.finalizationProgress?.({mode,scenario,phase:'verify'});await f.verify();assert((await f.read('pending_changes')).length===0&&f.status().code==='saved',scenario+' '+mode+' '+f.status().shortText+' pending='+(await f.read('pending_changes')).length);await window.auditDisk({avatar,name,current:JSON.parse(JSON.stringify(ext.getContext().chat))});};
  try{
   if(scenario.startsWith('legacy')){
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
