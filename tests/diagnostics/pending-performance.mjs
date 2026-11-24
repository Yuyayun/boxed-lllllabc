import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {createPendingObserver} from '../../src/backup/pending-journal.js';
import {createPendingRestorePlan} from '../../src/backup/restore.js';
import {nativeChatHash,warmNativeChat} from '../../src/backup/native-content.js';

for(const length of [3000,10000]) {
 const payload='synthetic '.repeat(300),chat=Array.from({length},(_,i)=>({mes:`${i} ${payload}`,swipes:[`${i} ${payload}`],swipe_id:0,extra:{fixture:true}}));
 for(const [label,start,count] of [['middle-one',Math.floor(length/2),1],['middle-many',Math.floor(length/2),3],['tail-many',length-3,3]]) {
  const current={ok:true,chat:structuredClone(chat),identity:{chatKey:'character:perf.png:'+label,meta:{}}};
  const observer=createPendingObserver({readCurrent:()=>current,deferHashes:true});let time=performance.now();observer.reset();const resetMs=performance.now()-time;
  current.chat.splice(start,count);time=performance.now();const deletion=observer.capture({eventName:'message_deleted',args:[current.chat.length]});const captureMs=performance.now()-time;await deletion.ready;const deletionReadyMs=performance.now()-time;
  const deletionBytes=Buffer.byteLength(JSON.stringify(deletion.records));assert(deletionBytes<10000,'普通删除复制了整个聊天');
  current.chat[0].mes='edited';const edit=observer.capture({eventName:'message_edited',args:[0]});current.chat.push({mes:'new after deletion'});const append=observer.capture({eventName:'message_received',args:[current.chat.length-1]});await Promise.all([edit.ready,append.ready]);
  const pending=[...deletion.records,...edit.records,...append.records];await warmNativeChat(chat);time=performance.now();const plan=createPendingRestorePlan({chat,chatKey:current.identity.chatKey,pending});const previewMs=performance.now()-time;
  assert.equal(plan.blockedReason,'');assert.equal(nativeChatHash(plan.targetChat),nativeChatHash(current.chat));
  console.log(JSON.stringify({length,label,sourceBytes:Buffer.byteLength(JSON.stringify(chat)),deletionBytes,resetMs:Math.round(resetMs),captureMs:Math.round(captureMs),deletionReadyMs:Math.round(deletionReadyMs),previewMs:Math.round(previewMs),targetLength:plan.targetChat.length}));
 }
}
