import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBackupCoordinator } from '../../src/controllers/backup-coordinator.js';
import { createBackendVerifier } from '../../src/controllers/backend-verifier.js';
import { registerBackupEvents } from '../../src/events.js';
import { createPendingRestorePlan } from '../../src/backup/restore.js';
import { comparePendingWithBackend } from '../../src/verifier/compare.js';
import { nativeChatHash } from '../../src/backup/native-content.js';
import { rekeyBackupRecord } from '../../src/db/identity-reconciliation.js';
import { createMessageRecord,createStructuralPendingRecord } from '../../src/backup/pending.js';
import {createRestoreJournal,pendingRecordFingerprint} from '../../src/backup/pending-journal.js';
import {protectPendingRecord} from '../../src/backup/pending-protection.js';
const serverRoot=process.env.BOXED_SERVER_ROOT??path.resolve('.local-test/boxed-lllllabc-server-dev');
const {SqliteRepository}=await import(pathToFileURL(path.join(serverRoot,'src/sqlite.js')).href);
const chatKey='character:journal-test.png:chat-a';
async function fixture({length=5,full=true}={}) {
  const repo=new SqliteRepository(':memory:');let queue=Promise.resolve(),status={},backend;
  const current={ok:true,chat:Array.from({length},(_,i)=>({mes:`message ${i}`,send_date:`date ${i}`})),identity:{chatKey,meta:{chatType:'character',characterAvatar:'journal-test.png',chatId:'chat-a'}}};
  backend=structuredClone(current.chat);
  const settings={enabled:true,fullBackupEnabled:full,recentBackupEnabled:true,historicalBackupEnabled:true,recentLimit:2,backendVerifyDelayMs:0};
  const call=(method,...args)=>{const run=queue.then(()=>repo.execute(method,args));queue=run.catch(()=>{});return run;};
  const session=new Proxy({capabilities:{boundedBackup:1,pendingJournal:1},close(){}},{get:(o,k)=>k==='then'?undefined:o[k]??((...args)=>call(k,...args))});
  const storage={open:async()=>session},getContextReader=()=>({readCurrentChat:()=>current});
  let verifier;
  const coordinator=createBackupCoordinator({storage,getContextReader,getSettings:()=>settings,getLatestStatus:()=>status,setStatus:s=>{status=s;},refreshVisiblePanel:async()=>{},
    prepareBackup:async()=>{verifier?.clearScheduledVerification();await verifier?.whenIdle();},clearScheduledVerification(){},scheduleBackendVerification(){},scheduleBackendSnapshotVerification(){},readChatCatalog:async()=>({ok:true,entries:[]})});
  verifier=createBackendVerifier({storage,getContextReader,getSettings:()=>settings,getLatestStatus:()=>status,setStatus:s=>{status=s;},refreshVisiblePanel:async()=>{},
    readCurrentPending:coordinator.readCurrentPending,updateBackendMeta:coordinator.updateBackendMeta,createDisplayStatus:coordinator.createDisplayStatus,
    prioritizeFullBackupStatus:coordinator.prioritizeFullBackupStatus,needsFullBackupConfirmation:coordinator.needsFullBackupConfirmation,
    confirmFullBackup:coordinator.confirmFullBackupAfterBackendVerification,ensurePendingBackups:coordinator.ensurePendingBackups,readBackend:async()=>({ok:true,chat:[{chat_metadata:{}},...structuredClone(backend)]}),retryDelays:[]});
  const handlers=new Map(),events=registerBackupEvents({eventSource:{on:(name,fn)=>handlers.set(name,fn),off(){}},eventTypes:{MESSAGE_DELETED:'message_deleted',MESSAGE_EDITED:'message_edited',MESSAGE_RECEIVED:'message_received',CHAT_CHANGED:'chat_id_changed'},debounceMs:100000,
    captureTrigger:coordinator.captureTrigger,onObserved:()=>{coordinator.noteSourceChange();verifier.clearScheduledVerification();},onBackupNeeded:coordinator.runBackupNow});
  await coordinator.runBackupNow({eventName:'extension-loaded',args:[]});
  return {current,settings,coordinator,call,session,emit:(name,...args)=>handlers.get(name)(...args),flush:()=>events.flush(),pending:()=>call('getPendingChanges',current.identity.chatKey),
    verify:()=>verifier.verifyBackendNow({chatKey:current.identity.chatKey}),save(){backend=structuredClone(current.chat);},get status(){return status;},
    async close(){events.unregister();verifier.clearScheduledVerification();await queue;repo.close();}};
}
for(const full of [false,true])test(`SQLite real journal captures delete/edit/append and clears only after actual file and backups agree (full=${full})`,async()=>{
  const f=await fixture({full});try {
    const base=structuredClone(f.current.chat);f.current.chat.splice(1,2);f.emit('message_deleted',3);
    f.current.chat[0].mes='edited';f.emit('message_edited',0);f.current.chat.push({mes:'new message'});f.emit('message_received',3);
    await f.flush();let pending=await f.pending();assert.equal(pending.filter(row=>row.pendingType==='operation').length,3);
    const plan=createPendingRestorePlan({chat:base,chatKey,pending});assert.equal(plan.blockedReason,'');assert.deepEqual(plan.targetChat,f.current.chat);
    await f.verify();assert.equal((await f.pending()).length,pending.length);
    f.save();await f.verify();assert.equal((await f.pending()).length,0);assert.equal(f.status.code,'saved');
    if(full)assert.equal((await f.call('getChatMeta',chatKey)).fullBackupNativeHash,nativeChatHash(f.current.chat));
    assert.equal((await f.call('getHistoricalChanges',chatKey)).find(row=>row.messageIndex===0).message.raw.mes,'edited');
  }finally{await f.close();}
});
test('SQLite empty target is protected and verified after deleting every message',async()=>{
  const f=await fixture();try{f.current.chat.length=0;f.emit('message_deleted',0);await f.flush();assert((await f.pending()).length);f.save();await f.verify();assert.equal((await f.pending()).length,0);}finally{await f.close();}
});
test('captured chat A edits remain under A after immediately switching to B',async()=>{
  const f=await fixture({full:false});try{
    f.current.chat[0].mes='A only';f.emit('message_edited',0);
    f.current.chat=[{mes:'B'}];f.current.identity={chatKey:'character:journal-test.png:B',meta:{chatType:'character',characterAvatar:'journal-test.png',chatId:'B'}};f.emit('chat_id_changed','B');
    await f.flush();const a=await f.call('getPendingChanges',chatKey),b=await f.pending();assert(a.some(row=>row.raw?.mes==='A only'));assert.equal(b.length,0);
  }finally{await f.close();}
});
test('stale native reload cannot clear a delete by matching the current page',async()=>{
  const f=await fixture();try{
    const before=structuredClone(f.current.chat);f.current.chat.splice(1,2);f.emit('message_deleted',3);await f.flush();
    f.current.chat=before;await f.coordinator.runBackupNow({eventName:'chat_loaded',args:[]});
    await f.verify();assert((await f.pending()).some(row=>row.kind==='message_delete'));assert.notEqual(f.status.code,'saved');
  }finally{await f.close();}
});
test('real conditional deletion checks changed operation fields and refuses an old-client proof',async()=>{
  const f=await fixture();try{
    f.current.chat.pop();f.emit('message_deleted',4);await f.flush();f.save();
    const captured=(await f.pending())[0],comparison=comparePendingWithBackend([captured],f.current.chat,{recentLimit:2});
    assert.deepEqual(await f.call('deletePendingChangesIfUnchanged',[captured]),[]);
    const expected={...captured,...comparison.proofs.get(captured.id)};
    await f.call('putPendingChanges',[{...captured,sequence:captured.sequence+1}]);
    assert.deepEqual(await f.call('deletePendingChangesIfUnchanged',[expected]),[]);assert.equal((await f.pending()).length,1);
  }finally{await f.close();}
});
test('Rename keeps independent journal IDs and part references usable',async()=>{
  const f=await fixture({full:false});try{
    const before=structuredClone(f.current.chat);f.current.chat.pop();f.emit('message_deleted',4);f.current.chat[0].mes='changed';f.emit('message_edited',0);await f.flush();
    const old=await f.pending(),targetKey='character:journal-test.png:renamed';
    await f.call('migrateRenamedChatIdentity',{source:{chatId:'chat-a'},identity:{chatKey:targetKey,meta:{chatType:'character',characterAvatar:'journal-test.png',chatId:'renamed'}}});
    const moved=await f.call('getPendingChanges',targetKey);assert.equal(moved.length,old.length);assert.equal(new Set(moved.map(row=>row.id)).size,old.length);
    const plan=createPendingRestorePlan({chat:before,chatKey:targetKey,pending:moved});assert.equal(plan.blockedReason,'');assert.deepEqual(plan.targetChat,f.current.chat);
    assert.equal(new Set(old.map(row=>rekeyBackupRecord(row,targetKey,'pending').id)).size,old.length);
  }finally{await f.close();}
});

for(const full of [false,true])test(`explicit restore retires superseded legacy records only after replacement is saved (full=${full})`,async()=>{
 const f=await fixture({full});try{
  const original=createMessageRecord({chatKey,messageIndex:0,kind:'message_edit',message:{mes:'discarded pending'}});
  await f.call('putPendingChanges',[protectPendingRecord(original,f.settings,5)]);
  const old=await f.pending(),target=[{mes:'chosen restore target'}];
  const intent=createRestoreJournal({chat:f.current.chat,targetChat:target,chatKey,pending:old}).map(row=>protectPendingRecord(row,f.settings,1));
  await f.call('putPendingChanges',intent);f.current.chat.splice(0,5,...target);await f.coordinator.runBackupNow({eventName:'restore-complete',args:[]});
  await f.verify();assert((await f.pending()).length,'not yet saved must remain');
  f.save();await f.verify();assert.equal((await f.pending()).length,0);
 }finally{await f.close();}
});

test('partial cleanup survives restart and Rename recomputes valid supersedes fingerprints',async()=>{
 const f=await fixture({full:false});try{
  f.current.chat[0].mes='older operation';f.emit('message_edited',0);await f.flush();const old=await f.pending();
  const target=[{mes:'chosen'}],intent=createRestoreJournal({chat:f.current.chat,targetChat:target,chatKey,pending:old}).map(row=>protectPendingRecord(row,f.settings,1));await f.call('putPendingChanges',intent);
  const newKey='character:journal-test.png:partial-rename';
  await f.call('migrateRenamedChatIdentity',{source:{chatId:'chat-a'},identity:{chatKey:newKey,meta:{chatType:'character',characterAvatar:'journal-test.png',chatId:'partial-rename'}}});
  const moved=await f.call('getPendingChanges',newKey),root=moved.find(row=>row.kind==='restore'&&row.pendingType==='operation');
  for(const ref of root.supersedes)assert.equal(ref.fingerprint,pendingRecordFingerprint(moved.find(row=>row.id===ref.id)));
  const current=structuredClone(target),proof=comparePendingWithBackend(moved,current,{recentLimit:2});
  const expected=moved.map(row=>({...row,...proof.proofs.get(row.id)}));
  // No backup copy yet: even valid native proof is insufficient.
  assert.deepEqual(await f.call('deletePendingChangesIfUnchanged',expected),[]);
  f.current.identity={chatKey:newKey,meta:{chatType:'character',characterAvatar:'journal-test.png',chatId:'partial-rename'}};f.current.chat.splice(0,5,...target);
  await f.coordinator.runBackupNow({eventName:'restore-complete',args:[]});f.save();
  // Simulate cancellation between small cleanup pages.
  const part=expected.find(row=>row.kind==='restore'&&row.pendingType==='message_part');
  assert.deepEqual(await f.call('deletePendingChangesIfUnchanged',[part]),[part.id]);
  const remaining=await f.pending(),plan=createPendingRestorePlan({chat:current,chatKey:newKey,pending:remaining});assert.equal(plan.blockedReason,'');assert(plan.canResave);
  await f.verify();assert.equal((await f.pending()).length,0);
 }finally{await f.close();}
});

test('old whole-pending replacement cannot overwrite journal records',async()=>{
 const f=await fixture();try{f.current.chat.pop();f.emit('message_deleted',4);await f.flush();const before=await f.pending();
  await assert.rejects(f.call('replacePendingChanges',{chatKey,records:[]}),/更新|保护|journal/i);assert.deepEqual(await f.pending(),before);
 }finally{await f.close();}
});

test('legacy edited message shifts after a new deletion without orphaning its protection or losing history',async()=>{
 const f=await fixture({full:false});try{
  const raw={mes:'legacy edited body'};f.current.chat[1]=raw;
  const legacy={...createMessageRecord({chatKey,messageIndex:1,kind:'message_edit',message:raw}),createdAt:'2000-01-01',updatedAt:'2000-01-01'};
  await f.call('putPendingChanges',[protectPendingRecord(legacy,f.settings,5)]);f.coordinator.resetObservation();
  f.current.chat.splice(0,1);f.emit('message_deleted',4);await f.flush();f.save();await f.verify();
  assert.equal((await f.pending()).length,0);assert.equal((await f.call('getHistoricalChanges',chatKey)).find(row=>row.messageIndex===0)?.message.raw.mes,raw.mes);
 }finally{await f.close();}
});
