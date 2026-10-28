import {createIndexedDbStorage} from '../../src/storage/indexeddb-adapter.js';
import {createIndexedDbBatchTransfer} from '../../src/storage/indexeddb-batch-transfer.js';
import {openBackupDatabase} from '../../src/db/index.js';
import {DATA_STORES,digestRow,readTransferManifest} from '../../src/storage/transfer-format.js';
import {TRANSFER_STORES} from '../../src/db/schema.js';
import {stableText} from '../../src/storage/value-digest.js';
import {captureSnapshot} from '../../src/snapshots/model.js';
import {snapshotBatches,readSnapshot} from '../../src/snapshots/service.js';
const request=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
const assert=(value,message)=>{if(!value)throw new Error(message);};
if(location.hostname!=='127.0.0.1'||location.pathname!=='/legacy-recovery-contract')throw new Error('Isolated fixture only');
const adapter=createIndexedDbStorage(),id='legacy-browser-test';
async function normal(operation,...args){const db=await adapter.open();try{return await db[operation](...args);}finally{db.close();}}
async function contents(){const db=await openBackupDatabase();try{return await new Promise((resolve,reject)=>{const tx=db.transaction(DATA_STORES,'readonly'),data={};tx.oncomplete=()=>resolve(data);tx.onabort=()=>reject(tx.error);for(const name of DATA_STORES){const r=tx.objectStore(name).getAll();r.onsuccess=()=>{data[name]=r.result.map(stableText).sort();};}});}finally{db.close();}}
globalThis.legacyContract={
  async seed(stage){
    await request(indexedDB.deleteDatabase('boxed-lllllabc'));
    sessionStorage.setItem('legacy-finish',stage==='activated'?'1':'0');
    for(let i=0;i<24;i++)await normal('putChatMeta',{chatKey:'old-'+i,date:new Date(0),optional:undefined});
    await normal('putFullMessages',{chatKey:'old-0',messages:[{messageIndex:0,raw:{mes:'old中文',swipes:['a','b'],date:new Date(0),optional:undefined}}]});
    const current={ok:true,identity:{chatKey:'old-0'},chat:[{mes:'snapshot-a'},{mes:'snapshot-b'}],context:{chatMetadata:{keep:1}}},snapshot=await captureSnapshot(current,{name:'旧任务快照'});
    await normal('beginSnapshot',{header:snapshot.header,identityMeta:{chatKey:'old-0'}});for(const messages of snapshotBatches(snapshot.messages))await normal('appendSnapshotMessages',{id:snapshot.header.id,messages});await normal('publishSnapshot',{id:snapshot.header.id});
    sessionStorage.setItem('legacy-expected',stableText(await contents()));sessionStorage.setItem('legacy-snapshot',snapshot.header.id);
    const rows=Array.from({length:20},(_,i)=>({n:i+1,store:'chat_meta',key:'new-'+i,value:{chatKey:'new-'+i}}));for(const row of rows)row.digest=await digestRow(row);const manifest=await readTransferManifest(async after=>after?[]:rows);
    await adapter.transfer('prepare',{id,manifest});await adapter.transfer('append',{id,rows});await adapter.transfer('seal',{id});await adapter.transfer('commit',{id});
    if(stage==='activated'){sessionStorage.setItem('legacy-expected',stableText(await contents()));return {stage};}
    const recovery=createIndexedDbBatchTransfer().legacyRecovery;
    for(let n=0;n<200;n++){const result=await recovery.step(id,'rollback',{limit:2,bytes:1024});if(result.state.recovery.stage===stage&&(stage!=='copy'||result.state.recovery.after>0)){const db=await openBackupDatabase();try{const tx=db.transaction(TRANSFER_STORES.rows,'readonly'),count=await request(tx.objectStore(TRANSFER_STORES.rows).count());assert(count>0,'Old authority rows deleted before complete verification');}finally{db.close();}return {stage,processed:result.state.recovery.summary.count};}}
    throw new Error('Recovery window not reached');
  },
  async recover(){
    const finishing=sessionStorage.getItem('legacy-finish')==='1';
    let blocked=false;try{await normal('putChatMeta',{chatKey:'blocked'});}catch{blocked=true;}assert(blocked,'Persistent lock missing across reload');
    await adapter.transfer(finishing?'finish':'rollback',{id});assert(stableText(await contents())===sessionStorage.getItem('legacy-expected'),'Legacy restoration content mismatch');await adapter.transfer(finishing?'finish':'rollback',{id});
    if(!finishing){const snapshotId=sessionStorage.getItem('legacy-snapshot'),session=await adapter.open();try{const snapshot=await readSnapshot(session,snapshotId);assert(snapshot.chat.length===2,'Legacy snapshot lost');}finally{session.close();}}
    await normal('putChatMeta',{chatKey:'after-recovery'});return {ok:true,persistentLock:true,snapshot:finishing?'overwrite-confirmed':true};
  },
};
