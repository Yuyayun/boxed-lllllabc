import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagedStorage, createOperationGate } from '../src/storage/managed.js';
import { createTransferCoordinator } from '../src/storage/transfer.js';
import { digestRow, readTransferManifest } from '../src/storage/transfer-format.js';
import { createStorageController } from '../src/controllers/storage-controller.js';
import { createRestoreController } from '../src/controllers/restore-controller.js';
import { createCatalogController } from '../src/controllers/catalog-controller.js';
import { createPanelController } from '../src/controllers/panel-controller.js';

const controlWith = (initial) => { let state={active:'indexeddb',previous:null,lastTransfer:null,journal:null,...initial}; return {read:async()=>structuredClone(state),update:async(fn)=>(state=fn(structuredClone(state)))}; };
test('活动端来自持久控制记录，发现 SQLite 不会改变活动端；SQLite 故障没有回退',async()=>{
  const control=controlWith(); let local=0,remote=0;
  const storage=createManagedStorage({control,locks:null,adapters:{indexeddb:{open:async()=>{local++;return {close(){}};}},sqlite:{open:async()=>{remote++;throw new Error('只读');}}}});
  (await storage.open()).close(); assert.equal(storage.getMode(),'indexeddb'); assert.equal(remote,0);
  await control.update((s)=>({...s,active:'sqlite'}));
  await assert.rejects(storage.open(),/只读/); assert.equal(local,1); assert.equal(remote,1);
  await control.update((s)=>({...s,journal:{id:'unfinished'}}));
  await assert.rejects(storage.open(),/未完成/); assert.equal(remote,1);
});
test('会话持有共享跨页签锁至 close；排他锁被占用时拒绝打开',async()=>{
  let occupied=false,completed=false;
  const locks={request:async(_name,options,fn)=>{assert.equal(options.mode,'shared'); assert.equal(options.ifAvailable,true);if(occupied)return fn(null);occupied=true;await fn({});occupied=false;completed=true;}};
  const storage=createManagedStorage({control:controlWith(),locks,adapters:{indexeddb:{open:async()=>({close(){}})}}});
  const session=await storage.open();assert.equal(completed,false);await assert.rejects(storage.open(),/正在切换/);session.close();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(completed,true);
});
test('写任务门等候已有恢复结束，暂停时拒绝新的恢复或清理，恢复后重新开放',async()=>{
  const gate=createOperationGate();let finish;const run=gate.run(()=>new Promise(resolve=>{finish=resolve;}));let drained=false;
  const pause=gate.pause().then(()=>{drained=true;});await Promise.resolve();assert.equal(drained,false);
  await assert.rejects(gate.run(async()=>{}),/锁定/);finish();await run;await pause;assert.equal(drained,true);gate.resume();assert.equal(await gate.run(async()=>42),42);
});
test('暂停期间已打开窗口的恢复、保存、清理和冻结处理确认入口也拒绝执行',async()=>{
  const gate=createOperationGate();await gate.pause();let reads=0;
  const options={runGuard:gate.run,storage:{open:async()=>{reads++;throw new Error('不得打开数据库');}},getContextReader:()=>{throw new Error('不得修改原生聊天');}};
  const restore=createRestoreController(options),catalog=createCatalogController(options),panel=createPanelController(options);
  for(const result of await Promise.all([restore.confirmRestore({}),restore.requestSave({}),catalog.executeCleanup({}),panel.executeFrozenResolution({},'adopt-current')])){assert.equal(result.ok,false);assert.match(result.reason,/锁定/);}
  assert.equal(reads,0);
});
test('迁移必须确认、持有浏览器锁，目标不可用时不建立任务或改变活动端',async()=>{
  const control=controlWith();const adapters={indexeddb:{},sqlite:{status:async()=>({ok:false,reason:'多账户禁止'})}};
  const coordinator=createTransferCoordinator({control,adapters,locks:{request:async(_n,_o,fn)=>fn()}});
  await assert.rejects(coordinator.switchTo('sqlite'),/确认/);
  await assert.rejects(coordinator.switchTo('sqlite',{confirmed:true}),/多账户/);
  assert.equal((await control.read()).journal,null);assert.equal((await control.read()).active,'indexeddb');
  await assert.rejects(coordinator.clearInactive('indexeddb',{confirmed:true}),/当前正在使用的备份位置/);
  await assert.rejects(coordinator.clearInactive('sqlite',{confirmed:true}),/没有已确认可清空的原存储位置/);
  await assert.rejects(createTransferCoordinator({control,adapters,locks:null}).switchTo('sqlite',{confirmed:true}),/跨页签/);
});
test('恢复按持久激活记录选择收尾或回滚；后端失联保留任务且不解除暂停',async()=>{
  for(const phase of ['working','activated']){
    const calls=[];let resumed=0;const control=controlWith({active:phase==='activated'?'sqlite':'indexeddb',journal:{id:'recover-123',kind:'switch',from:'indexeddb',to:'sqlite',phase}});
    const adapters=Object.fromEntries(['indexeddb','sqlite'].map(mode=>[mode,{transfer:async(action)=>{calls.push([mode,action]);return {phase:'committed'};}}]));
    const coordinator=createTransferCoordinator({control,adapters,locks:{request:async(_n,_o,fn)=>fn()},resume:async()=>{resumed++;}});
    await coordinator.recover();assert.equal((await control.read()).journal,null);assert.equal(resumed,1);
    assert.deepEqual(calls.map(c=>c[1]),['status',phase==='activated'?'finish':'rollback',phase==='activated'?'finish':'rollback']);
  }
  const control=controlWith({journal:{id:'recover-123',kind:'switch',from:'indexeddb',to:'sqlite',phase:'working'}});let resumed=false;
  await assert.rejects(createTransferCoordinator({control,adapters:{sqlite:{transfer:async()=>{throw new Error('断网');}}},locks:{request:async(_n,_o,fn)=>fn()},resume:async()=>{resumed=true;}}).recover(),/断网/);
  assert.ok((await control.read()).journal);assert.equal(resumed,false);
});
test('清单校验所有仓库、序号、主键和关联；属性顺序不影响摘要，原始特殊字段保留',async()=>{
  const rows=[{n:1,store:'chat_meta',key:'chat',value:{chatKey:'chat',frozen:{state:'awaiting-confirmation'}}},{n:2,store:'full_messages',key:['chat',0],value:{chatKey:'chat',messageIndex:0,raw:{swipes:['a','b'],swipe_id:1,date:new Date(0),empty:undefined}}}];
  const manifest=await readTransferManifest(async after=>after?[]:rows);assert.equal(manifest.count,2);assert.equal(manifest.counts.pending_changes,0);
  assert.equal(await digestRow(rows[1]),await digestRow({...rows[1],value:{raw:rows[1].value.raw,messageIndex:0,chatKey:'chat'}}));
  for(const bad of [{...rows[1],n:1},{...rows[1],store:'snapshots-unknown'},{...rows[1],key:['chat',9]},{...rows[1],value:{...rows[1].value,chatKey:'orphan'},key:['orphan',0]}]) await assert.rejects(readTransferManifest(async after=>after?[]:[rows[0],bad]));
  await assert.rejects(readTransferManifest(async after=>after?[]:[{...rows[0],digest:'wrong'}]),/摘要/);
});
test('SQLite 占用读取服务器统计，不调用浏览器配额或全量目录',async()=>{
  let rendered;const controller=createStorageController({storage:{getMode:()=> 'sqlite',refresh:async()=>{},status:async()=>({ok:true,database:{bytes:2048,counts:[{bytes:100},{bytes:200}]}}),open:async()=>{throw new Error('不应读取目录');}},estimateStorage:async()=>{throw new Error('不应使用浏览器配额');},renderOverview:s=>{rendered=s;}});
  await controller.refresh();assert.equal(rendered.mode,'sqlite');assert.equal(rendered.extensionBytes,300);assert.equal(rendered.databaseBytes,2048);assert.equal(rendered.estimate.supported,undefined);
});
