import { migrateDatabase } from '../../src/db/migration.js';
import * as operations from '../../src/db/index.js';
import { DB_VERSION, TRANSFER_STORES } from '../../src/db/schema.js';
import { DATASET_NAMES, datasetStore, ACTIVE_DATASET_KEY } from '../../src/storage/dataset-layout.js';
import { createIndexedDbDatasetControl } from '../../src/storage/indexeddb-dataset.js';
import { createIndexedDbTransfer } from '../../src/storage/indexeddb-transfer.js';
import { captureSnapshot } from '../../src/snapshots/model.js';
import { readSnapshot, snapshotBatches } from '../../src/snapshots/service.js';

const request=value=>new Promise((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error);});
const assert=(condition,reason)=>{if(!condition)throw new Error(reason);};
async function rejects(action) {let failed=false;try{await action();}catch{failed=true;}assert(failed,'本应拒绝操作');}

export async function runDatasetContract() {
  if(location.hostname!=='127.0.0.1'||location.pathname!=='/dataset-contract')throw new Error('仅允许独立测试服务');
  const name='boxed-1.0.1-test-'+crypto.randomUUID(),checks=[],commitTransactions=[];
  async function open(version=DB_VERSION) {
    return await new Promise((resolve,reject)=>{
      const req=indexedDB.open(name,version);
      req.onupgradeneeded=()=>{
        if(version===7) {
          for(const storeName of DATASET_NAMES) {
            const keyPath=storeName==='chat_meta'?'chatKey':['pending_changes','snapshots'].includes(storeName)?'id':storeName==='snapshot_messages'?['snapshotId','messageIndex']:['chatKey','messageIndex'];
            const store=req.result.createObjectStore(storeName,{keyPath});
            store.createIndex(storeName==='chat_meta'?'by_lastBackupAt':storeName==='snapshot_messages'?'by_snapshot':'by_chat',storeName==='chat_meta'?'lastBackupAt':storeName==='snapshot_messages'?'snapshotId':'chatKey',{unique:false});
          }
          req.result.createObjectStore(TRANSFER_STORES.meta,{keyPath:'key'});
          req.result.createObjectStore(TRANSFER_STORES.rows,{keyPath:['id','kind','n']}).createIndex('unique_record',['id','kind','keyText'],{unique:true});
        }else migrateDatabase(req.result,req.transaction);
      };
      req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);req.onblocked=()=>reject(new Error('测试升级被阻塞'));
    });
  }
  async function transaction(names,mode,fn) {
    const db=await open();
    try{return await new Promise((resolve,reject)=>{
      const tx=db.transaction(names,mode);let value;
      tx.oncomplete=()=>resolve(value);tx.onabort=tx.onerror=()=>reject(tx.error??new Error('测试事务中止'));
      Promise.resolve().then(()=>fn(tx)).then(result=>{value=result;}).catch(error=>{tx.abort();reject(error);});
    });}finally{db.close();}
  }
  const meta=(key,value)=>transaction([TRANSFER_STORES.meta],'readwrite',tx=>request(tx.objectStore(TRANSFER_STORES.meta).put({key,value})));
  const readMeta=key=>transaction([TRANSFER_STORES.meta],'readonly',tx=>request(tx.objectStore(TRANSFER_STORES.meta).get(key)));
  const readArea=id=>transaction(DATASET_NAMES.map(n=>datasetStore(n,id)),'readonly',async tx=>{
    const result={};for(const n of DATASET_NAMES)result[n]=await request(tx.objectStore(datasetStore(n,id)).getAll());return result;
  });
  const call=async(method,...args)=>{const db=await open();try{return await operations[method](db,...args);}finally{db.close();}};
  const manifest={count:2,bytes:200,digest:'verified-fixture'};
  let id='dataset-browser-123';
  async function register({phase='verified',previousDataset=0,dataset=1,taskId=id}={}) {
    const revision=(await readMeta('revision'))?.value??0;
    await transaction([TRANSFER_STORES.meta],'readwrite',async tx=>{
      const store=tx.objectStore(TRANSFER_STORES.meta);
      await request(store.put({key:'lock',value:taskId}));
      await request(store.put({key:taskId,id:taskId,version:3,role:'target',phase,previousDataset,dataset,baseRevision:revision,manifest}));
    });
  }
  const control=createIndexedDbDatasetControl({openDatabase:async()=>{
    const db=await open(),original=db.transaction.bind(db);
    db.transaction=(names,...args)=>{commitTransactions.push([...names]);return original(names,...args);};return db;
  }});
  try {
    let db=await open(7);
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(['chat_meta','full_messages'],'readwrite');
      tx.objectStore('chat_meta').put({chatKey:'same',marker:'old',date:new Date(0),missing:undefined});
      tx.objectStore('full_messages').put({chatKey:'same',messageIndex:0,raw:{mes:'old',swipes:['a','b']}});
      tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
    });db.close();
    const old=await readArea(0);
    assert(old.chat_meta[0].date instanceof Date&&Object.hasOwn(old.chat_meta[0],'missing'),'升级损失特殊字段');
    assert(Object.values(await readArea(1)).every(rows=>!rows.length),'升级应只创建空目标');
    checks.push('真实 schema 7→8 升级，旧记录及特殊字段保留，新增数据区为空');

    await meta(ACTIVE_DATASET_KEY,1);
    await call('putChatMeta',{chatKey:'same',marker:'new'});
    await call('putFullMessages',{chatKey:'same',messages:[{chatKey:'same',messageIndex:0,raw:{mes:'new',date:new Date(0),missing:undefined}}]});
    const source={ok:true,identity:{chatKey:'same',meta:{chatKey:'same'}},chat:[{mes:'snapshot',extra:{date:new Date(0)}}],context:{chatMetadata:{variable:1}}};
    const snapshot=await captureSnapshot(source,{name:'新数据区'});
    await call('beginSnapshot',{header:snapshot.header,identityMeta:source.identity.meta});
    for(const messages of snapshotBatches(snapshot.messages))await call('appendSnapshotMessages',{id:snapshot.header.id,messages});
    await call('publishSnapshot',{id:snapshot.header.id});
    await meta(ACTIVE_DATASET_KEY,0);
    assert((await call('getFullMessages','same'))[0].raw.mes==='old','旧区读取错乱');
    const staged=await readArea(1);
    await register({phase:'staging'});await rejects(()=>control.commit(id,manifest));
    await register();await rejects(()=>control.commit(id,{...manifest,digest:'tampered'}));
    await meta('lock','another-task');await rejects(()=>control.commit(id,manifest));
    await meta('lock',id);
    const failing=createIndexedDbDatasetControl({openDatabase:async()=>{
      const db=await open(),transaction=db.transaction.bind(db);
      db.transaction=(...args)=>{
        const tx=transaction(...args),objectStore=tx.objectStore.bind(tx);
        tx.objectStore=(...names)=>{
          const store=objectStore(...names),put=store.put.bind(store);
          store.put=value=>{if(value.key===id&&value.phase==='committed')throw new Error('forced-receipt-failure');return put(value);};return store;
        };return tx;
      };return db;
    }});
    await rejects(()=>failing.commit(id,manifest));
    assert((await readMeta(ACTIVE_DATASET_KEY)).value===0,'失败事务没有回滚活动标记');
    assert((await readMeta(id)).phase==='verified','失败事务污染回执');
    await control.commit(id,manifest);await control.commit(id,manifest);
    assert((await readMeta(ACTIVE_DATASET_KEY)).value===1,'目标提交没有持久化');
    await rejects(()=>call('getChatMeta','same'));
    assert(commitTransactions.every(names=>names.length===1&&names[0]===TRANSFER_STORES.meta),'启用期间触及正文仓库');
    await control.rollback(id);
    assert((await readMeta(ACTIVE_DATASET_KEY)).value===0,'回退标记错误');
    const sameArea=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
    assert(sameArea(await readArea(0),old)&&sameArea(await readArea(1),staged),'启用或回退修改正文');
    checks.push('提交、响应丢失后重试、关闭重开和回退只有元数据事务，新旧正文保持不变');

    id='dataset-browser-456';await register();await control.commit(id,manifest);
    await transaction([TRANSFER_STORES.meta],'readwrite',async tx=>{
      const store=tx.objectStore(TRANSFER_STORES.meta);const value=await request(store.get(id));
      await request(store.put({...value,phase:'finished'}));await request(store.delete('lock'));
    });
    assert((await call('getChatMeta','same')).marker==='new','普通读取未跟随新数据区');
    assert((await call('getFullMessages','same'))[0].raw.mes==='new','正文读取错区');
    await call('putChatMeta',{chatKey:'only-new'});
    assert((await call('getBackupCatalogData')).chatMeta.some(row=>row.chatKey==='only-new'),'目录键读取错区');
    const saved=await readSnapshot({getSnapshotHeader:(...args)=>call('getSnapshotHeader',...args),getSnapshotMessages:(...args)=>call('getSnapshotMessages',...args)},snapshot.header.id);
    assert(sameArea(saved.chat,source.chat),'快照分页读取错区');
    assert(sameArea(await readArea(0),old),'新活动区写入污染旧区');
    await rejects(()=>createIndexedDbTransfer({openDatabase:open})('source',{id:'legacy-transfer-123'}));
    await rejects(()=>control.rollback(id));
    id='dataset-browser-reverse';await register({previousDataset:1,dataset:0});await control.commit(id,manifest);
    assert((await readMeta(ACTIVE_DATASET_KEY)).value===0,'反向启用错误');
    await transaction([TRANSFER_STORES.meta],'readwrite',tx=>request(tx.objectStore(TRANSFER_STORES.meta).delete('lock')));
    assert((await call('getChatMeta','same')).marker==='old','反向启用未读取正确数据');
    await meta(ACTIVE_DATASET_KEY,'1');await rejects(()=>call('getChatMeta','same'));
    checks.push('新活动区普通读写、目录、快照分页通过；非法标记和旧迁移流程拒绝操作');
    return {checks,commitTransactions,isolatedDatabase:name};
  }finally{
    if(!name.startsWith('boxed-1.0.1-test-'))throw new Error('测试数据库范围错误');
    await request(indexedDB.deleteDatabase(name));
  }
}
