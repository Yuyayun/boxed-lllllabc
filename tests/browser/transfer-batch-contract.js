import * as operations from '../../src/db/index.js';
import { migrateDatabase } from '../../src/db/migration.js';
import { DB_VERSION, TRANSFER_STORES } from '../../src/db/schema.js';
import { DATASET_NAMES, datasetStore } from '../../src/storage/dataset-layout.js';
import { createIndexedDbBatchTransfer } from '../../src/storage/indexeddb-batch-transfer.js';
import { createIndexedDbDatasetControl } from '../../src/storage/indexeddb-dataset.js';
import { encodeStorageValue, decodeStorageValue } from '../../src/storage/protocol.js';
import { stableText } from '../../src/storage/value-digest.js';
import { captureSnapshot } from '../../src/snapshots/model.js';
import { readSnapshot, snapshotBatches } from '../../src/snapshots/service.js';
import { batchKey } from '../../src/storage/transfer-batch-format.js';

const assert=(value,message)=>{if(!value)throw new Error(message);};
const request=value=>new Promise((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error);});
async function rejects(action) {let failed=false;try{await action();}catch{failed=true;}assert(failed,'本应失败');}
const normalized=data=>Object.fromEntries(DATASET_NAMES.map(name=>[name,data[name].map(value=>stableText(value)).sort()]));

export async function runTransferBatchContract(nonce) {
  if(location.hostname!=='127.0.0.1'||location.pathname!=='/transfer-batch-contract')throw new Error('只允许独立测试服务');
  const checks=[];
  async function rpc(method,args=[],dropResponse=false) {
    const response=await fetch('/test-batch',{method:'POST',headers:{'Content-Type':'application/json','X-Boxed-Test-Nonce':nonce},body:JSON.stringify({method,args:encodeStorageValue(args),dropResponse})});
    const data=await response.json();if(!data.ok)throw new Error(data.message);return decodeStorageValue(data.value);
  }
  const remote={
    normal:(...args)=>rpc('normal',args),peek:(...args)=>rpc('peek',args),reopen:()=>rpc('reopen'),
    activate:(...args)=>rpc('activate',args),unlock:(...args)=>rpc('unlock',args),
    begin:(...args)=>rpc('begin',args),status:(...args)=>rpc('status',args),prepareStep:(...args)=>rpc('prepareStep',args),
    sourceNext:(...args)=>rpc('sourceNext',args),append:(...args)=>rpc('append',args),verifyBatch:(...args)=>rpc('verifyBatch',args),startSeal:(...args)=>rpc('startSeal',args),sealStep:(...args)=>rpc('sealStep',args),
  };
  for(const from of ['indexeddb','sqlite']) {
    await rpc('reset');
    const name='boxed-1.0.1-test-'+crypto.randomUUID();
    let failCheckpoint=false;
    const open=()=>new Promise((resolve,reject)=>{
      const req=indexedDB.open(name,DB_VERSION);req.onupgradeneeded=()=>migrateDatabase(req.result,req.transaction);
      req.onsuccess=()=>{
        const db=req.result,transaction=db.transaction.bind(db);
        db.transaction=(...args)=>{
          const tx=transaction(...args),objectStore=tx.objectStore.bind(tx);
          tx.objectStore=(name)=>{
            const store=objectStore(name);
            if(name===TRANSFER_STORES.meta){
              const put=store.put.bind(store);
              store.put=value=>{if(failCheckpoint&&value.id&&value.verifiedBatch===1){failCheckpoint=false;throw new Error('fixture-checkpoint-failure');}return put(value);};
            }
            return store;
          };return tx;
        };resolve(db);
      };req.onerror=()=>reject(req.error);req.onblocked=()=>reject(new Error('测试库被阻塞'));
    });
    let engine=createIndexedDbBatchTransfer({openDatabase:open});
    const dataset=createIndexedDbDatasetControl({openDatabase:open});
    const local={
      normal:async(method,...args)=>{const db=await open();try{return await operations[method](db,...args);}finally{db.close();}},
      peek:async(area=0)=>{
        const db=await open();try{return await new Promise((resolve,reject)=>{
          const tx=db.transaction(DATASET_NAMES.map(n=>datasetStore(n,area)),'readonly'),result={};
          tx.oncomplete=()=>resolve(result);tx.onerror=tx.onabort=()=>reject(tx.error);
          (async()=>{for(const n of DATASET_NAMES)result[n]=await request(tx.objectStore(datasetStore(n,area)).getAll());})().catch(error=>{tx.abort();reject(error);});
        });}finally{db.close();}
      },
      reopen:async()=>{engine=createIndexedDbBatchTransfer({openDatabase:open});},
      rawPut:async(row)=>{
        const db=await open();try{return await new Promise((resolve,reject)=>{
          const tx=db.transaction([datasetStore(row.store,1)],'readwrite');tx.objectStore(datasetStore(row.store,1)).put(row.value);
          tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error);
        });}finally{db.close();}
      },
      readMeta:async key=>{
        const db=await open();try{return await new Promise((resolve,reject)=>{
          const tx=db.transaction([TRANSFER_STORES.meta],'readonly');let value;
          request(tx.objectStore(TRANSFER_STORES.meta).get(key)).then(result=>{value=result;}).catch(reject);
          tx.oncomplete=()=>resolve(value);tx.onerror=tx.onabort=()=>reject(tx.error);
        });}finally{db.close();}
      },
      activate:(...args)=>dataset.commit(...args),
      unlock:async id=>{
        const db=await open();try{return await new Promise((resolve,reject)=>{
          const tx=db.transaction([TRANSFER_STORES.meta],'readwrite'),meta=tx.objectStore(TRANSFER_STORES.meta);
          tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error);
          (async()=>{const state=await request(meta.get(id));assert(state.phase==='committed','夹具只能解锁已提交任务');await request(meta.put({...state,phase:'finished'}));await request(meta.delete('lock'));})().catch(error=>{tx.abort();reject(error);});
        });}finally{db.close();}
      },
    };
    for(const method of ['begin','status','prepareStep','sourceNext','append','verifyBatch','startSeal','sealStep'])local[method]=(...args)=>engine[method](...args);
    const to=from==='indexeddb'?'sqlite':'indexeddb',source=from==='indexeddb'?local:remote,target=to==='indexeddb'?local:remote;
    const id=crypto.randomUUID(),job={id,from,to};
    try {
      const meta={chatKey:'source',fullBackupState:'frozen',date:new Date(0),optional:undefined};
      await source.normal('replaceRecentSnapshot',{meta,messages:[{messageIndex:0,raw:{mes:'recent'}}]});
      await source.normal('putFullMessages',{chatKey:'source',messages:Array.from({length:5},(_,i)=>({messageIndex:i,raw:{mes:'正文-'+i+'中'.repeat(70),swipes:['a','b'],date:new Date(0),missing:undefined}}))});
      await source.normal('putPendingChanges',[{id:'pending-123',chatKey:'source',messageIndex:null,kind:'structure',raw:{keep:true}}]);
      await source.normal('putHistoricalChanges',[{chatKey:'source',messageIndex:0,raw:{mes:'history'},firstCapturedAt:'2026-10-28T00:00:00Z'}]);
      const current={ok:true,identity:{chatKey:'source'},chat:[{mes:'snapshot-a',date:new Date(0)},{mes:'snapshot-b',optional:undefined},{mes:'snapshot-c',swipes:['x','y']}],context:{chatMetadata:{variable:1}}};
      const snapshot=await captureSnapshot(current,{name:'跨驱动快照'});
      await source.normal('beginSnapshot',{header:snapshot.header,identityMeta:{chatKey:'source'}});
      for(const messages of snapshotBatches(snapshot.messages))await source.normal('appendSnapshotMessages',{id:snapshot.header.id,messages});
      await source.normal('publishSnapshot',{id:snapshot.header.id});
      await target.normal('putChatMeta',{chatKey:'old-target',keep:true});
      const sourceBefore=normalized(await source.peek(0)),targetBefore=normalized(await target.peek(0));
      await source.begin({...job,role:'source'});await target.begin({...job,role:'target'});
      while((await target.prepareStep(id,{limit:2,bytes:700})).phase==='preparing'){}
      await rejects(()=>source.normal('putChatMeta',{chatKey:'blocked'}));
      let after=0,batches=0,summary;
      while(true) {
        const packet=await source.sourceNext(id,after,{limit:2,bytes:700});
        if(packet.done){summary=packet.summary;break;}
        assert(packet.rows.length<=2,'分页失去数量限制');
        if(!after) {
          if(to==='sqlite')await rejects(()=>rpc('append',[id,packet],true));
          else await target.append(id,packet); // Intentionally discard the result.
          assert((await target.status(id)).verified===0,'写入被误记为验货完成');
          await source.reopen();await target.reopen();
          const retry=await source.sourceNext(id,0);assert(stableText(retry)===stableText(packet),'来源重发内容变化');
          await target.append(id,retry);
          await rejects(()=>target.normal('getChatMeta','source'));
          if(to==='indexeddb') {
            const original=packet.rows[0];
            await local.rawPut({...original,value:{...original.value,fixtureCorrupt:true}});
            await rejects(()=>target.verifyBatch(id,1));assert((await target.status(id)).verified===0,'坏内容被登记为已验货');
            await local.rawPut(original);
            failCheckpoint=true;await rejects(()=>target.verifyBatch(id,1));
            assert((await target.status(id)).verified===0,'失败事务累计进度');
            assert((await local.readMeta(batchKey(id,1))).value.phase==='written','失败事务没有回滚批次回执');
          }
        }else await target.append(id,packet);
        await target.verifyBatch(id,packet.index);
        const verified=(await target.status(id)).verified;assert(verified===packet.last,'进度不是已核验数量');
        await target.verifyBatch(id,packet.index);assert((await target.status(id)).verified===verified,'重复验货累计了两次');
        after=packet.index;batches++;
      }
      await target.startSeal(id,summary);let steps=0,state;
      do{state=await target.sealStep(id,{limit:2,bytes:700});assert(++steps<100,'验收没有推进');}while(state.phase==='checking');
      assert(state.phase==='verified'&&batches>2&&steps>2,'未执行分批验收');
      assert(stableText(normalized(await source.peek(0)))===stableText(sourceBefore),'来源备份被修改');
      assert(stableText(normalized(await target.peek(0)))===stableText(targetBefore),'旧目标被提前替换');
      assert(stableText(normalized(await target.peek(1)))===stableText(sourceBefore),'跨驱动迁移内容不一致');
      await target.activate(id,summary);await target.unlock(id);
      assert((await target.normal('getFullMessages','source')).length===5,'启用后正常正文读取失败');
      const saved=await readSnapshot({getSnapshotHeader:(...args)=>target.normal('getSnapshotHeader',...args),getSnapshotMessages:(...args)=>target.normal('getSnapshotMessages',...args)},snapshot.header.id);
      assert(stableText(saved.chat)===stableText(current.chat),'启用后快照预览内容不同');
      assert(stableText(normalized(await target.peek(0)))===stableText(targetBefore),'轻量启用损坏旧目标');
      checks.push({direction:`${from} → ${to}`,batches,sealSteps:steps,verified:summary.count,counts:summary.counts,responseLoss:to==='sqlite'?'HTTP响应实际丢失后重试':'丢弃本地返回值后重试',reopened:true});
    }finally{
      assert(name.startsWith('boxed-1.0.1-test-'),'数据库名范围错误');await request(indexedDB.deleteDatabase(name));
    }
  }
  return {checks};
}
