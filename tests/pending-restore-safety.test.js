import test from 'node:test';
import assert from 'node:assert/strict';
import {createPendingRestorePlan,createFullRestorePlan} from '../src/backup/restore.js';
import {createMessageRecord} from '../src/backup/pending.js';
import {canonicalizeMessage} from '../src/backup/canonicalize.js';
import {executeRestorePlan} from '../src/backup/restore-executor.js';
import {saveNativeChatSnapshot} from '../src/backup/native-save.js';
import {createPendingObserver,confirmedJournalRecords,newOperationId} from '../src/backup/pending-journal.js';
import {nativeMessageText,sha256Text,warmNativeChat} from '../src/backup/native-content.js';
import {comparePendingWithBackend} from '../src/verifier/compare.js';
import {renderRestoredMessages} from '../src/controllers/restore-controller.js';
const chatKey='character:test.png:chat-a';
const pending=()=>[createMessageRecord({chatKey,messageIndex:0,kind:'message_edit',message:{mes:'restore'}})];
function fixture(){
 const chat=[{mes:'base'}],rows=pending();let active={ok:true,chat,identity:{chatKey,meta:{chatType:'character',characterAvatar:'test.png',chatId:'chat-a',characterName:'测试角色'}},context:{chatMetadata:{integrity:'audit-uuid'},getRequestHeaders:()=>({'X-CSRF-Token':'test'})}};
 const plan=createPendingRestorePlan({chat,chatKey,pending:rows});
 const original=structuredClone(rows),written=[],saves=[];
 const args={plan,readCurrent:()=>active,readPending:async()=>rows,writePending:async added=>{written.push(...added);rows.push(...added);},render:async()=>{},save:async()=>{saves.push(active.identity.chatKey);}};
 return {chat,rows,args,written,saves,original,switch(){active={...active,identity:{chatKey:'B'},chat:[{mes:'B'}]};}};
}
test('pending changes between first read and apply invalidate the preview without touching chat',async()=>{
 const f=fixture();f.args.beforeApply=()=>{f.rows[0].updatedAt='new';};const result=await executeRestorePlan(f.args);
 assert.equal(result.ok,false);assert.equal(f.chat[0].mes,'base');assert.equal(f.saves.length,0);assert.equal(f.written.length,0);
});
test('switching during render stops save and keeps every original protection record',async()=>{
 const f=fixture();f.args.render=async()=>f.switch();const result=await executeRestorePlan(f.args);
 assert.equal(result.changed,true);assert.equal(result.stage,'save');assert.equal(f.saves.length,0);assert.deepEqual(f.rows[0],f.original[0]);assert(f.written.length);
});
test('an unrelated concurrent pending write during render stops save',async()=>{
 const f=fixture();f.args.render=async()=>{f.rows.push(createMessageRecord({chatKey,messageIndex:1,kind:'new_message',message:{mes:'concurrent'}}));};
 const result=await executeRestorePlan(f.args);assert.equal(result.stage,'save');assert.equal(f.saves.length,0);assert.equal(f.rows.at(-1).message.raw.mes,'concurrent');
});
test('full restore save failure retains originals and additive recovery payload',async()=>{
 const f=fixture();f.args.plan=createFullRestorePlan({chat:f.chat,chatKey,fullMessages:[canonicalizeMessage({mes:'full'},0)],pending:f.rows});
 f.args.save=async()=>{throw new Error('simulated native failure');};const result=await executeRestorePlan(f.args);
 assert.equal(result.stage,'save');assert.equal(f.chat[0].mes,'full');assert.deepEqual(f.rows[0],f.original[0]);assert(f.rows.some(row=>row.raw?.mes==='full'));
});
test('native save binds identity, metadata and body before asynchronous preparation',async()=>{
 const f=fixture();const current=f.args.readCurrent();let request;
 await saveNativeChatSnapshot({current,prepareRequest:async init=>{current.chat[0].mes='changed later';current.context.chatMetadata.integrity='changed later';return init;},fetchImpl:async(url,init)=>{request={url,body:JSON.parse(init.body)};return {ok:true};}});
 assert.equal(request.url,'/api/chats/save');assert.equal(request.body.file_name,'chat-a');assert.equal(request.body.avatar_url,'test.png');
 assert.equal(request.body.chat[1].mes,'base');assert.equal(request.body.chat[0].chat_metadata.integrity,'audit-uuid');assert.equal(request.body.force,false);
});
test('native save cancels before fetch after source switch and never forces integrity failures',async()=>{
 const f=fixture();let called=false,allowed=true;
 await assert.rejects(saveNativeChatSnapshot({current:f.args.readCurrent(),prepareRequest:async init=>{allowed=false;return init;},shouldContinue:()=>allowed,fetchImpl:async()=>{called=true;}}),/已经变化/);assert.equal(called,false);
 await assert.rejects(saveNativeChatSnapshot({current:f.args.readCurrent(),fetchImpl:async()=>({ok:false,status:400,json:async()=>({error:'integrity'})})}),/身份校验/);
});
test('deferred hashing keeps event-time snapshots immutable through later mutation and switch',async()=>{
 const current={ok:true,identity:{chatKey,meta:{}},chat:[{mes:'A'},{mes:'B'}]},watcher=createPendingObserver({readCurrent:()=>current,deferHashes:true});watcher.reset();current.chat.pop();
 const captured=watcher.capture({eventName:'message_deleted',args:[1]});current.chat[0].mes='later';current.identity={chatKey:'B',meta:{}};
 await captured.ready;assert.equal(captured.chatKey,chatKey);assert.equal(captured.records.at(-1).afterLength,1);
 const proof=confirmedJournalRecords(captured.records,chatKey,[{mes:'A'}]);assert.equal(proof.ids.length,1);
});
test('native JSON handles shared references, rejects cycles, and warmed hashes detect mutation',async()=>{
 const shared={x:1};assert.equal(nativeMessageText({a:shared,b:shared}),'\u007b"a":{"x":1},"b":{"x":1}\u007d');
 const circular={};circular.self=circular;assert.throws(()=>nativeMessageText(circular),/circular/i);
 const message={mes:'before'};await warmNativeChat([message]);const before=sha256Text(nativeMessageText(message));message.mes='after';assert.notEqual(sha256Text(nativeMessageText(message)),before);
 assert.match(newOperationId(),/^[a-f0-9-]{36}$/);
});

test('an observation gap cannot be replayed but exact native persistence can confirm it',()=>{
 const current={ok:true,chat:[{mes:'new state'}],identity:{chatKey,meta:{}}},observer=createPendingObserver({readCurrent:()=>current});
 const records=observer.capture({eventName:'message_deleted',args:[1]}).records;
 assert.equal(records[0].pendingType,'observation_gap');assert(createPendingRestorePlan({chat:[{mes:'old'}],chatKey,pending:records}).blockedReason);
 assert.equal(comparePendingWithBackend(records,[{mes:'old'}]).confirmedIds.length,0);
 assert.deepEqual(comparePendingWithBackend(records,current.chat).confirmedIds,[records[0].id]);
});

test('native redraw empty extra initialization preserves exact protected JSON without discarding real fields',async()=>{
 const chat=[{mes:'no extra'},{mes:'new host field'}],current={chat,context:{clearChat:async()=>{},printMessages:async()=>{chat[0].extra={};chat[1].extra={host:true};}}};
 await renderRestoredMessages({current,plan:{targetChat:structuredClone(chat)}});
 assert.equal(Object.hasOwn(chat[0],'extra'),false);assert.deepEqual(chat[1].extra,{host:true});
});
