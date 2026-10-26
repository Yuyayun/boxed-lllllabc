import { createIndexedDbStorage } from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/indexeddb-adapter.js';
import { createSqliteStorage } from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/sqlite-client.js';
import { createBackupStorage } from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/service.js';
import { createCatalogController } from '/scripts/extensions/third-party/boxed-lllllabc/src/controllers/catalog-controller.js';
import { createStorageControl } from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/control.js';
import { createBatchCleanupPlan } from '/scripts/extensions/third-party/boxed-lllllabc/src/backup/batch-cleanup.js';
import { buildBackupCatalog } from '/scripts/extensions/third-party/boxed-lllllabc/src/backup/catalog.js';
import { emptyManifest } from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/transfer-format.js';
import { stableText } from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/value-digest.js';
import { captureSnapshot } from '/scripts/extensions/third-party/boxed-lllllabc/src/snapshots/model.js';
import { readSnapshot } from '/scripts/extensions/third-party/boxed-lllllabc/src/snapshots/service.js';
import { batchData, seedBatchData } from './batch-fixture.js';

export async function runBatchContract({sqlite=true}={}) {
  if(location.origin!=='http://127.0.0.1:18000')throw new Error('只允许隔离测试实例');
  const checks=[],assert=(value,reason='P5验收失败')=>{if(!value)throw new Error(reason);};
  const token=(await(await fetch('/csrf-token')).json()).token;
  const adapters={indexeddb:createIndexedDbStorage(),sqlite:createSqliteStorage({getRequestHeaders:()=>({'X-CSRF-Token':token})})};
  const modes=sqlite?['indexeddb','sqlite']:['indexeddb'];
  const use=async(mode,operation)=>{const session=await adapters[mode].open();try{return await operation(session);}finally{session.close();}};
  const clear=async mode=>{const id=crypto.randomUUID();await adapters[mode].transfer('prepare',{id,manifest:await emptyManifest()});await adapters[mode].transfer('seal',{id});await adapters[mode].transfer('commit',{id});await adapters[mode].transfer('finish',{id});};
  const seed=async mode=>{await clear(mode);await use(mode,seedBatchData);};
  const data=batchData(),key=data.chatMeta[0].chatKey;
  const preview=async(mode,selection={range:'all'})=>use(mode,async session=>createBatchCleanupPlan({catalog:buildBackupCatalog(await session.getBackupCatalogData()),selection,mode}));
  const control=createStorageControl();await control.update(()=>({active:'indexeddb',previous:null,journal:null,lastTransfer:null}));
  const controlBefore=stableText(await control.read());
  for(const mode of modes) {
    for(const range of ['all','owner','owner-selected','cross-selected']){
      await seed(mode);
      const snapshot=await captureSnapshot({ok:true,identity:{chatKey:key},chat:[{mes:'独立快照原文',swipes:['甲','乙'],swipe_id:1}],context:{chatMetadata:{variables:{retained:true}}}},{name:'批量保留快照'});
      await use(mode,async s=>{await s.beginSnapshot({header:snapshot.header,identityMeta:{chatKey:key}});await s.appendSnapshotMessages({id:snapshot.header.id,messages:snapshot.messages});await s.publishSnapshot({id:snapshot.header.id});});
      const saved=await use(mode,s=>readSnapshot(s,snapshot.header.id));
      const selection={range,ownerKey:'character:a.png',chatKeys:range==='cross-selected'?[key,data.chatMeta[2].chatKey]:[key]};
      const plan=await preview(mode,selection),result=await use(mode,s=>s.deleteBackupBatch({plan,confirmed:true}));
      const expected={all:[7,5,10],owner:[5,3,7],'owner-selected':[3,1,4],'cross-selected':[5,3,7]}[range];
      assert(stableText([result.succeeded,result.skipped,result.deletedRecords])===stableText(expected),`${mode}/${range}统计错误`);
      await use(mode,async s=>{for(const meta of data.chatMeta){assert((await s.getPendingChanges(meta.chatKey)).length===1);if(meta.fullBackupState!=='active')assert((await s.getFullMessages(meta.chatKey)).length===1);}
        if(range==='owner'||range==='owner-selected')assert((await s.getRecentMessages(data.chatMeta[2].chatKey)).length===2);
        if(range==='owner-selected')assert((await s.getRecentMessages(data.chatMeta[1].chatKey)).length===2);
        assert((await s.getChatMeta(key)).recentCount===0);assert(stableText(await readSnapshot(s,snapshot.header.id))===stableText(saved));});
      checks.push(`${mode}/${range} 范围、计数、元数据补丁正确；pending/冻结/待确认完整备份与完整快照不变`);
    }
    for(const change of ['records','pending','metadata','owner','frozen','awaiting','unfrozen','new-chat','missing']){
      await seed(mode);const plan=await preview(mode);
      await use(mode,async s=>{
        if(change==='records')await s.replaceRecentSnapshot({meta:data.chatMeta[0],messages:[{chatKey:key,messageIndex:0,raw:{mes:'changed'}}]});
        if(change==='pending')await s.putPendingChanges([{...data.pendingChanges[0],canonicalHash:'changed'}]);
        if(change==='metadata')await s.updateChatMetaSummary(key,{chatDisplayName:'rename'});
        if(change==='owner')await s.updateChatMetaSummary(key,{characterAvatar:'moved.png'});
        if(change==='frozen'||change==='awaiting')await s.updateChatMetaSummary(key,{fullBackupState:change==='frozen'?'frozen':'awaiting-confirmation'});
        if(change==='unfrozen')await s.updateChatMetaSummary(data.chatMeta[1].chatKey,{fullBackupState:'active'});
        if(change==='new-chat')await s.replaceRecentSnapshot({meta:{chatKey:'new-chat'},messages:[{chatKey:'new-chat',messageIndex:0,raw:{mes:'new'}}]});
        if(change==='missing')await s.replaceRecentSnapshot({meta:data.chatMeta[0],messages:[]});
      });
      const before=stableText(await use(mode,s=>s.getBackupCatalogData()));let failed=false;
      try{await use(mode,s=>s.deleteBackupBatch({plan,confirmed:true}));}catch(error){failed=error.code==='stale-cleanup-plan';}
      assert(failed,`${mode}/${change}未拒绝旧计划`);assert(stableText(await use(mode,s=>s.getBackupCatalogData()))===before,'过期计划有部分删除');
    }
    checks.push(`${mode} 九类预览后变动在数据库事务内拒绝，全部普通数据与元数据保持执行前状态`);
    if(mode==='indexeddb'){
      await seed(mode);const plan=await preview(mode),before=stableText(await use(mode,s=>s.getBackupCatalogData()));
      const original=IDBObjectStore.prototype.delete;let deletes=0,injected=false;
      IDBObjectStore.prototype.delete=function(...args){if(this.name==='historical_changes'){injected=true;throw new DOMException('P5 forced delete failure','QuotaExceededError');}if(this.name==='recent_messages'||this.name==='full_messages')deletes++;return original.apply(this,args);};
      let result;
      try{const controller=createCatalogController({storage:createBackupStorage({adapter:adapters.indexeddb}),renderDialog:()=>{}});result=await controller.executeBatch(plan,{confirmed:true});}
      finally{IDBObjectStore.prototype.delete=original;}
      assert(injected&&deletes>0&&!result.ok&&result.succeeded===0);assert(stableText(await use(mode,s=>s.getBackupCatalogData()))===before);
      checks.push('IndexedDB 真事务在已删记录并更新元数据后注入异常，整批回滚；控制器报告失败而非全部成功');
    }
  }
  if(sqlite){
    await seed('sqlite');
    const uncertainAdapter=createSqliteStorage({getRequestHeaders:()=>({'X-CSRF-Token':token}),fetchImpl:async(url,options)=>{
      const response=await fetch(url,options);
      if(options.body&&JSON.parse(options.body).operation==='deleteBackupBatch'){await response.clone().json();throw new TypeError('P5 simulated lost commit response');}
      return response;
    }});
    const uncertainController=createCatalogController({storage:createBackupStorage({adapter:uncertainAdapter}),renderDialog:()=>{}});
    const uncertainPlan=await uncertainController.previewBatch({range:'all'}),uncertain=await uncertainController.executeBatch(uncertainPlan,{confirmed:true});
    assert(!uncertain.ok&&uncertain.unknown&&uncertain.succeeded===null);
    assert(buildBackupCatalog(await use('sqlite',s=>s.getBackupCatalogData())).recordCount===5);
    let oldRejected=false;try{await use('sqlite',s=>s.deleteBackupBatch({plan:uncertainPlan,confirmed:true}));}catch(error){oldRejected=error.code==='stale-cleanup-plan';}assert(oldRejected);
    checks.push('SQLite 已实际提交但响应丢失时明确报告结果未确认；不误报零删除或全部成功，旧计划再次执行被拒绝');
    await seed('indexeddb');await seed('sqlite');const inactiveBefore=stableText(await use('sqlite',s=>s.getBackupCatalogData()));
    const localPlan=await preview('indexeddb');await use('indexeddb',s=>s.deleteBackupBatch({plan:localPlan,confirmed:true}));
    assert(stableText(await use('sqlite',s=>s.getBackupCatalogData()))===inactiveBefore);
    const localBefore=stableText(await use('indexeddb',s=>s.getBackupCatalogData())),remotePlan=await preview('sqlite');await use('sqlite',s=>s.deleteBackupBatch({plan:remotePlan,confirmed:true}));
    assert(stableText(await use('indexeddb',s=>s.getBackupCatalogData()))===localBefore);
    checks.push('两端分别清理均不修改另一端；控制库活动方式和日志不变');
  }
  assert(stableText(await control.read())===controlBefore);
  await seed('indexeddb');if(sqlite)await seed('sqlite');
  return {checks,active:(await control.read()).active};
}
