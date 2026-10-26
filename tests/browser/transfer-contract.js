import {createIndexedDbStorage} from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/indexeddb-adapter.js';
import {createSqliteStorage} from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/sqlite-client.js';
import {createStorageControl} from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/control.js';
import {createTransferCoordinator} from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/transfer.js';
import {createManagedStorage,STORAGE_LOCK} from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/managed.js';
import {emptyManifest,recordText} from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/transfer-format.js';
import {openBackupDatabase} from '/scripts/extensions/third-party/boxed-lllllabc/src/db/index.js';
import {DATA_STORES} from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/transfer-format.js';
import {migrateDatabase} from '/scripts/extensions/third-party/boxed-lllllabc/src/db/migration.js';

export async function runTransferContract({large=false}={}) {
  if(location.origin!=='http://127.0.0.1:18000')throw new Error('仅允许隔离实例');
  const checks=[];const assert=(condition,message='验收失败')=>{if(!condition)throw new Error(message);};
  const reject=async(fn,message)=>{let rejected=false;try{await fn();}catch{rejected=true;}assert(rejected,message);};
  const token=(await(await fetch('/csrf-token')).json()).token;
  const adapters={indexeddb:createIndexedDbStorage(),sqlite:createSqliteStorage({getRequestHeaders:()=>({'X-CSRF-Token':token})})};
  const control=createStorageControl();
  const coordinator=(options={})=>createTransferCoordinator({control,adapters,...options});
  const clear=async(mode)=>{const id=crypto.randomUUID();await adapters[mode].transfer('prepare',{id,manifest:await emptyManifest()});await adapters[mode].transfer('seal',{id});await adapters[mode].transfer('commit',{id});assert((await adapters[mode].transfer('check',{id,after:0})).done);await adapters[mode].transfer('finish',{id});};
  const read=async(mode)=>{const id=crypto.randomUUID();try{await adapters[mode].transfer('source',{id});let after=0;const rows=[];while(true){const page=await adapters[mode].transfer('page',{id,after});if(!page.length)break;rows.push(...page.map(recordText));after=page.at(-1).n;}return rows.sort();}finally{await adapters[mode].transfer('rollback',{id});}};
  const equal=async(mode,expected)=>assert(JSON.stringify(await read(mode))===JSON.stringify(expected),`${mode} 正式数据有损或被意外修改`);
  const seed=async(mode,name,count=2,bodySize=30)=>{
    const session=await adapters[mode].open();const key=`character:isolated-p3.png:${name}`;
    try{
      await session.putChatMeta({chatKey:key,chatIntegrity:'shared-legacy-uuid',fullBackupState:'frozen',fullBackupIncident:{reason:'shorter'},alias:{old:'keep'},date:new Date(0)});
      for(let start=0;start<count;start+=20){const messages=Array.from({length:Math.min(20,count-start)},(_,offset)=>({chatKey:key,messageIndex:start+offset,raw:{mes:`${name}-${start+offset}:`+'中'.repeat(bodySize),swipes:['甲','乙'],swipe_id:1,extra:{missing:undefined,empty:null,date:new Date(0)}}}));await session.putFullMessages({chatKey:key,messages,meta:{chatKey:key}});}
      await session.replaceRecentSnapshot({meta:{chatKey:key},messages:[{chatKey:key,messageIndex:0,raw:{mes:'recent'}}]});
      await session.putHistoricalChanges([{chatKey:key,messageIndex:0,raw:{mes:'history'},firstCapturedAt:'retained'}]);
      await session.putPendingChanges([{id:key+':structure',chatKey:key,messageIndex:null,kind:'chat_structure',raw:{order:[1,0]},required:true}]);
      await session.putChatMeta({chatKey:key,chatIntegrity:'shared-legacy-uuid',fullBackupState:'frozen',fullBackupIncident:{reason:'shorter'},alias:{old:'keep'},date:new Date(0)});
    }finally{session.close();}
  };
  await coordinator().recover();
  await clear('indexeddb');await clear('sqlite');await control.update(()=>({active:'indexeddb',previous:null,lastTransfer:null,journal:null}));
  await seed('indexeddb','source');await seed('sqlite','old-target');
  const source=await read('indexeddb'),oldTarget=await read('sqlite');
  assert((await control.read()).active==='indexeddb');assert((await adapters.sqlite.status()).ok);assert((await control.read()).active==='indexeddb');
  await coordinator().switchTo('sqlite',{confirmed:true});await equal('sqlite',source);await equal('indexeddb',source);
  assert((await control.read()).active==='sqlite');checks.push('IndexedDB→SQLite 完整覆盖旧目标、四类记录/冻结/身份及特殊字段无损，来源保留');
  await seed('sqlite','new-remote');const remoteSource=await read('sqlite');
  await coordinator().switchTo('indexeddb',{confirmed:true});await equal('indexeddb',remoteSource);await equal('sqlite',remoteSource);
  checks.push('SQLite→IndexedDB 双向完整替换，活动端仅提交后切换');
  await reject(()=>coordinator().clearInactive('indexeddb',{confirmed:true}),'不应清空活动端');
  await reject(()=>coordinator().clearInactive('sqlite'),'未确认不应清空');
  localStorage.setItem('p3-keep-settings','retained');await coordinator().clearInactive('sqlite',{confirmed:true});assert((await read('sqlite')).length===0);await equal('indexeddb',remoteSource);assert(localStorage.getItem('p3-keep-settings')==='retained');
  checks.push('清空旧端独立确认，禁止活动端，清空后读回验证且保留活动数据和设置');
  for(const from of ['indexeddb','sqlite'])for(const phase of ['source','append','verified','committed','activated']){
    const to=from==='indexeddb'?'sqlite':'indexeddb';
    await clear(from);await clear(to);await control.update(()=>({active:from,previous:null,lastTransfer:null,journal:null}));
    await seed(from,'fault-source');await seed(to,'fault-target');const beforeSource=await read(from),beforeTarget=await read(to);
    await reject(()=>coordinator({hook:async(point)=>{if(point===phase)throw Object.assign(new Error('模拟浏览器崩溃'),{simulateCrash:true});}}).switchTo(to,{confirmed:true}),'故障注入未触发');
    assert((await control.read()).journal,'中断任务必须持久化');
    await reject(()=>createManagedStorage({control,adapters}).open(),'未恢复时不应读写');
    // Create fresh control/coordinator instances, discarding all coordinator state.
    await createTransferCoordinator({control:createStorageControl(),adapters}).recover();
    const activated=phase==='activated';assert((await control.read()).active===(activated?to:from));await equal(from,beforeSource);await equal(to,activated?beforeSource:beforeTarget);assert(!(await control.read()).journal);
    checks.push(`${from}→${to} ${phase} 中断后根据持久记录${activated?'完成激活收尾':'回滚原目标'}，来源完整`);
  }
  await clear('indexeddb');await clear('sqlite');await control.update(()=>({active:'indexeddb',previous:null,lastTransfer:null,journal:null}));await seed('indexeddb','net-source');await seed('sqlite','net-target');
  const beforeNetwork=await read('sqlite');let lost=true;
  const unstable={...adapters,sqlite:{...adapters.sqlite,transfer:async(action,args)=>{const value=await adapters.sqlite.transfer(action,args);if(action==='commit'&&lost){lost=false;throw new Error('提交成功但响应丢失');}return value;}}};
  await reject(()=>createTransferCoordinator({control,adapters:unstable}).switchTo('sqlite',{confirmed:true}));await equal('sqlite',beforeNetwork);assert((await control.read()).active==='indexeddb');
  checks.push('真实提交成功后响应丢失，按事务回执恢复原目标，活动端不变');
  await reject(()=>coordinator({validate:async()=>{throw new Error('检测到聊天变化');}}).switchTo('sqlite',{confirmed:true}));await equal('sqlite',beforeNetwork);
  checks.push('提交前检测到聊天变化，保留原目标和活动端');
  const id=crypto.randomUUID();await adapters.indexeddb.transfer('source',{id});
  await reject(async()=>{const s=await adapters.indexeddb.open();try{await s.putChatMeta({chatKey:'should-not-write'});}finally{s.close();}});await adapters.indexeddb.transfer('rollback',{id});
  await navigator.locks.request(STORAGE_LOCK,{mode:'exclusive'},async()=>{await reject(()=>createManagedStorage({control,adapters}).open());});
  checks.push('持久来源锁拒绝普通写入，跨页签排他锁拒绝新存储会话');
  // Deliberately malformed raw rows must stop a full transfer rather than disappear in catalog filtering.
  const db=await openBackupDatabase();await new Promise((resolve,reject)=>{const tx=db.transaction('recent_messages','readwrite');tx.objectStore('recent_messages').put({chatKey:'orphan',messageIndex:99,raw:{mes:'must-retain'}});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
  const malformed=await read('indexeddb');await reject(()=>coordinator().switchTo('sqlite',{confirmed:true}));await equal('indexeddb',malformed);await equal('sqlite',beforeNetwork);
  checks.push('孤立原始记录使迁移中止，未过滤或删除原记录，原目标完整');
  await clear('indexeddb');await clear('sqlite');
  await control.update(()=>({active:'sqlite',journal:null,previous:null,lastTransfer:null}));await seed('sqlite','quota-source');await seed('indexeddb','quota-target');
  const beforeAbortSource=await read('sqlite'),beforeAbortTarget=await read('indexeddb');
  const originalPut=IDBObjectStore.prototype.put;let inject=true;
  IDBObjectStore.prototype.put=function(...args){if(inject&&this.name==='full_messages'){inject=false;throw new DOMException('P3 simulated quota failure during formal replacement','QuotaExceededError');}return originalPut.apply(this,args);};
  try{await reject(()=>coordinator().switchTo('indexeddb',{confirmed:true}));}finally{IDBObjectStore.prototype.put=originalPut;}
  await equal('sqlite',beforeAbortSource);await equal('indexeddb',beforeAbortTarget);assert((await control.read()).active==='sqlite');
  checks.push('IndexedDB 正式替换中途注入配额异常，真实事务回滚删除与写入，两端原数据完整');
  await clear('indexeddb');await clear('sqlite');await control.update(()=>({active:'indexeddb',journal:null,previous:null,lastTransfer:null}));
  await seed('sqlite','empty-target');await coordinator().switchTo('sqlite',{confirmed:true});assert((await read('sqlite')).length===0);
  await seed('indexeddb','empty-target');await coordinator().switchTo('indexeddb',{confirmed:true});assert((await read('indexeddb')).length===0);
  checks.push('空来源也按完整替换处理，两方向均清除目标旧记录后激活');
  const openUnknown=()=>new Promise((resolve,reject)=>{const request=indexedDB.open('boxed-p3-unknown',1);request.onupgradeneeded=()=>{migrateDatabase(request.result,request.transaction);request.result.createObjectStore('unknown_future_store').put({keep:'unknown'},1);};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  const unknown=createIndexedDbStorage({openDatabase:openUnknown});await control.update(()=>({active:'indexeddb',journal:null,previous:null,lastTransfer:null}));
  await reject(()=>createTransferCoordinator({control,adapters:{...adapters,indexeddb:unknown}}).switchTo('sqlite',{confirmed:true}));assert(!(await control.read()).journal,'未知仓库拒绝后应完成安全收尾');
  const unknownDb=await openUnknown();const kept=await new Promise(resolve=>{const r=unknownDb.transaction('unknown_future_store').objectStore('unknown_future_store').get(1);r.onsuccess=()=>resolve(r.result);});unknownDb.close();assert(kept.keep==='unknown');
  checks.push('未知数据仓库拒绝迁移并保留未知记录，未留下伪未完成任务');
  if(large){
    await seed('indexeddb','large',360,33000);let pages=0;
    const started=performance.now();await coordinator({hook:async(point)=>{if(point==='append')pages++;}}).switchTo('sqlite',{confirmed:true});
    assert(pages>15);const session=await adapters.sqlite.open();let limited=false;try{await session.getFullMessages('character:isolated-p3.png:large');}catch{limited=true;}finally{session.close();}assert(limited,'测试数据应超过普通整包读取限额');
    await coordinator().switchTo('indexeddb',{confirmed:true});const local=await adapters.indexeddb.open();try{const rows=await local.getFullMessages('character:isolated-p3.png:large');assert(rows.length===360&&rows[359].raw.mes.endsWith('中'.repeat(33000)));}finally{local.close();}
    checks.push(`超过普通 32MiB 读取限额的完整备份双向分页切换成功，出站 ${pages} 批，耗时 ${Math.round(performance.now()-started)}ms`);
  }
  return {checks,oldTargetCount:oldTarget.length,active:(await control.read()).active};
}

export async function restartTransfer(phase,prepare) {
  if(location.origin!=='http://127.0.0.1:18000')throw new Error('仅允许隔离实例');
  const token=(await(await fetch('/csrf-token')).json()).token;
  const adapters={indexeddb:createIndexedDbStorage(),sqlite:createSqliteStorage({getRequestHeaders:()=>({'X-CSRF-Token':token})})};const control=createStorageControl();
  const snapshot=async(mode)=>{const id=crypto.randomUUID();try{await adapters[mode].transfer('source',{id});const rows=await adapters[mode].transfer('page',{id,after:0});return rows.map(recordText).sort();}finally{await adapters[mode].transfer('rollback',{id});}};
  if(prepare){
    for(const mode of ['indexeddb','sqlite']){const id=crypto.randomUUID();await adapters[mode].transfer('prepare',{id,manifest:await emptyManifest()});await adapters[mode].transfer('seal',{id});await adapters[mode].transfer('commit',{id});await adapters[mode].transfer('finish',{id});const s=await adapters[mode].open();try{await s.putChatMeta({chatKey:mode,raw:{keep:mode,date:new Date(0)}});}finally{s.close();}}
    await control.update(()=>({active:'indexeddb',journal:null,previous:null,lastTransfer:null}));
    localStorage.setItem('p3-restart-expected',JSON.stringify({source:await snapshot('indexeddb'),target:await snapshot('sqlite')}));
    try{await createTransferCoordinator({control,adapters,hook:async(point)=>{if(point===phase)throw Object.assign(new Error('模拟关闭'),{simulateCrash:true});}}).switchTo('sqlite',{confirmed:true});}catch(error){if(!error.simulateCrash)throw error;}
    if(!(await control.read()).journal)throw new Error('缺少持久中断记录');return {phase,prepared:true};
  }
  await createTransferCoordinator({control,adapters}).recover();const expected=JSON.parse(localStorage.getItem('p3-restart-expected'));const state=await control.read();
  if(state.journal||state.active!==(phase==='activated'?'sqlite':'indexeddb')||JSON.stringify(await snapshot('indexeddb'))!==JSON.stringify(expected.source)||JSON.stringify(await snapshot('sqlite'))!==JSON.stringify(phase==='activated'?expected.source:expected.target))throw new Error('重启恢复数据或活动标记不一致');
  return {phase,recovered:true,active:state.active};
}
