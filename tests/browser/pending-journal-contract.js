import {createIndexedDbStorage} from '../../src/storage/indexeddb-adapter.js';
import {createBackupCoordinator} from '../../src/controllers/backup-coordinator.js';
import {createBackendVerifier} from '../../src/controllers/backend-verifier.js';
import {registerBackupEvents} from '../../src/events.js';
import {createPendingRestorePlan} from '../../src/backup/restore.js';
import {executeRestorePlan} from '../../src/backup/restore-executor.js';
import {createRestoreJournal,pendingRecordFingerprint} from '../../src/backup/pending-journal.js';
import {comparePendingWithBackend} from '../../src/verifier/compare.js';
import {protectPendingRecord} from '../../src/backup/pending-protection.js';
import {readBackupRecords} from '../../src/storage/backup-batches.js';
import {openRecoveryCenterDialog} from '../../src/ui/recovery-center-dialog.js';
import {openRestoreDialog} from '../../src/ui/restore-dialog.js';
import {nativeChatHash} from '../../src/backup/native-content.js';

export async function runPendingJournalContract({adapter=createIndexedDbStorage(),mode='indexeddb'}={}) {
 if(location.hostname!=='127.0.0.1')throw new Error('仅限隔离测试');
 const checks=[],assert=(value,message)=>{if(!value)throw new Error(message);};
 for(const full of [false,true]) {
  const key=`character:journal-browser.png:${crypto.randomUUID()}`,original=Array.from({length:8},(_,i)=>({mes:`message ${i}`,original_avatar:'synthetic.png',extra:{test:true}}));
  const current={ok:true,chat:structuredClone(original),identity:{chatKey:key,meta:{chatType:'character',characterAvatar:'journal-browser.png',chatId:key}}};
  let disk=structuredClone(original),status,verifier;
  const settings={enabled:true,fullBackupEnabled:full,recentBackupEnabled:true,historicalBackupEnabled:true,recentLimit:2,backendVerifyDelayMs:0};
  const storage={getMode:()=>mode,open:()=>adapter.open()},reader=()=>({readCurrentChat:()=>current});
  const use=async fn=>{const s=await storage.open();try{return await fn(s);}finally{s.close();}};
  const read=store=>use(s=>readBackupRecords(s,key,store));
  const coordinator=createBackupCoordinator({storage,getContextReader:reader,getSettings:()=>settings,getLatestStatus:()=>status,setStatus:s=>status=s,refreshVisiblePanel:async()=>{},
   prepareBackup:async()=>{verifier?.clearScheduledVerification();await verifier?.whenIdle();},clearScheduledVerification(){},scheduleBackendVerification(){},scheduleBackendSnapshotVerification(){},readChatCatalog:async()=>({ok:true,entries:[]})});
  verifier=createBackendVerifier({storage,getContextReader:reader,getSettings:()=>settings,getLatestStatus:()=>status,setStatus:s=>status=s,refreshVisiblePanel:async()=>{},
   readCurrentPending:coordinator.readCurrentPending,updateBackendMeta:coordinator.updateBackendMeta,createDisplayStatus:coordinator.createDisplayStatus,prioritizeFullBackupStatus:coordinator.prioritizeFullBackupStatus,
   needsFullBackupConfirmation:coordinator.needsFullBackupConfirmation,confirmFullBackup:coordinator.confirmFullBackupAfterBackendVerification,ensurePendingBackups:coordinator.ensurePendingBackups,
   readBackend:async()=>({ok:true,chat:[{chat_metadata:{}},...structuredClone(disk)]}),retryDelays:[]});
  const handlers=new Map(),events=registerBackupEvents({eventSource:{on:(name,fn)=>handlers.set(name,fn),off(){}},eventTypes:{MESSAGE_DELETED:'message_deleted',MESSAGE_EDITED:'message_edited',MESSAGE_RECEIVED:'message_received'},debounceMs:100000,
   captureTrigger:coordinator.captureTrigger,onObserved:()=>{coordinator.noteSourceChange();verifier.clearScheduledVerification();},onBackupNeeded:coordinator.runBackupNow});
  try {
   await coordinator.runBackupNow({eventName:'extension-loaded',args:[]});
   current.chat.splice(2,2);handlers.get('message_deleted')(6);current.chat[0].extra.test='edit';handlers.get('message_edited')(0);current.chat.push({mes:'new',swipes:['new','other'],swipe_id:0});handlers.get('message_received')(6);
   await events.flush();const target=structuredClone(current.chat),pending=await read('pending_changes');
   assert(pending.filter(row=>row.pendingType==='operation').length===3,'连续操作没有独立捕获');checks.push(`full=${full}:event-time-order`);
   await verifier.verifyBackendNow({chatKey:key});assert((await read('pending_changes')).length===pending.length,'未落盘提前核销');checks.push(`full=${full}:old-file-retained`);
   current.chat=structuredClone(original);coordinator.resetObservation();const plan=createPendingRestorePlan({chat:current.chat,chatKey:key,pending});
   assert(!plan.blockedReason&&nativeChatHash(plan.targetChat)===nativeChatHash(target),plan.blockedReason||'目标错误');
   const result=await executeRestorePlan({plan,readCurrent:()=>current,readPending:()=>read('pending_changes'),writePending:rows=>use(s=>s.putPendingChanges(rows.map(row=>protectPendingRecord(row,settings,target.length)))),render:async()=>{},save:async()=>{disk=structuredClone(current.chat);}});
   assert(result.ok,result.reason);await coordinator.runBackupNow({eventName:'restore-complete',args:[]});await verifier.verifyBackendNow({chatKey:key});
   assert(!(await read('pending_changes')).length,'落盘后未安全核销');checks.push(`full=${full}:restore-save-reread-retire`);
   const intent=createRestoreJournal({chat:current.chat,targetChat:[{mes:'chosen'}],chatKey:key,pending:[]}).map(row=>protectPendingRecord(row,settings,1));
   await use(s=>s.putPendingChanges(intent));current.chat=[{mes:'chosen'}];disk=structuredClone(current.chat);await coordinator.runBackupNow({eventName:'restore-complete',args:[]});
   const rows=await read('pending_changes'),proof=comparePendingWithBackend(rows,disk,{recentLimit:2}),part=rows.find(row=>row.pendingType==='message_part');
   const removed=await use(s=>s.deletePendingChangesIfUnchanged([{...part,...proof.proofs.get(part.id)}]));assert(removed.includes(part.id),'部分清理未完成');
   const remaining=await read('pending_changes'),resave=createPendingRestorePlan({chat:current.chat,chatKey:key,pending:remaining});assert(!resave.blockedReason&&resave.canResave,'重启后无法识别部分已核销记录');
   await verifier.verifyBackendNow({chatKey:key});assert(!(await read('pending_changes')).length,'部分清理后未接续');checks.push(`full=${full}:partial-cleanup-resume`);
   // Original old-client bulk replacement must fail without changing rows.
   await use(s=>s.putPendingChanges(intent));let denied=false;try{await use(s=>s.replacePendingChanges({chatKey:key,records:[]}));}catch{denied=true;}
   assert(denied&&(await read('pending_changes')).length===intent.length,'旧客户端覆盖了日志');checks.push(`full=${full}:old-client-fence`);
   const newKey=key+'-renamed';await use(s=>s.migrateRenamedChatIdentity({source:{chatId:key},identity:{chatKey:newKey,meta:{chatType:'character',characterAvatar:'journal-browser.png',chatId:newKey}}}));
   const moved=await use(s=>s.getPendingChanges(newKey));assert(moved.length===intent.length&&new Set(moved.map(pendingRecordFingerprint)).size===moved.length,'重命名丢失记录');checks.push(`full=${full}:rename`);
  } finally {events.unregister();verifier.clearScheduledVerification();}
 }
 // Use production dialogs for desktop/mobile visual inspection.
 const chat=[{mes:'第一条'},{mes:'第二条'},{mes:'第三条'}],key='character:visual:test';
 const journal=createRestoreJournal({chat,targetChat:[chat[0],chat[2]],chatKey:key,pending:[]});
 const plan=createPendingRestorePlan({chat,chatKey:key,pending:journal});
 openRecoveryCenterDialog({state:{chatName:'隔离测试聊天',pendingPlan:plan,pendingCount:1,recentOptions:{endIndexes:[],startIndex:3},fullPlan:{},historicalChanges:[]},onPreviewPending:()=>{openRestoreDialog({plan,currentChat:chat,chatName:'隔离测试聊天',onConfirm:async()=>({ok:false,reason:'测试预览'})});return {ok:true};}});
 assert(!document.querySelector('.boxed-lllllabc-recovery-source button').disabled,'可恢复按钮错误禁用');checks.push('recovery-ui');
 return checks;
}
