import test from "node:test";
import assert from "node:assert/strict";
import { captureSnapshot, verifySnapshotHeader, verifySnapshotMessage, currentSnapshotFingerprint } from "../src/snapshots/model.js";
import { previewSnapshotRestore, restoredMetadata, verifyNativeSnapshotSave } from "../src/snapshots/restore.js";
import { snapshotBatches, readSnapshot } from "../src/snapshots/service.js";
import { readTransferManifest } from "../src/storage/transfer-format.js";
import { createSnapshotController } from "../src/controllers/snapshot-controller.js";
import { createSnapshotSaveProof, confirmSnapshotPending } from "../src/snapshots/confirmation.js";
import { createBackendVerifier } from "../src/controllers/backend-verifier.js";
import { createStructuralPendingRecord } from "../src/backup/pending.js";
import { comparePendingWithBackend } from "../src/verifier/compare.js";

const current = () => ({ ok:true, identity:{chatKey:"character:test.png:chat",meta:{characterAvatar:"test.png",chatId:"chat"}},
  chat:[{mes:"甲",swipes:["甲","乙"],swipe_id:0,extra:{value:undefined,date:new Date(0)}}],context:{chatMetadata:{integrity:"target-native-id",variables:{score:3}}} });
test("手动快照深拷贝全消息和元数据，后续编辑/删层/swipe 及名称变化不改变内容摘要",async()=>{
  const source=current(),snapshot=await captureSnapshot(source,{name:"存档"});
  source.chat[0].swipe_id=1;source.chat[0].mes="乙";source.chat.push({mes:"new"});source.context.chatMetadata.variables.score=99;
  assert.equal(snapshot.messages[0].raw.mes,"甲");assert.equal(snapshot.header.metadata.variables.score,3);
  assert.ok(Object.hasOwn(snapshot.messages[0].raw.extra,"value"));assert.ok(snapshot.messages[0].raw.extra.date instanceof Date);
  await verifySnapshotHeader({...snapshot.header,name:"改名"});await verifySnapshotMessage(snapshot.messages[0],snapshot.header);
  await assert.rejects(verifySnapshotHeader({...snapshot.header,metadata:{changed:true}}),/校验失败/);
  await assert.rejects(verifySnapshotMessage({...snapshot.messages[0],raw:{mes:"corrupt"}},snapshot.header),/校验失败/);
});
test("每次创建独立 ID，空名称使用时间；循环/不支持的字段失败而不丢失字段",async()=>{
  const a=await captureSnapshot(current(),{name:"   "}),b=await captureSnapshot(current());assert.notEqual(a.header.id,b.header.id);assert.ok(a.header.name.trim());
  const source=current();source.chat[0].fn=()=>{};await assert.rejects(captureSnapshot(source),/无法无损/);
  const huge=current();huge.context.chatMetadata.large="x".repeat(9*1024*1024);await assert.rejects(captureSnapshot(huge),/元数据超过 8 MiB/);
});
test("快照恢复限定所属逻辑聊天，保留目标原生 UUID，完整字段变化也使预览失效",async()=>{
  const source=current(),snapshot=await captureSnapshot(source);snapshot.header.state="ready";snapshot.header.written=1;
  const body={header:snapshot.header,chat:snapshot.messages.map(row=>row.raw)};
  const preview=await previewSnapshotRestore({snapshot:body,current:source,pending:[]});assert.equal(preview.plan.source,"full");assert.equal(preview.plan.blockedReason,"");
  const changed=current();changed.context.chatMetadata.integrity="another-native";assert.equal(restoredMetadata(body,changed).integrity,"another-native");
  changed.context.chatMetadata.chat_id_hash=123;assert.equal(restoredMetadata(body,changed).chat_id_hash,123);
  await assert.rejects(previewSnapshotRestore({snapshot:body,current:{...source,identity:{chatKey:"other-branch"}},pending:[]}),/所属/);
  const before=await currentSnapshotFingerprint(source);source.chat[0].custom={newField:true};assert.notEqual(await currentSnapshotFingerprint(source),before);
});
test("保存核对覆盖完整 JSON 持久字段和聊天元数据，不以界面已变化视作成功",async()=>{
  const snapshot=await captureSnapshot(current()),body={header:snapshot.header,chat:snapshot.messages.map(row=>row.raw)},metadata=snapshot.header.metadata;
  const backend={ok:true,chat:JSON.parse(JSON.stringify([{chat_metadata:metadata},...body.chat]))};
  assert.equal(verifyNativeSnapshotSave({snapshot:body,metadata,backend}),true);
  backend.chat[0].chat_metadata.variables.score=10;assert.equal(verifyNativeSnapshotSave({snapshot:body,metadata,backend}),false);
  assert.equal(verifyNativeSnapshotSave({snapshot:body,metadata,backend:{ok:false}}),false);
});
test("快照读取拒绝草稿、缺层、内容损坏和读回中快照消失",async()=>{
  const snapshot=await captureSnapshot(current());const session={getSnapshotHeader:async()=>snapshot.header,getSnapshotMessages:async({after})=>after<0?snapshot.messages:[]};
  await assert.rejects(readSnapshot(session,snapshot.header.id),/尚未完整/);snapshot.header.state="ready";snapshot.header.written=1;
  assert.equal((await readSnapshot(session,snapshot.header.id)).chat.length,1);
  await assert.rejects(readSnapshot({...session,getSnapshotMessages:async()=>[]},snapshot.header.id),/不完整/);
  await assert.rejects(readSnapshot({...session,getSnapshotMessages:async()=>[{...snapshot.messages[0],raw:{mes:"bad"}}]},snapshot.header.id),/校验失败/);
  let reads=0;await assert.rejects(readSnapshot({...session,getSnapshotHeader:async()=>++reads===1?snapshot.header:undefined},snapshot.header.id),/已变化/);
});
test("迁移清单包含快照信息和正文，验证快照关联、数量和内容摘要",async()=>{
  const snapshot=await captureSnapshot(current());snapshot.header.state="ready";snapshot.header.written=1;
  const rows=[{n:1,store:"chat_meta",key:snapshot.header.chatKey,value:{chatKey:snapshot.header.chatKey}},{n:2,store:"snapshots",key:snapshot.header.id,value:snapshot.header},{n:3,store:"snapshot_messages",key:[snapshot.header.id,0],value:snapshot.messages[0]}];
  const manifest=await readTransferManifest(async(after)=>after?[]:rows);assert.equal(manifest.counts.snapshots,1);assert.equal(manifest.counts.snapshot_messages,1);
  await assert.rejects(readTransferManifest(async(after)=>after?[]:rows.slice(0,2)),/数量不完整/);
  await assert.rejects(readTransferManifest(async(after)=>after?[]:[rows[0],{...rows[2],n:2}]),/缺少关联/);
});
test("大快照分为有界批次，超大单层明确拒绝；操作锁和删除确认在控制器执行前生效",async()=>{
  const batches=snapshotBatches(Array.from({length:125},(_,i)=>({raw:{mes:"a".repeat(30000)},messageIndex:i})));assert.ok(batches.length>=3);assert.ok(batches.every(batch=>batch.length<=50));
  assert.throws(()=>snapshotBatches([{raw:{mes:"a".repeat(9*1024*1024)}}]),/8 MiB/);
  const controller=createSnapshotController({runGuard:async()=>{throw new Error("操作已锁定");}});
  await assert.rejects(controller.create(),/锁定/);await assert.rejects(controller.rename({}),/锁定/);await assert.rejects(controller.delete({}),/锁定/);await assert.rejects(controller.restore({},{confirmed:true}),/锁定/);
});
test("快照恢复的待确认记录要求完整正文和元数据，不能被普通核对提前核销",async()=>{
  const source=current(),record={...createStructuralPendingRecord({chatKey:source.identity.chatKey,chat:source.chat}),id:'snapshot-restore',snapshotSaveProof:await createSnapshotSaveProof(source.context.chatMetadata)};
  const backend=JSON.parse(JSON.stringify([{chat_metadata:source.context.chatMetadata},...source.chat]));
  assert.equal(comparePendingWithBackend([record],backend).remaining.length,1);
  assert.equal((await confirmSnapshotPending([record],backend,source)).has(record.id),true);
  backend[0].chat_metadata.variables.score=99;assert.equal((await confirmSnapshotPending([record],backend,source)).size,0);
  backend[0].chat_metadata.variables.score=3;backend[1].custom='unexpected';assert.equal((await confirmSnapshotPending([record],backend,source)).size,0);
});
test("完整备份确认捷径也不跳过快照元数据校验，真正保存后再允许核销",async()=>{
  for(const needsFull of [false,true]){
    const source=current();let pending=[{...createStructuralPendingRecord({chatKey:source.identity.chatKey,chat:source.chat}),id:'snapshot-restore',snapshotSaveProof:await createSnapshotSaveProof(source.context.chatMetadata)}];let status={code:'checking'},deleted=0;
    const backend=JSON.parse(JSON.stringify([{chat_metadata:source.context.chatMetadata},...source.chat]));backend[0].chat_metadata.variables.score=99;
    const verifier=createBackendVerifier({getContextReader:()=>({readCurrentChat:()=>source}),getSettings:()=>({enabled:true}),getLatestStatus:()=>status,setStatus:s=>{status=s;},refreshVisiblePanel:async()=>{},prioritizeFullBackupStatus:async(_k,s)=>s,readCurrentPending:async()=>pending,updateBackendMeta:async()=>{},createDisplayStatus:code=>({code}),readBackend:async()=>({ok:true,chat:backend}),needsFullBackupConfirmation:async()=>needsFull,deleteConfirmedPending:async records=>{deleted+=records.length;pending=[];return records.map(r=>r.id);},retryDelays:[]});
    await verifier.verifyBackendNow({chatKey:source.identity.chatKey});assert.equal(deleted,0);assert.equal(pending.length,1);assert.notEqual(status.code,'saved');
    backend[0].chat_metadata.variables.score=3;await verifier.verifyBackendNow({chatKey:source.identity.chatKey});assert.equal(deleted,1);assert.equal(status.code,'saved');
  }
});
