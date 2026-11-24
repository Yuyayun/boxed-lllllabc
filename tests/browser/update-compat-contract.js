export async function runUpdateCompatibilityContract({nonce}) {
 const checks=[],assert=(value,message)=>{if(!value)throw new Error(message);};
 const headers=()=>({'X-Test-Nonce':nonce,'X-CSRF-Token':nonce});
 const oldBase='/old/src/',newBase='/src/';
 const {createSqliteStorage:oldSqlite}=await import(oldBase+'storage/sqlite-client.js');
 const {createSqliteStorage:newSqlite}=await import(newBase+'storage/sqlite-client.js');
 const oldDatabase=await import(oldBase+'db/index.js'),newDatabase=await import(newBase+'db/index.js');
 const {createStorageControl}=await import(oldBase+'storage/control.js'),control=createStorageControl();
 const {createManagedStorage}=await import(oldBase+'storage/managed.js');
 const oldIndexed=(await import(oldBase+'storage/indexeddb-adapter.js')).createIndexedDbStorage();
 const oldServer=oldSqlite({getRequestHeaders:headers});
 const key=`character:compat-test.png:${crypto.randomUUID()}`,meta={chatKey:key,chatType:'character',characterAvatar:'compat-test.png',chatId:key};
 let session=await oldIndexed.open();await session.putChatMeta(meta);session.close();
 assert((await indexedDB.databases()).find(db=>db.name==='boxed-lllllabc')?.version===8,'旧前端应创建浏览器 v8');
 await control.update(state=>({...state,active:'sqlite'}));
 const managed=createManagedStorage({control,adapters:{sqlite:oldServer,indexeddb:oldIndexed}});
 await managed.refresh();session=await managed.open();
 try{await session.putChatMeta(meta);assert((await session.getChatMeta(key)).chatKey===key,'旧前端连新后端不可读写');}finally{session.close();}
 const status=await oldServer.status();assert(status.ok&&status.pluginVersion==='1.0.5'&&status.database.schema===4,'后端版本或 SQLite schema 不符');
 assert((await indexedDB.databases()).find(db=>db.name==='boxed-lllllabc')?.version===8,'仅后端更新不得升级浏览器库');
 checks.push('old-1.0.4-client-new-1.0.5-server-startup:sqlite4-local8');

 const current={ok:true,identity:{chatKey:key,meta},chat:[{mes:'旧前端正常聊天',extra:{fixture:true}},{mes:'第二条'}]};let latest,verifier;
 const settings={enabled:true,fullBackupEnabled:true,recentBackupEnabled:true,historicalBackupEnabled:true,recentLimit:1,backendVerifyDelayMs:0};
 const {createBackupCoordinator}=await import(oldBase+'controllers/backup-coordinator.js'),{createBackendVerifier}=await import(oldBase+'controllers/backend-verifier.js');
 const coordinator=createBackupCoordinator({storage:managed,getContextReader:()=>({readCurrentChat:()=>current}),getSettings:()=>settings,getLatestStatus:()=>latest,setStatus:value=>latest=value,refreshVisiblePanel:async()=>{},
  prepareBackup:async()=>{verifier?.clearScheduledVerification();await verifier?.whenIdle();},clearScheduledVerification(){},scheduleBackendVerification(){},scheduleBackendSnapshotVerification(){},readChatCatalog:async()=>({ok:true,entries:[]})});
 verifier=createBackendVerifier({storage:managed,getContextReader:()=>({readCurrentChat:()=>current}),getSettings:()=>settings,getLatestStatus:()=>latest,setStatus:value=>latest=value,refreshVisiblePanel:async()=>{},readCurrentPending:coordinator.readCurrentPending,updateBackendMeta:coordinator.updateBackendMeta,createDisplayStatus:coordinator.createDisplayStatus,prioritizeFullBackupStatus:coordinator.prioritizeFullBackupStatus,needsFullBackupConfirmation:coordinator.needsFullBackupConfirmation,confirmFullBackup:coordinator.confirmFullBackupAfterBackendVerification,ensurePendingBackups:coordinator.ensurePendingBackups,readBackend:async()=>({ok:true,chat:structuredClone(current.chat)}),retryDelays:[]});
 try{
  await coordinator.runBackupNow({eventName:'extension-loaded',args:[]});current.chat[0].mes='旧前端编辑';await coordinator.runBackupNow({eventName:'message_edited',args:[0]});await verifier.verifyBackendNow({chatKey:key});
  assert(latest.code==='saved',`旧前端正常备份核对失败：${JSON.stringify(latest)}`);
  session=await managed.open();try{assert(!(await session.getPendingChanges(key)).length,'旧格式正常保存未核销');assert((await session.getFullMessages(key))[0].raw.mes==='旧前端编辑','旧前端完整备份内容错误');}finally{session.close();}
  checks.push('old-client-real-coordinator-edit-verify-on-new-server');
 }finally{verifier.clearScheduledVerification();}

 // A queued open behind an unrelated blocked upgrade gets no onblocked event.
 // It must still finish with a useful error, rather than keep initialization pending.
 const held=await oldDatabase.openBackupDatabase();
 let rawRequest,blocked;
 const queuedUpgrade=new Promise((resolve,reject)=>{rawRequest=indexedDB.open('boxed-lllllabc',9);rawRequest.onsuccess=()=>resolve(rawRequest.result);rawRequest.onerror=()=>reject(rawRequest.error);});
 await new Promise(resolve=>{rawRequest.onblocked=()=>{blocked=true;resolve();};});assert(blocked,'未构造阻塞的升级');
 const pendingOpen=newDatabase.openBackupDatabase({timeoutMs:60});
 const outcome=await Promise.race([pendingOpen.then(db=>{db.close();return {kind:'opened'};},error=>({kind:'error',error})),new Promise(resolve=>setTimeout(()=>resolve({kind:'stalled'}),350))]);
 held.close();const upgraded=await queuedUpgrade;upgraded.close();await pendingOpen.then(db=>db.close(),()=>{});
 assert(outcome.kind==='error'&&outcome.error.code==='backup-database-timeout','数据库打开排队时没有超时保护，启动会一直等待');
 checks.push('queued-indexeddb-open-is-bounded-and-keeps-data');
 const latestDb=await newDatabase.openBackupDatabase();assert(latestDb.version===9,'新前端未升级到 v9');latestDb.close();
 const newLocal=(await import(newBase+'storage/indexeddb-adapter.js')).createIndexedDbStorage();session=await newLocal.open();try{assert((await session.getChatMeta(key)).chatKey===key,'浏览器升级丢失旧数据');}finally{session.close();}
 const oldAgain=await oldDatabase.openBackupDatabase().then(db=>{db.close();return null;},error=>error);
 assert(oldAgain?.name==='VersionError','旧前端不得打开新版浏览器库');
 session=await managed.open();try{assert((await session.getChatMeta(key)).chatKey===key,'浏览器库升级不应破坏旧前端的 SQLite 连接');}finally{session.close();}
 checks.push('sqlite-old-client-still-works-after-local9-upgrade');

 const {createPendingObserver}=await import(newBase+'backup/pending-journal.js');const watcher=createPendingObserver({readCurrent:()=>current});watcher.reset();current.chat.pop();const rows=watcher.capture({eventName:'message_deleted',args:[1]}).records;
 session=await newSqlite({getRequestHeaders:headers}).open();try{await session.putPendingChanges(rows);}finally{session.close();}
 session=await managed.open();try{let rejected;try{await session.replacePendingChanges({chatKey:key,records:[]});}catch(error){rejected=error;}assert(rejected?.code==='backup-client-upgrade-required','旧客户端不安全替换应明确提示更新前端');assert((await session.getPendingChanges(key)).length===rows.length,'新版记录被旧前端覆盖');}finally{session.close();}
 checks.push('old-client-cannot-overwrite-journals-and-gets-frontend-update-reason');

 // New connections close on versionchange; a stale frontend gets actionable copy.
 const live=await newDatabase.openBackupDatabase();
 const future=await new Promise((resolve,reject)=>{const request=indexedDB.open('boxed-lllllabc',10);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);request.onblocked=()=>{live.close();reject(new Error('新版连接未主动响应 versionchange'));};});future.close();
 const stale=await newDatabase.openBackupDatabase().then(db=>{db.close();return null;},error=>error);
 assert(stale?.code==='backup-client-upgrade-required'&&/更新.*前端|前端.*更新/.test(stale.message),'旧页面版本错误缺少可执行提示');
 const {backupFailureStatus}=await import(newBase+'backup/failure-status.js');assert(backupFailureStatus(stale).shortText==='前端扩展需要更新','不能把前端过旧说成后端需要更新');
 const {describeStorageFailure}=await import(newBase+'storage/health.js'),{openStorageWarningDialog}=await import(newBase+'ui/storage-status.js');
 openStorageWarningDialog({snapshot:{pressure:'error',failure:describeStorageFailure(stale)}});
 const warning=document.querySelector('#boxed-lllllabc-storage-warning-dialog');assert(warning.querySelector('strong').textContent==='前端扩展需要更新','版本问题误说成备份写入失败');assert(![...warning.querySelectorAll('button')].some(node=>node.textContent==='管理清理'),'版本问题不能引导用户清理数据');warning.querySelector('button[aria-label="关闭"]').click();
 checks.push('versionchange-closes-connection-and-stale-page-has-useful-update-copy');
 return checks;
}
