import {createIndexedDbStorage} from '../../src/storage/indexeddb-adapter.js';
import {createRestoreController} from '../../src/controllers/restore-controller.js';
import {createBackendVerifier} from '../../src/controllers/backend-verifier.js';
import {createRecoveryLogRecorder} from '../../src/storage/recovery-log.js';
import {readBackupRecords} from '../../src/storage/backup-batches.js';
import {canonicalizeMessage} from '../../src/backup/canonicalize.js';

export async function runRecoveryLogContract({adapter=createIndexedDbStorage(),mode='indexeddb'}={}){
 const assert=(value,message)=>{if(!value)throw new Error(message);},checks=[];
 const use=async fn=>{const session=await adapter.open();try{return await fn(session);}finally{session.close();}};
 for(const savedMatches of [true,false]){
  const key='character:private-log.png:'+crypto.randomUUID(),events=[],target=[{mes:'SECRET_LOG_BODY one'},{mes:'SECRET_LOG_BODY two'}],settings={enabled:true,recentBackupEnabled:true,recentLimit:20,fullBackupEnabled:false,historicalBackupEnabled:false,backendVerifyDelayMs:0};
  const current={ok:true,chat:[{mes:'old'}],identity:{chatKey:key,meta:{chatType:'character',characterAvatar:'private-log.png',chatId:key}},context:{chatMetadata:{},clearChat:async()=>{},printMessages:async()=>{},saveChat:async()=>{}}};
  const full=target.map((raw,messageIndex)=>({...canonicalizeMessage(raw,messageIndex),chatKey:key}));
  await use(async s=>{await s.putChatMeta({chatKey:key});await s.putFullMessages({chatKey:key,messages:full});});
  const log=createRecoveryLogRecorder({getStorageMode:()=>mode,send:async event=>{events.push(event);if(mode==='sqlite')await adapter.recordRecoveryEvent(event);}});
  const readPending=()=>use(s=>readBackupRecords(s,key,'pending_changes'));
  let latest={};const display=(code,shortText,detail)=>({code,shortText,detail});
  const controller=createRestoreController({storage:adapter,eventTypes:{},getContextReader:()=>({readCurrentChat:()=>current}),getSettings:()=>settings,readCurrentPending:readPending,setStatus:s=>{latest=s;},createDisplayStatus:display,
   scheduleBackendVerification:()=>{},refreshVisiblePanel:async()=>{},refreshFullBackup:async()=>null,refreshHistoricalBackup:async()=>null,recordRecovery:log.record});
  const state=controller.createRestoreUiState({current,messages:[],fullMessages:full,historicalChanges:[],pending:[],meta:{}});
  const restored=await controller.confirmRestore(state.fullPlan);assert(restored.ok,'恢复未提交保存：'+JSON.stringify({reason:restored.reason,stage:restored.stage,error:restored.error?.message}));await log.idle();assert(events.length===2&&events.every(event=>event.stage!=='restore-confirmed'),'保存返回就错误宣称核对完成');
  const roots=await readPending(),root=roots.find(row=>row.pendingType==='operation');assert(root&&events.every(event=>event.recoveryId===root.operationId),'未沿用实际恢复操作编号');
  const verifier=createBackendVerifier({storage:adapter,getContextReader:()=>({readCurrentChat:()=>current}),getSettings:()=>settings,getLatestStatus:()=>latest,setStatus:s=>{latest=s;},refreshVisiblePanel:async()=>{},
   prioritizeFullBackupStatus:async(_key,status)=>status,readCurrentPending:readPending,updateBackendMeta:async()=>{},createDisplayStatus:display,retryDelays:[],recordRecovery:log.record,
   readBackend:async()=>({ok:true,chat:[{chat_metadata:{}},...(savedMatches?structuredClone(target):[{mes:'different native file'}])]})});
  try{await verifier.verifyBackendNow({chatKey:key});await log.idle();}finally{verifier.clearScheduledVerification();}
  if(savedMatches){
   assert((await readPending()).length===0,'已核对记录没有条件核销');assert(events.length===3&&events[2].stage==='restore-confirmed','缺少实际核对完成节点');
   if(mode==='sqlite'){const rows=(await adapter.readLogs({category:'all',limit:100})).entries.filter(row=>row.recoveryId===root.operationId);assert(rows.length===3,'服务端恢复记录条数异常');assert(rows.every(row=>row.chatRef===events[0].chatRef),'聊天关联不一致');}
  }else{assert((await readPending()).length>0,'原生文件不符却核销');assert(events.length===2,'未确认的恢复被记录成已完成');}
  assert(!JSON.stringify(events).includes('SECRET_LOG_BODY')&&!JSON.stringify(events).includes(key),'日志泄露正文或聊天文件标识');checks.push(savedMatches?'three-linked-key-events':'unconfirmed-preserves-pending-and-no-completed-log');
 }
 return checks;
}
