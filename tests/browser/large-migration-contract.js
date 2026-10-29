// Imported only by run-large-migration-contract.mjs into a disposable full host.
import {createIndexedDbStorage} from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/indexeddb-adapter.js';
import {createSqliteStorage} from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/sqlite-client.js';
import {createStorageControl} from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/control.js';
import {createTransferCoordinator} from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/transfer.js';
import {DATA_STORES,inspectTransferRow,sha256} from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/transfer-format.js';
import {stableText} from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/value-digest.js';
import {captureSnapshot} from '/scripts/extensions/third-party/boxed-lllllabc/src/snapshots/model.js';
import {readSnapshot,snapshotBatches} from '/scripts/extensions/third-party/boxed-lllllabc/src/snapshots/service.js';

const assert=(condition,message)=>{if(!condition)throw new Error(message);};
export async function installLargeMigrationContract({nonce,origin,chats=175,snapshots=44,bodyBytes}){
  assert(location.origin===origin&&location.hostname==='127.0.0.1','Disposable origin required');
  const marker=await (await fetch('/boxed-stage5/authorization.json')).json();assert(marker.nonce===nonce&&marker.purpose==='boxed-stage5-disposable','Disposable marker missing');
  const st=await import('/script.js'),ext=await import('/scripts/extensions.js');ext.extension_settings['boxed-lllllabc'].enabled=false;st.saveSettingsDebounced();
  let csrf=(await (await fetch('/csrf-token')).json()).token;
  const transport={requests:0,maxRequestBytes:0,routes:{}},methods={},stages=[],snapshotsSaved=[],keys=Array.from({length:chats},(_,i)=>`character:stage5-${i}.png:chat-${i}`);
  const control=createStorageControl(),timings={};let golden,sourceSummary,lastStage,caseStarted=performance.now(),interruptAt=0,largeTargetOriginal,largeTargetRefs;
  const progress=(stage,count,total,message)=>{globalThis.stage5Progress={stage,count,total,message,elapsedMs:Math.round(performance.now()-caseStarted)};};
  const use=async(mode,fn)=>{const session=await adapters[mode].open();try{return await fn(session);}finally{session.close();}};
  const rawAdapters={indexeddb:createIndexedDbStorage(),sqlite:createSqliteStorage({getRequestHeaders:()=>({'X-CSRF-Token':csrf}),fetchImpl:(url,options)=>{
    if(options.body){transport.requests++;transport.maxRequestBytes=Math.max(transport.maxRequestBytes,new TextEncoder().encode(options.body).byteLength);}const route=String(url).split('/boxed-lllllabc/')[1],metric=transport.routes[route]??={calls:0,ms:0};metric.calls++;const started=performance.now();return fetch(url,options).finally(()=>{metric.ms+=performance.now()-started;});
  },onProgress:state=>{if(globalThis.stage5Progress?.stage==='restart')progress('restart',state.count,expectedCount,state.stage);}})};
  const adapters=Object.fromEntries(Object.entries(rawAdapters).map(([mode,adapter])=>[mode,{...adapter,batchTransfer:async(action,args)=>{
    const start=performance.now();const result=await adapter.batchTransfer(action,args);const ms=performance.now()-start,key=mode+':'+action,entry=methods[key]??={calls:0,totalMs:0,maxMs:0};entry.calls++;entry.totalMs+=ms;entry.maxMs=Math.max(entry.maxMs,ms);
    if(action==='append'){entry.maxBatchRows=Math.max(entry.maxBatchRows??0,args[1].rows.length);entry.maxBatchBytes=Math.max(entry.maxBatchBytes??0,args[1].bytes);assert(args[1].rows.length<=100&&(args[1].rows.length===1||args[1].bytes<=2*1024*1024),'Unbounded migration batch');}
    if(action==='commit')entry.maxCommitArgumentBytes=Math.max(entry.maxCommitArgumentBytes??0,new TextEncoder().encode(stableText(args)).byteLength);
    return result;
  }}]));
  const expectedCount=chats*25+snapshots*4;
  const coordinator=createTransferCoordinator({control,adapters,progress:message=>{const match=message.match(/(\d+)\s*\/\s*(\d+)/);progress(lastStage??'migration',match?Number(match[1]):undefined,match?Number(match[2]):expectedCount,message);},hook:async(stage,journal)=>{
    if(stage!==lastStage){stages.push({stage,ms:Math.round(performance.now()-caseStarted),taskId:journal.id});lastStage=stage;}if(journal.manifest){assert(journal.manifest.count===expectedCount,'Migration count differs from seeded count');sourceSummary=journal.manifest;}
    if(interruptAt&&stage==='batch-verified'&&globalThis.stage5Progress?.count>=interruptAt)throw Object.assign(new Error('Synthetic large migration boundary interruption'),{simulateCrash:true});
  }});
  async function measure(name,fn){const start=performance.now();const result=await fn();timings[name]=Math.round(performance.now()-start);return result;}
  function randomPool(){const bytes=new Uint8Array(262144);for(let n=0;n<bytes.length;n+=65536)crypto.getRandomValues(bytes.subarray(n,n+65536));let text='';for(let n=0;n<bytes.length;n+=16384)text+=String.fromCharCode(...bytes.subarray(n,n+16384));return btoa(text);}
  async function seed(){
    const state=await control.read();assert(state.active==='indexeddb'&&!state.journal,'Fresh IndexedDB control required');const remote=await adapters.sqlite.status();assert(remote.ok&&remote.database.counts.reduce((sum,r)=>sum+r.count,0)===0,'Fresh SQLite required');
    const existing=await use('indexeddb',s=>s.getBackupCatalog());assert(existing.chatCount===0,'Fresh IndexedDB required');
    const pool=randomPool(),bodyCount=chats*24+snapshots*3,bodyLength=Math.ceil(bodyBytes/bodyCount);
    assert(bodyLength<pool.length,'Fixture record budget exceeded');let serial=0;
    const body=()=>{const marker=`synthetic-${serial++}:`,offset=serial*7919%(pool.length-bodyLength);return marker+pool.slice(offset,offset+bodyLength);};
    await use('indexeddb',async session=>{
      for(let i=0;i<chats;i++){
        const chatKey=keys[i],meta={chatKey,characterAvatar:`stage5-${i}.png`,characterName:`虚构测试角色${i}`,chatDisplayName:`虚构测试聊天${i}`,fullBackupState:i%5===0?'frozen':'active',date:new Date(0),optional:undefined};
        const row=messageIndex=>({chatKey,messageIndex,raw:{mes:body(),swipes:['synthetic-a','synthetic-b'],swipe_id:1,date:new Date(0),optional:undefined,extra:{fixture:true}},backedUpAt:new Date(0).toISOString()});
        await session.replaceRecentSnapshot({meta,messages:Array.from({length:5},(_,n)=>row(20+n))});
        await session.putFullMessages({chatKey,meta,messages:Array.from({length:16},(_,n)=>row(n))});
        await session.putHistoricalChanges([row(0),row(1)]);await session.putPendingChanges([{...row(null),id:`stage5-pending-${i}`,kind:'structure',canonicalHash:'synthetic'}]);
        progress('seed',i+1,chats,'逐聊天生成合成数据');
      }
      for(let i=0;i<snapshots;i++){
        const current={ok:true,identity:{chatKey:keys[i%chats]},chat:Array.from({length:3},()=>({mes:body(),date:new Date(0),optional:undefined})),context:{chatMetadata:{fixture:true,index:i}}};
        const snapshot=await captureSnapshot(current,{name:`合成快照 ${i}`,now:new Date(0).toISOString()});await session.beginSnapshot({header:snapshot.header,identityMeta:{chatKey:current.identity.chatKey}});for(const messages of snapshotBatches(snapshot.messages))await session.appendSnapshotMessages({id:snapshot.header.id,messages});await session.publishSnapshot({id:snapshot.header.id});snapshotsSaved.push(snapshot.header.id);
      }
    });return {chats,snapshots,records:expectedCount,requestedBodyBytes:bodyBytes,generatedBodyBytes:serial*bodyLength,bodyLength};
  }
  async function audit(mode,name,expected){
    const refs=new Map(),counts=Object.fromEntries(DATA_STORES.map(name=>[name,0])),listedSnapshots=[];let bytes=0,count=0;
    const record=async(store,value)=>{
      const key=store==='chat_meta'?value.chatKey:['snapshots','pending_changes'].includes(store)?value.id:store==='snapshot_messages'?[value.snapshotId,value.messageIndex]:[value.chatKey,value.messageIndex];
      const inspected=inspectTransferRow({store,key,value,n:1}),id=stableText([store,key]),hash=await sha256(inspected.text);assert(!refs.has(id),'Duplicate actual record');if(expected)assert(expected.get(id)===hash,`Independent content mismatch: ${mode}/${store}`);refs.set(id,hash);counts[store]++;count++;bytes+=inspected.bytes;
    };
    await measure(name,()=>use(mode,async session=>{
      for(let i=0;i<keys.length;i++){
        await record('chat_meta',await session.getChatMeta(keys[i]));for(const [store,operation] of [['recent_messages','getRecentMessages'],['full_messages','getFullMessages'],['historical_changes','getHistoricalChanges'],['pending_changes','getPendingChanges']])for(const value of await session[operation](keys[i]))await record(store,value);
        progress(name,count,expectedCount,'独立逐键内容核对');
      }
      let after='';do{const page=await session.listSnapshots({after});for(const item of page.items){listedSnapshots.push(item.id);const header=await session.getSnapshotHeader(item.id);await record('snapshots',header);let at=-1;while(true){const rows=await session.getSnapshotMessages({id:header.id,after:at});if(!rows.length)break;for(const row of rows)await record('snapshot_messages',row);at=rows.at(-1).messageIndex;}}after=page.after;}while(after);
      const ids=snapshotsSaved.length?snapshotsSaved:listedSnapshots;for(const id of [ids[0],ids.at(-1)].filter(Boolean)){const preview=await readSnapshot(session,id);assert(preview.chat.length===3,'Snapshot preview failed');}
    }));assert(count===expectedCount&&(!expected||refs.size===expected.size),'Independent total mismatch');return {refs,summary:{count,counts,bytes,digest:await sha256(JSON.stringify([...refs].sort((a,b)=>a[0].localeCompare(b[0]))))}};
  }
  async function writeProbe(mode){await use(mode,async session=>{const meta=await session.getChatMeta(keys[0]);await session.putChatMeta({...meta,stage5WriteProbe:true});assert((await session.getChatMeta(keys[0])).stage5WriteProbe===true,'Post-migration write failed');await session.putChatMeta(meta);});}
  const run=async()=>{
    const seeded=await measure('seed',seed),before=await audit('indexeddb','audit-before');golden=before.refs;
    await measure('to-sqlite',()=>coordinator.switchTo('sqlite',{confirmed:true}));assert((await control.read()).active==='sqlite'&&!(await control.read()).journal,'SQLite activation incomplete');
    const target=await audit('sqlite','audit-sqlite',golden),source=await audit('indexeddb','audit-retained-idb',golden);await writeProbe('sqlite');
    await measure('to-indexeddb',()=>coordinator.switchTo('indexeddb',{confirmed:true}));assert((await control.read()).active==='indexeddb'&&!(await control.read()).journal,'IndexedDB activation incomplete');
    const returned=await audit('indexeddb','audit-returned-idb',golden),retained=await audit('sqlite','audit-retained-sqlite',golden);await writeProbe('indexeddb');
    assert([target,source,returned,retained].every(x=>x.summary.digest===before.summary.digest),'Roundtrip changed content');
    progress('complete',expectedCount,expectedCount,'双向迁移与独立校验通过');return {seeded,source:before.summary,manifest:sourceSummary,timings,methods,stages,transport,active:(await control.read()).active,allContentEqual:true,sourceRetained:true,postMigrationWrites:true};
  };
  const restartCheck=async()=>{progress('restart',0,expectedCount,'等待真实服务器重启后检查');csrf=(await(await fetch('/csrf-token')).json()).token;const start=performance.now(),health=await adapters.sqlite.status();assert(health.ok,health.reason);assert(health.database.counts.reduce((n,r)=>n+r.count,0)===expectedCount,'Restart count mismatch');const result=await audit('sqlite','audit-restarted-sqlite',golden);progress('restarted',expectedCount,expectedCount,'重启后内容一致');return {elapsedMs:Math.round(performance.now()-start),summary:result.summary,health:health.database};};
  let estimateOriginal,capacityTarget;
  const prepareCapacity=async()=>{await coordinator.switchTo('sqlite',{confirmed:true});await use('indexeddb',async session=>{const meta=await session.getChatMeta(keys[0]);await session.putChatMeta({...meta,capacityOldTargetSentinel:'preserve-distinct-old-target'});});capacityTarget=(await audit('indexeddb','capacity-target-before')).refs;return navigator.storage.estimate();};
  const quotaEstimate=low=>{if(low){estimateOriginal=navigator.storage.estimate;navigator.storage.estimate=async()=>{const estimate=await estimateOriginal.call(navigator.storage);return {...estimate,quota:estimate.usage+1024*1024};};}else if(estimateOriginal){navigator.storage.estimate=estimateOriginal;estimateOriginal=null;}};
  const expectCapacityRefusal=async()=>{let reason,name;try{await coordinator.switchTo('indexeddb',{confirmed:true});}catch(error){reason=error.message;name=error.name;}return {reason,name,preflight:reason?.includes('配额不足')??false,estimate:await navigator.storage.estimate(),state:await control.read()};};
  const restoreCapacity=async()=>{const state=await control.read();if(state.journal){assert(state.journal.phase!=='activated','Quota failure after activation requires separate finish acceptance');await coordinator.abandon({confirmed:true});}const source=await audit('sqlite','capacity-source-retained',golden),target=await audit('indexeddb','capacity-old-target-retained',capacityTarget);assert(source.summary.digest!==target.summary.digest,'Distinct old-target sentinel missing');await coordinator.switchTo('indexeddb',{confirmed:true});return {source:source.summary,target:target.summary,distinctTargetPreserved:true};};
  const injectedQuotaWrite=async()=>{const original=IDBObjectStore.prototype.add;let writes=0,injected=false,name,reason;IDBObjectStore.prototype.add=function(...args){if(this.name.endsWith('full_messages')&&++writes===2){injected=true;throw new DOMException('Synthetic acceptance quota exhaustion','QuotaExceededError');}return original.apply(this,args);};try{await coordinator.switchTo('indexeddb',{confirmed:true});}catch(error){name=error.name;reason=error.message;}finally{IDBObjectStore.prototype.add=original;}assert(injected&&name==='QuotaExceededError','Quota write fault was not injected');const state=await control.read();assert(state.active==='sqlite'&&state.journal,'Quota write fault lost pending recovery');const logs=await adapters.sqlite.readLogs({category:'error',limit:100});assert(logs.entries.some(e=>e.taskId===state.journal.id&&e.errorCode==='QuotaExceededError'),'Quota diagnostic missing from persistent log');return {injected,name,reason,taskId:state.journal.id,active:state.active};};
  const auditExisting=async mode=>{const result=await audit(mode,'legacy-audit-'+mode);return {summary:result.summary,control:await control.read(),health:mode==='sqlite'?await adapters.sqlite.status():undefined};};
  const legacyView=async()=>{const open=indexedDB.open('boxed-lllllabc'),db=await new Promise((resolve,reject)=>{open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});try{const names=[...db.objectStoreNames].filter(name=>name.startsWith('__boxed_next_'));const counts=await new Promise((resolve,reject)=>{const tx=db.transaction(names,'readonly'),result={};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);for(const name of names){const read=tx.objectStore(name).count();read.onsuccess=()=>{result[name]=read.result;};}});return {version:db.version,stores:[...db.objectStoreNames],alternateCounts:counts,control:await control.read()};}finally{db.close();}};
  const startLargeInterrupted=async expectedDigest=>{
    const source=await audit('indexeddb','interrupted-source-before');assert(source.summary.digest===expectedDigest,'Large interrupted fixture source differs');golden=source.refs;
    await use('sqlite',async session=>{largeTargetOriginal=await session.getChatMeta(keys[0]);await session.putChatMeta({...largeTargetOriginal,largeOldTargetSentinel:'preserve-distinct-large-old-target'});});largeTargetRefs=(await audit('sqlite','interrupted-target-before')).refs;
    interruptAt=500;let stopped=false;try{await coordinator.switchTo('sqlite',{confirmed:true});}catch(error){stopped=error.simulateCrash===true;}finally{interruptAt=0;}assert(stopped,'Large migration did not stop at verified boundary');const state=await control.read(),target=await adapters.sqlite.batchTransfer('inspect',[state.journal.id]);assert(state.active==='indexeddb'&&state.journal&&target.receipt.verified>=500&&target.active===target.receipt.previousDataset,'Large pending checkpoint invalid');return {state,target};
  };
  const abandonLargeInterrupted=async()=>{
    csrf=(await(await fetch('/csrf-token')).json()).token;const before=await control.read();assert(before.journal&&before.active==='indexeddb','Interrupted registry lost on server restart');const view=await adapters.sqlite.batchTransfer('inspect',[before.journal.id]);assert(view.active===view.receipt.previousDataset,'Old large target no longer active');await coordinator.abandon({confirmed:true});
    const source=await audit('indexeddb','interrupted-source-retained',golden),target=await audit('sqlite','interrupted-old-target-retained',largeTargetRefs);assert(source.summary.digest!==target.summary.digest,'Distinct large target sentinel missing');await use('sqlite',session=>session.putChatMeta(largeTargetOriginal));const restored=await audit('sqlite','interrupted-fixture-restored',golden);return {source:source.summary,distinctOldTarget:target.summary,restoredFixture:restored.summary,control:await control.read(),oldTargetPreserved:true};
  };
  globalThis.stage5Contract={run,restartCheck,prepareCapacity,expectCapacityRefusal,restoreCapacity,quotaEstimate,injectedQuotaWrite,auditExisting,legacyView,startLargeInterrupted,abandonLargeInterrupted};progress('ready',0,expectedCount,'完整宿主已就绪');return {expectedCount};
}
