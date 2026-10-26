import {createIndexedDbStorage} from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/indexeddb-adapter.js';
import {createSqliteStorage} from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/sqlite-client.js';
import {createBackupStorage} from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/service.js';
import {createStorageControl} from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/control.js';
import {createTransferCoordinator} from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/transfer.js';
import {createSnapshotController} from '/scripts/extensions/third-party/boxed-lllllabc/src/controllers/snapshot-controller.js';
import {readSnapshot} from '/scripts/extensions/third-party/boxed-lllllabc/src/snapshots/service.js';
import {emptyManifest} from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/transfer-format.js';
import {stableText} from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/value-digest.js';
import {fingerprintBackupRecords} from '/scripts/extensions/third-party/boxed-lllllabc/src/backup/cleanup.js';
import {openBackupDatabase} from '/scripts/extensions/third-party/boxed-lllllabc/src/db/index.js';

export async function runSnapshotContract({large=false}={}) {
 if(location.origin!=='http://127.0.0.1:18000')throw new Error('只允许隔离实例');
 const checks=[],assert=(value,reason='快照验收失败')=>{if(!value)throw new Error(reason);};
 const rejects=async operation=>{let failed=false;try{await operation();}catch{failed=true;}assert(failed,'本应拒绝操作');};
 const token=(await(await fetch('/csrf-token')).json()).token;
 const adapters={indexeddb:createIndexedDbStorage(),sqlite:createSqliteStorage({getRequestHeaders:()=>({'X-CSRF-Token':token})})};
 const clear=async mode=>{const id=crypto.randomUUID();await adapters[mode].transfer('prepare',{id,manifest:await emptyManifest()});await adapters[mode].transfer('seal',{id});await adapters[mode].transfer('commit',{id});await adapters[mode].transfer('finish',{id});};
 const use=async(mode,operation)=>{const session=await adapters[mode].open();try{return await operation(session);}finally{session.close();}};
 await clear('indexeddb');await clear('sqlite');
 const savedIds={};
 for(const mode of ['indexeddb','sqlite']){
  const key=`character:p4.png:${mode}`;
  let current={ok:true,identity:{ok:true,chatKey:key,meta:{chatType:'character',characterAvatar:'p4.png',chatId:mode,chatIntegrity:'same-legacy-id'}},chat:[{name:'虚构角色',mes:'原始甲',swipes:['原始甲','候选乙'],swipe_id:0,extra:{date:new Date(0),missing:undefined,empty:null}},{mes:'尾部楼层',is_user:true}],context:{chatMetadata:{integrity:'same-legacy-id',variables:{score:3}}}};
  let nativeCopy;
  current.context.updateChatMetadata=(metadata)=>{current.context.chatMetadata=structuredClone(metadata);};
  current.context.clearChat=async()=>{};current.context.printMessages=async()=>{};
  current.context.saveChat=async()=>{nativeCopy=JSON.parse(JSON.stringify([{chat_metadata:current.context.chatMetadata},...current.chat]));};
  const storage=createBackupStorage({adapter:adapters[mode]});
  const controller=createSnapshotController({storage,getContextReader:()=>({readCurrentChat:()=>current}),readBackend:async()=>({ok:true,chat:nativeCopy})});
  const first=await controller.create({name:'手动存档一'}),second=await controller.create({name:'手动存档二'});savedIds[mode]=first.header.id;
  assert(first.header.id!==second.header.id);const original=await use(mode,session=>readSnapshot(session,first.header.id));
  current.chat[0].swipe_id=1;current.chat[0].mes='候选乙';current.chat.splice(1,1);current.context.chatMetadata.variables.score=99;
  assert(stableText((await use(mode,session=>readSnapshot(session,first.header.id))).chat)===stableText(original.chat));
  await use(mode,async session=>{const messages=[{chatKey:key,messageIndex:0,raw:{mes:'ordinary'}}];await session.replaceRecentSnapshot({meta:{chatKey:key},messages});await session.replaceFullSnapshot({chatKey:key,messages,meta:{...current.identity.meta,chatKey:key}});await session.deleteBackupTypeForChat({chatKey:key,type:'recent',expectedFingerprint:fingerprintBackupRecords(messages)});});
  assert(stableText((await use(mode,session=>readSnapshot(session,first.header.id))).chat)===stableText(original.chat));
  assert((await controller.list({})).items.length===2);checks.push(`${mode} 创建独立ID，完整正文/候选/元数据无损，日常编辑删层与普通备份替换/清理不改变存档`);
  await controller.rename({id:first.header.id,name:'仅改名称',expectedName:'手动存档一'});const renamed=await use(mode,session=>readSnapshot(session,first.header.id));assert(renamed.header.name==='仅改名称'&&renamed.header.contentHash===original.header.contentHash);
  await rejects(()=>controller.delete({id:first.header.id,expectedHash:first.header.contentHash}));assert((await controller.list({})).items.length===2);
  await controller.delete({id:second.header.id,expectedHash:second.header.contentHash,confirmed:true});assert((await controller.list({})).items.length===1);
  checks.push(`${mode} 名称更新不改正文/时间/摘要；独立删除确认只删除指定快照`);
  const preview=await controller.preview(first.header.id);await rejects(()=>controller.restore(preview.restore));
  current.chat[0].custom='预览后变化';await rejects(()=>controller.restore(preview.restore,{confirmed:true}));delete current.chat[0].custom;
  const refreshed=await controller.preview(first.header.id),restored=await controller.restore(refreshed.restore,{confirmed:true});assert(restored.ok&&restored.confirmed,restored.reason);assert(stableText(current.chat)===stableText(original.chat));assert(current.context.chatMetadata.variables.score===3);assert((await controller.list({})).items.length===1);
  checks.push(`${mode} 未确认/过期预览拒绝；完整快照恢复经保存结果比对后确认，源快照保留（宿主端口模拟）`);
  current.chat[0].mes='待恢复';const failedSaveController=createSnapshotController({storage,getContextReader:()=>({readCurrentChat:()=>current}),readBackend:async()=>({ok:false}),waitForSave:async()=>({ok:false,status:'failed'})});
  const failedPreview=await failedSaveController.preview(first.header.id),failedSave=await failedSaveController.restore(failedPreview.restore,{confirmed:true});assert(!failedSave.ok&&!failedSave.confirmed);assert((await use(mode,s=>s.getPendingChanges(key))).length>0);
  checks.push(`${mode} 保存失败/无法核对不误报完成，未保存保护仍在`);
  const failedRenderController=createSnapshotController({storage,getContextReader:()=>({readCurrentChat:()=>current}),readBackend:async()=>({ok:true,chat:nativeCopy}),render:async()=>{throw new Error('强制重绘失败');}});
  const renderPreview=await failedRenderController.preview(first.header.id),renderResult=await failedRenderController.restore(renderPreview.restore,{confirmed:true});assert(!renderResult.ok&&renderResult.stage==='render');
  checks.push(`${mode} 即使服务器旧内容恰好一致，原生重绘失败也不报告恢复完成`);
  const badStorage={...storage,open:async()=>{const session=await storage.open();return {...session,getSnapshotMessages:async options=>(await session.getSnapshotMessages(options)).map(row=>({...row,raw:{mes:'corrupt'}}))};}};
  const badController=createSnapshotController({storage:badStorage,getContextReader:()=>({readCurrentChat:()=>current})});const before=stableText(current.chat);await rejects(()=>badController.preview(first.header.id));await rejects(()=>badController.restore(refreshed.restore,{confirmed:true}));assert(stableText(current.chat)===before);
  const interruptedStorage={...storage,open:async()=>{const session=await storage.open();return {...session,appendSnapshotMessages:async()=>{throw new Error('强制写入失败');}};}};
  await rejects(()=>createSnapshotController({storage:interruptedStorage,getContextReader:()=>({readCurrentChat:()=>current})}).create({name:'不应显示成功'}));assert((await controller.list({})).items.length===1);
  checks.push(`${mode} 内容损坏禁止覆盖，创建批次失败不发布快照`);
  if(mode==='indexeddb'){
    const put=IDBObjectStore.prototype.put;let injected=false;
    IDBObjectStore.prototype.put=function(value,...args){if(this.name==='snapshot_messages'&&value.messageIndex===1&&!injected){injected=true;throw new DOMException('P4 quota failure during message append','QuotaExceededError');}return put.call(this,value,...args);};
    try{await rejects(()=>controller.create({name:'真实IDB事务中途失败'}));}finally{IDBObjectStore.prototype.put=put;}
    assert(injected&&(await controller.list({})).items.length===1);
    const id=crypto.randomUUID();await adapters.indexeddb.transfer('source',{id});try{const manifest=await adapters.indexeddb.transfer('seal',{id});assert(manifest.counts.snapshots===1&&manifest.counts.snapshot_messages===2);}finally{await adapters.indexeddb.transfer('rollback',{id});}
    checks.push('IndexedDB 正文第二条写入注入配额异常，真实事务回滚首条及进度，草稿与残余正文已收尾');
  }
  const branch={ok:true,chatKey:key+'-branch',meta:{...current.identity.meta,chatId:mode+'-branch'}};await use(mode,s=>s.reconcileChatIdentity(branch));current.identity=branch;assert(!(await controller.preview(first.header.id)).restore);
  const next={ok:true,chatKey:key+'-renamed',meta:{...branch.meta,chatId:mode+'-renamed'}};await use(mode,s=>s.migrateRenamedChatIdentity({ok:true,source:{chatId:mode},identity:next}));current.identity=next;
  const afterRename=await controller.preview(first.header.id);assert(afterRename.restore&&afterRename.snapshot.header.chatKey===next.chatKey);assert(afterRename.snapshot.header.contentHash===original.header.contentHash);
  checks.push(`${mode} Rename 关联快照，正文不变；共享UUID Branch不继承快照`);
 }
 const control=createStorageControl();await control.update(()=>({active:'indexeddb',previous:null,lastTransfer:null,journal:null}));const coordinator=createTransferCoordinator({control,adapters});
 const localBefore=await use('indexeddb',s=>readSnapshot(s,savedIds.indexeddb));await coordinator.switchTo('sqlite',{confirmed:true});
 const moved=await use('sqlite',s=>readSnapshot(s,savedIds.indexeddb));assert(stableText(moved)===stableText(localBefore));assert(await use('sqlite',s=>s.getSnapshotHeader(savedIds.sqlite))===undefined);
 await coordinator.switchTo('indexeddb',{confirmed:true});assert(stableText(await use('indexeddb',s=>readSnapshot(s,savedIds.indexeddb)))===stableText(localBefore));
 await coordinator.clearInactive('sqlite',{confirmed:true});assert((await use('sqlite',s=>s.listSnapshots({}))).items.length===0);assert((await use('indexeddb',s=>s.listSnapshots({}))).items.length===1);
 checks.push('两方向完整切换包含快照头/正文并覆盖目标旧快照，源保留；清空非活动端包含快照且不动活动端');
 if(large){
  const storage=createBackupStorage({adapter:adapters.indexeddb});const largeCurrent={ok:true,identity:{ok:true,chatKey:'character:p4.png:large',meta:{characterAvatar:'p4.png',chatId:'large'}},context:{chatMetadata:{variables:{large:true}}},chat:Array.from({length:360},(_,i)=>({mes:`层${i}:`+'中'.repeat(33000),swipes:['甲','乙'],swipe_id:1}))};
  const started=performance.now();const created=await createSnapshotController({storage,getContextReader:()=>({readCurrentChat:()=>largeCurrent})}).create({name:'超过32MiB的大快照'});
  await coordinator.switchTo('sqlite',{confirmed:true});const largeSnapshot=await use('sqlite',s=>readSnapshot(s,created.header.id));assert(largeSnapshot.chat.length===360&&largeSnapshot.chat[359].mes===largeCurrent.chat[359].mes);
  await coordinator.switchTo('indexeddb',{confirmed:true});assert((await use('indexeddb',s=>readSnapshot(s,created.header.id))).chat.length===360);
  checks.push(`超过32MiB的360层快照分批创建、读回和双向切换通过，耗时${Math.round(performance.now()-started)}ms`);
 }
 return {checks,active:(await control.read()).active};
}
