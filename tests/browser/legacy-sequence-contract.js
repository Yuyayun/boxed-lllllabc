import {createIndexedDbStorage} from '../../src/storage/indexeddb-adapter.js';
import {createMessageRecord,createStructuralPendingRecord} from '../../src/backup/pending.js';
import {canonicalizeMessage} from '../../src/backup/canonicalize.js';
import {createRestoreController} from '../../src/controllers/restore-controller.js';
import {selectPendingRestoreBranch} from '../../src/backup/restore.js';
import {executeRestorePlan} from '../../src/backup/restore-executor.js';
import {writeBackupRecords,readBackupRecords} from '../../src/storage/backup-batches.js';
import {nativeChatHash} from '../../src/backup/native-content.js';
import {confirmedJournalRecords} from '../../src/backup/pending-journal.js';
import {openLegacyBranchDialog} from '../../src/ui/legacy-branch-dialog.js';
const assert=(value,message)=>{if(!value)throw new Error(message);};
const waitFor=async predicate=>{for(let n=0;n<150;n++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('UI did not finish');};
const choiceId='#boxed-lllllabc-legacy-branch-dialog';
export async function runLegacySequenceContract({adapter=createIndexedDbStorage(),mode='indexeddb'}={}){
 if(location.hostname!=='127.0.0.1')throw new Error('仅限隔离测试');
 const checks=[];
 const use=async callback=>{const session=await adapter.open();try{return await callback(session);}finally{session.close();}};
 const setup=async()=>{
  document.querySelectorAll('.boxed-lllllabc-dialog').forEach(node=>node.remove());
  const key='character:legacy-browser.png:'+crypto.randomUUID(),a='A B C D1 E1 F G'.split(' ').map(mes=>({mes,send_date:'date-'+mes})),b='A B C D2 E2 F G'.split(' ').map(mes=>({mes,send_date:'date-'+mes}));
  const pending=[a,b].map((chat,index)=>({...createStructuralPendingRecord({chatKey:key,chat,now:'2026-11-25T00:00:00.000Z'}),id:key+':branch-'+index}));
  const full=b.map((raw,messageIndex)=>({...canonicalizeMessage(raw,messageIndex),chatKey:key}));
  await use(async session=>{await session.putChatMeta({chatKey:key});await writeBackupRecords(session,{chatKey:key,store:'pending_changes',rows:pending});await session.putFullMessages({chatKey:key,messages:full});});
  const current={ok:true,chat:structuredClone(a),identity:{chatKey:key,meta:{chatType:'character',chatId:key,chatIntegrity:'fixture-integrity'}},context:{chatMetadata:{}}};
  let storageMode=mode;const storage={...adapter,getMode:()=>storageMode};
  const readPending=()=>use(session=>readBackupRecords(session,key,'pending_changes'));
  const controller=createRestoreController({storage,getContextReader:()=>({readCurrentChat:()=>current}),getSettings:()=>({enabled:true}),readCurrentPending:readPending,setStatus:()=>{}});
  const ui=controller.createRestoreUiState({current,messages:[],fullMessages:full,historicalChanges:[],pending,meta:{}});
  assert(ui.pendingPlan.selectionRequired&&ui.pendingPlan.branchChoices.length===2,'完整副本未参与旧数据分支判断');
  return {key,a,b,pending,full,current,readPending,controller,ui,setMode:next=>{storageMode=next;}};
 };
 for(const branch of [0,1]){
  const f=await setup(),snapshot=JSON.stringify(await f.readPending());f.ui.onPreviewPending();
  const dialog=document.querySelector(choiceId);assert(dialog,'没有分支选择界面');
  const radios=dialog.querySelectorAll('input[type=radio]');radios[branch].click();dialog.querySelector('footer button:last-child').click();
  await waitFor(()=>!document.querySelector(choiceId)&&document.querySelector('#boxed-lllllabc-restore-dialog'));
  assert(JSON.stringify(await f.readPending())===snapshot,'选择或预览提前改写了保护记录');
  const plan=selectPendingRestoreBranch(f.ui.pendingPlan,f.ui.pendingPlan.branchChoices[branch].id),expected=structuredClone(plan.targetChat);
  const result=await executeRestorePlan({plan,readCurrent:async()=>f.current,readPending:f.readPending,
   writePending:rows=>use(session=>writeBackupRecords(session,{chatKey:f.key,store:'pending_changes',rows})),render:async()=>{},save:async()=>({status:'completed'})});
  assert(result.ok&&nativeChatHash(f.current.chat)===nativeChatHash(expected),'未只恢复所选分支');
  const remaining=await f.readPending(),proof=confirmedJournalRecords(remaining,f.key,f.current.chat);
  assert(f.pending.every(row=>remaining.some(saved=>saved.id===row.id)),'保存确认前提前删除旧记录');
  assert(f.pending.every(row=>proof.ids.includes(row.id)),'恢复意图不能证明所选分支对应的旧记录');
  checks.push('choose-'+branch+':guarded-real-storage');
 }
 {
  const f=await setup(),snapshot=JSON.stringify(await f.readPending());f.ui.onPreviewPending();document.querySelector(choiceId+' footer button').click();
  assert(!document.querySelector(choiceId)&&!document.querySelector('#boxed-lllllabc-restore-dialog'),'取消仍打开恢复');assert(JSON.stringify(await f.readPending())===snapshot,'取消改写记录');checks.push('cancel');
 }
 for(const change of ['chat','pending','integrity','storage']){
  const f=await setup();f.ui.onPreviewPending();
  if(change==='chat')f.current.chat.push({mes:'changed'});
  else if(change==='integrity')f.current.identity.meta.chatIntegrity='different-file';
  else if(change==='storage')f.setMode('different-storage');
  else await use(session=>writeBackupRecords(session,{chatKey:f.key,store:'pending_changes',rows:[createMessageRecord({chatKey:f.key,messageIndex:0,kind:'message_edit',message:{mes:'new pending'}})]}));
  const dialog=document.querySelector(choiceId);dialog.querySelector('input').click();dialog.querySelector('footer button:last-child').click();
  await waitFor(()=>!dialog.querySelector('[role=alert]').hidden);
  assert(!document.querySelector('#boxed-lllllabc-restore-dialog'),'来源变化后仍打开预览');checks.push('stale-'+change);
 }
 {
  const f=await setup(),snapshot=JSON.stringify(await f.readPending()),selected=selectPendingRestoreBranch(f.ui.pendingPlan,f.ui.pendingPlan.branchChoices[1].id);
  const changed=structuredClone(f.full);changed[3].raw.mes='changed backup';
  await use(session=>session.putFullMessages({chatKey:f.key,messages:changed}));
  const result=await f.controller.confirmRestore(selected);
  assert(!result.ok&&nativeChatHash(f.current.chat)===nativeChatHash(f.a),'备份来源变化后仍应用恢复');
  assert(JSON.stringify(await f.readPending())===snapshot,'来源变化却写入或删除保护记录');checks.push('stale-evidence-before-apply');
 }
 {
  const f=await setup(),summary=await use(session=>session.getBackupSummary(f.key)),ui=f.controller.createRestoreUiState({current:f.current,messages:[],fullMessages:[],historicalChanges:[],pending:[],meta:{},summary});
  await ui.onPreviewPending();assert(document.querySelector(choiceId),'分批读取入口没有加载完整旧数据证据');checks.push('bounded-evidence');
 }
 {
  const f=await setup(),base=f.a.slice(0,3),target=[...base,{mes:'continued G'},{mes:'continued H'},{mes:'continued I'}];
  const pending=[createStructuralPendingRecord({chatKey:f.key,chat:base,now:'2026-11-25T00:00:00.000Z'}),createMessageRecord({chatKey:f.key,messageIndex:3,kind:'new_message',message:target[3],now:'2026-11-25T00:01:00.000Z'})];
  const recent=target.slice(2).map((raw,index)=>({...canonicalizeMessage(raw,index+2,'2026-11-25T00:02:00.000Z'),chatKey:f.key}));
  const ui=f.controller.createRestoreUiState({current:f.current,messages:recent,fullMessages:[],historicalChanges:[],pending,meta:{}});
  assert(!ui.pendingPlan.blockedReason&&nativeChatHash(ui.pendingPlan.targetChat)===nativeChatHash(target),'遗漏仅留在最近备份中的后续聊天');checks.push('recent-continuation');
 }
 {
  const f=await setup();let continueRead,finished=false;
  const dialog=openLegacyBranchDialog({plan:f.ui.pendingPlan,onSelect:async(_id,active)=>{await new Promise(resolve=>{continueRead=resolve;});finished=active();return {ok:active()};}});
  dialog.querySelector('input').click();dialog.querySelector('footer button:last-child').click();dialog.querySelector('header button').click();continueRead();
  await new Promise(resolve=>setTimeout(resolve,0));assert(!finished&&!document.querySelector(choiceId),'取消后的异步选择仍继续');checks.push('cancel-during-read');
 }
 // Leave an actual production dialog available for bounded visual inspection.
 const visual=await setup();visual.ui.onPreviewPending();const dialog=document.querySelector(choiceId);dialog.querySelector('section details').open=true;
 await waitFor(()=>dialog.querySelectorAll('section details details').length>0);
 const frame=dialog.querySelector('.boxed-lllllabc-dialog-frame'),body=dialog.querySelector('.boxed-lllllabc-restore-body');
 assert(frame.getBoundingClientRect().width<=innerWidth&&body.scrollWidth<=body.clientWidth+2,'选择界面横向溢出');
 checks.push('branch-ui');
 return checks;
}
