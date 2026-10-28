import * as db from '../../src/db/index.js';
import { createIndexedDbStorage } from '../../src/storage/indexeddb-adapter.js';
import { createSqliteStorage } from '../../src/storage/sqlite-client.js';
import { createStorageControl } from '../../src/storage/control.js';
import { createTransferCoordinator } from '../../src/storage/transfer.js';
import { createStorageSwitchUi } from '../../src/ui/storage-switch.js';
import {createRuntimeLogUi} from '../../src/ui/runtime-log.js';
import { DATASET_NAMES, datasetStore } from '../../src/storage/dataset-layout.js';
import { encodeStorageValue, decodeStorageValue } from '../../src/storage/protocol.js';
import { stableText } from '../../src/storage/value-digest.js';
import { captureSnapshot } from '../../src/snapshots/model.js';
import { snapshotBatches, readSnapshot } from '../../src/snapshots/service.js';

const assert=(value,message)=>{if(!value)throw new Error(message);};
const request=value=>new Promise((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error);});
const normalize=data=>Object.fromEntries(DATASET_NAMES.map(n=>[n,data[n].map(value=>stableText(value)).sort()]));
export function installRecoveryContract(nonce) {
  if(location.hostname!=='127.0.0.1'||location.pathname!=='/recovery-contract')throw new Error('Only isolated fixture origin');
  let dropCommit=false,ui,stageToCrash=null,crashed=false,pauseStage=null,coordinator;
  const rpc=async(method,args=[])=>{
    const response=await fetch('/fixture',{method:'POST',headers:{'Content-Type':'application/json','X-Test-Nonce':nonce},body:JSON.stringify({method,args:encodeStorageValue(args)})});
    const body=await response.json();if(!body.ok)throw new Error(body.message);return decodeStorageValue(body.value);
  };
  const control=createStorageControl();
  let logsUi;const logMemory=new Map(),remember={getItem:key=>logMemory.get(key),setItem:(key,value)=>logMemory.set(key,value)};
  const adapters={indexeddb:createIndexedDbStorage(),sqlite:createSqliteStorage({getRequestHeaders:()=>({'X-Test-Nonce':nonce,'X-CSRF-Token':nonce}),fetchImpl:(url,options)=>{
    if(dropCommit&&url.endsWith('/batch-transfer')&&JSON.parse(options.body).action==='commit'){dropCommit=false;options={...options,headers:{...options.headers,'X-Test-Drop':'1'}};}return fetch(url,options);
  }})};
  function makeCoordinator() {
    return createTransferCoordinator({control,adapters,budget:{limit:2,bytes:700},pause:async()=>ui?.block(),resume:async()=>ui?.close(),progress:text=>ui?.progress(text),hook:async stage=>{
      if(stage===pauseStage){pauseStage=null;coordinator.requestPause();}
      if(stage===stageToCrash&&!crashed){crashed=true;throw Object.assign(new Error('fixture-crash-'+stage),{simulateCrash:true});}
    }});
  }
  coordinator=makeCoordinator();
  const normal=async(mode,operation,...args)=>{const session=await adapters[mode].open();try{return await session[operation](...args);}finally{session.close();}};
  const peek=async(mode,area)=>{
    if(mode==='sqlite')return normalize(await rpc('peek',[area]));
    const database=await db.openBackupDatabase();try{return normalize(await new Promise((resolve,reject)=>{
      const tx=database.transaction(DATASET_NAMES.map(n=>datasetStore(n,area)),'readonly'),result={};
      tx.oncomplete=()=>resolve(result);tx.onerror=tx.onabort=()=>reject(tx.error);
      (async()=>{for(const n of DATASET_NAMES)result[n]=await request(tx.objectStore(datasetStore(n,area)).getAll());})().catch(error=>{tx.abort();reject(error);});
    }));}finally{database.close();}
  };
  const equal=(a,b,message)=>assert(stableText(a)===stableText(b),message);
  async function reset(from) {
    ui?.close();await rpc('reset');
    await request(indexedDB.deleteDatabase('boxed-lllllabc'));await request(indexedDB.deleteDatabase('boxed-lllllabc-control'));
    await control.update(state=>({...state,active:from}));
    const to=from==='indexeddb'?'sqlite':'indexeddb',meta={chatKey:'source',date:new Date(0),optional:undefined};
    await normal(from,'replaceRecentSnapshot',{meta,messages:[{messageIndex:0,raw:{mes:'recent'}}]});
    await normal(from,'putFullMessages',{chatKey:'source',messages:Array.from({length:4},(_,i)=>({messageIndex:i,raw:{mes:'body-'+i+'中'.repeat(70),swipes:['a','b'],date:new Date(0),optional:undefined}}))});
    await normal(from,'putPendingChanges',[{id:'pending-123',chatKey:'source',messageIndex:null,kind:'structure',raw:{keep:true}}]);
    await normal(from,'putHistoricalChanges',[{chatKey:'source',messageIndex:0,raw:{mes:'history'}}]);
    const current={ok:true,identity:{chatKey:'source'},chat:[{mes:'snap-a',date:new Date(0)},{mes:'snap-b',optional:undefined}],context:{chatMetadata:{score:1}}};
    const snapshot=await captureSnapshot(current,{name:'恢复夹具'});
    await normal(from,'beginSnapshot',{header:snapshot.header,identityMeta:{chatKey:'source'}});
    for(const messages of snapshotBatches(snapshot.messages))await normal(from,'appendSnapshotMessages',{id:snapshot.header.id,messages});
    await normal(from,'publishSnapshot',{id:snapshot.header.id});
    await normal(to,'putChatMeta',{chatKey:'old-target',keep:true});
    const expected={from,to,source:await peek(from,0),target:await peek(to,0),snapshotId:snapshot.header.id,chat:current.chat};
    sessionStorage.setItem('boxed-recovery-expected',JSON.stringify(encodeStorageValue(expected)));
    crashed=false;stageToCrash=null;dropCommit=false;coordinator=makeCoordinator();return expected;
  }
  async function start(from,stage,{lostCommit=false}={}) {
    const expected=await reset(from);stageToCrash=stage;dropCommit=lostCommit;
    try{await coordinator.switchTo(expected.to,{confirmed:true});if(stage||lostCommit)throw new Error('Expected interruption did not happen');}
    catch(error){if(!error.simulateCrash&&error.code!=='outcome-unknown')throw error;}
    assert((await control.read()).journal,'Interruption must keep journal');
    return {from,stage,state:await control.read()};
  }
  async function recover({cancelled=false}={}) {
    const expected=decodeStorageValue(JSON.parse(sessionStorage.getItem('boxed-recovery-expected')));
    stageToCrash=null;coordinator=makeCoordinator();
    let blocked=false;try{await coordinator.recover();}catch(error){blocked=error.code==='recovery-required';}assert(blocked,'Recovery must require explicit confirmation');
    const result=await coordinator.recover({confirmed:true}),state=await control.read();assert(!state.journal,'Journal not cleared');
    equal(await peek(expected.from,0),expected.source,'Original source changed');
    if(cancelled){assert(result.cancelled&&state.active===expected.from,'Incomplete baseline should cancel');equal(await peek(expected.to,0),expected.target,'Original target lost');}
    else{
      assert(result.ok&&state.active===expected.to,'Recovery did not activate target');equal(await peek(expected.to,1),expected.source,'Recovered target differs');
      equal(await normal(expected.to,'getFullMessages','source').then(rows=>rows.map(row=>row.raw)),Array.from({length:4},(_,i)=>({mes:'body-'+i+'中'.repeat(70),swipes:['a','b'],date:new Date(0),optional:undefined})),'Normal reads failed');
      const saved=await readSnapshot({getSnapshotHeader:(...args)=>normal(expected.to,'getSnapshotHeader',...args),getSnapshotMessages:(...args)=>normal(expected.to,'getSnapshotMessages',...args)},expected.snapshotId);
      equal(saved.chat,expected.chat,'Snapshot preview differs');
    }
    return {ok:result.ok??false,cancelled:!!result.cancelled,active:state.active};
  }
  async function uiCase(from='indexeddb',stage='batch-verified') {
    await start(from,stage);
    document.body.innerHTML='<main><p id="boxed-lllllabc-transfer-result"></p><p id="boxed-lllllabc-clear-result"></p></main>';
    ui=createStorageSwitchUi({control,sqlite:adapters.sqlite,coordinator,afterChange:async()=>{globalThis.recoveryUiFinished=true;}});
    globalThis.recoveryUiFinished=false;
    try{await coordinator.recover();}catch(error){await ui.failure(error);}
    return {state:await control.read()};
  }
  async function mutateSource() {
    const expected=decodeStorageValue(JSON.parse(sessionStorage.getItem('boxed-recovery-expected')));
    if(expected.from==='sqlite')await rpc('mutate-source');
    else {
      const database=await db.openBackupDatabase();try{await new Promise((resolve,reject)=>{
        const tx=database.transaction(['chat_meta'],'readwrite');tx.objectStore('chat_meta').put({chatKey:'source',changedDuringRestart:true});tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
      });}finally{database.close();}
    }
    expected.source=await peek(expected.from,0);sessionStorage.setItem('boxed-recovery-expected',JSON.stringify(encodeStorageValue(expected)));
  }
  globalThis.recoveryContract={start,recover,uiCase,mutateSource,restartWorker:()=>rpc('restart-worker'),state:()=>control.read(),
    async logCase(){
      ui?.close();await rpc('reset');logMemory.clear();
      document.body.innerHTML=await (await fetch('/settings.html')).text();document.querySelector('.inline-drawer-content').style.display='block';document.querySelector('#boxed-lllllabc-settings').style.cssText='max-width:700px;margin:0 auto';
      for(const node of document.querySelectorAll('[data-settings-group]'))if(node.dataset.settingsGroup!=='storage')node.hidden=true;
      logsUi=createRuntimeLogUi({storage:adapters.sqlite,remember});Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{globalThis.copiedLogs=text;}}});
      for(let i=0;i<60;i++)await adapters.sqlite.logEvent({taskId:'ui-pending-task',from:'indexeddb',to:'sqlite',kind:'switch',stage:'batch-verified',verified:i});
      for(const [stage,errorCode] of [['error','injected'],['recover'],['completed']])await adapters.sqlite.logEvent({taskId:'ui-error-done',from:'indexeddb',to:'sqlite',kind:'switch',stage,...(errorCode?{errorCode}:{})});
    },
    logConnection(online){logsUi.connection(online?{ok:true,capabilities:{logs:1}}:{ok:false});},
    logRecreate(){const old=document.querySelector('#boxed-lllllabc-runtime-logs');old.replaceWith(old.cloneNode(true));logsUi=createRuntimeLogUi({storage:adapters.sqlite,remember});logsUi.connection({ok:false});},
    logOpen(){logsUi.open();},
    async logRemaining(){const result=await adapters.sqlite.readLogs({category:'all',limit:100});return result.entries.length===60&&result.entries.every(x=>x.taskId==='ui-pending-task');},
    async controlSchemaTest(){
      await request(indexedDB.deleteDatabase('boxed-lllllabc-control'));
      const legacy=await new Promise((resolve,reject)=>{
        const req=indexedDB.open('boxed-lllllabc-control',1);req.onupgradeneeded=()=>req.result.createObjectStore('state').put({active:'indexeddb',previous:null,lastTransfer:null,journal:null,legacyMarker:'preserved'},'current');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
      });legacy.close();assert((await control.read()).legacyMarker==='preserved','控制库升级改写旧状态');
      const database=await request(indexedDB.open('boxed-lllllabc-control',2));
      await new Promise((resolve,reject)=>{const tx=database.transaction('state','readwrite');tx.objectStore('state').delete('current');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});database.close();
      let blocked=false;try{await control.read();}catch(error){blocked=/记录缺失/.test(error.message);}assert(blocked,'控制记录丢失时不能默认选 IndexedDB');
      await request(indexedDB.deleteDatabase('boxed-lllllabc-control'));return true;
    },
    async cancelUi(){await uiCase();},
    async protocolMismatch(){
      const response=await fetch('/api/plugins/boxed-lllllabc/batch-transfer',{method:'POST',headers:{'Content-Type':'application/json','X-Test-Nonce':nonce},body:JSON.stringify({protocol:5,action:'inspect',args:encodeStorageValue(['protocol-test'])})});const body=await response.json();assert(response.status===409&&body.code==='protocol-incompatible','Old protocol accepted');
      const legacy=await fetch('/api/plugins/boxed-lllllabc/transfer',{method:'POST',headers:{'Content-Type':'application/json','X-Test-Nonce':nonce},body:JSON.stringify({protocol:6,action:'source',args:encodeStorageValue({id:'protocol-test'})})});assert(legacy.status===400,'Legacy task creation must be disabled');return true;
    },
    async pauseTest(){await reset('indexeddb');pauseStage='batch-verified';coordinator=makeCoordinator();let paused=false;try{await coordinator.switchTo('sqlite',{confirmed:true});}catch(error){paused=error.code==='paused';}assert(paused,'Pause failed');return coordinator.abandon({confirmed:true});},
  };
}
