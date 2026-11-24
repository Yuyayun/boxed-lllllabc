import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageRecord,createStructuralPendingRecord } from '../src/backup/pending.js';
import { canonicalizeMessage } from '../src/backup/canonicalize.js';
import { createPendingRestorePlan } from '../src/backup/restore.js';
import { createPendingObserver } from '../src/backup/pending-journal.js';
const chatKey='character:fixture.png:legacy';
const old='2026-11-23T08:00:00.000Z',later='2026-11-23T08:00:01.000Z';
const message=n=>({mes:`测试消息 ${n}`,send_date:`date-${n}`,is_user:Boolean(n%2)});
function fixture(){
  const target=Array.from({length:83},(_,i)=>message(i)),chat=structuredClone(target.slice(0,53));
  const pending=target.slice(27).map((raw,index)=>createMessageRecord({chatKey,messageIndex:index+27,kind:'new_message',message:raw,now:old}));
  pending.push(createStructuralPendingRecord({chatKey,kind:'message_delete',chat:target,now:later}));
  return {target,chat,pending,recent:chat.slice(33).map((raw,index)=>({...canonicalizeMessage(raw,index+33),chatKey}))};
}
test('53 native / 20 recent / 57 old pending uniquely reconstruct all 83 messages without mutating records',()=>{
  const f=fixture(),before=structuredClone(f.pending);
  const plan=createPendingRestorePlan({...f,chatKey});
  assert.equal(f.pending.length,57);assert.equal(f.recent.length,20);
  assert.equal(plan.blockedReason,'');assert.deepEqual(plan.targetChat,f.target);assert.deepEqual(f.pending,before);
});
test('insufficient 57-record variant is blocked with every original record intact',()=>{
  const f=fixture();delete f.pending.find(row=>row.messageIndex===53).message.raw;
  const before=structuredClone(f.pending),plan=createPendingRestorePlan({...f,chatKey});
  assert(plan.blockedReason);assert.deepEqual(f.pending,before);assert.equal(f.pending.length,57);
});
test('full and historical copies can provide missing legacy message bodies',()=>{
  for(const store of ['full','historical']){
    const f=fixture();delete f.pending.find(row=>row.messageIndex===53).message.raw;
    f[store]=store==='full'?f.target.map((raw,index)=>({...canonicalizeMessage(raw,index),chatKey})):[{chatKey,messageIndex:53,message:canonicalizeMessage(f.target[53],53)}];
    const plan=createPendingRestorePlan({...f,chatKey});assert.equal(plan.blockedReason,'');assert.deepEqual(plan.targetChat,f.target);
  }
});
test('legacy hash mismatch, missing hash, foreign identity and indistinguishable native fields are rejected',()=>{
  const f=fixture();f.pending.at(-1).canonicalChatHash='00000000';assert(createPendingRestorePlan({...f,chatKey}).blockedReason);
  delete f.pending.at(-1).canonicalChatHash;assert(createPendingRestorePlan({...f,chatKey}).blockedReason);
  const second=fixture();second.pending[0].chatKey='another';assert(createPendingRestorePlan({...second,chatKey}).blockedReason);
  const third=fixture();third.chat[27].original_avatar='one.png';third.pending[0].message.raw.original_avatar='two.png';
  assert.match(createPendingRestorePlan({...third,chatKey}).blockedReason,/多个/);
});
test('new ordered deletion can follow a fully reconstructable old numeric baseline',()=>{
  const chat=[message(0)],pending=[createMessageRecord({chatKey,messageIndex:1,kind:'new_message',message:message(1),now:old})];
  const current={ok:true,chat:[message(0),message(1)],identity:{chatKey,meta:{}}};
  const observer=createPendingObserver({readCurrent:()=>current,now:()=>later});observer.reset();current.chat.pop();
  pending.push(...observer.capture({eventName:'message_deleted',args:[1]}).records);
  const plan=createPendingRestorePlan({chat,chatKey,pending});assert.equal(plan.blockedReason,'');assert.deepEqual(plan.targetChat,chat);
});
