// Prepare a real schema-7 IndexedDB using the released 1.0.0 migration module.
// This page intentionally does not import Tavern or the current frontend entry.
import {createSqliteStorage} from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/sqlite-client.js';
const request=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
export async function seedLegacyData({nonce,origin,chats=175,expectedCount=4551}){
  assert(location.origin===origin&&location.hostname==='127.0.0.1','Disposable legacy origin required');const marker=await(await fetch('/boxed-stage5/authorization.json')).json();assert(marker.nonce===nonce&&marker.purpose==='boxed-stage5-disposable','Legacy fixture marker missing');
  const {migrateDatabase}=await import('/boxed-stage5/baseline-v1/migration.js'),{DB_VERSION}=await import('/boxed-stage5/baseline-v1/schema.js');assert(DB_VERSION===7,'Released schema 7 fixture required');
  assert(!(await indexedDB.databases()).some(db=>db.name==='boxed-lllllabc'),'Fresh legacy browser database required');const open=indexedDB.open('boxed-lllllabc',7);open.onupgradeneeded=()=>migrateDatabase(open.result,open.transaction);const db=await request(open);
  const token=(await(await fetch('/csrf-token')).json()).token,adapter=createSqliteStorage({getRequestHeaders:()=>({'X-CSRF-Token':token})});let count=0;
  async function put(records){const names=Object.keys(records);await new Promise((resolve,reject)=>{const tx=db.transaction(names,'readwrite');tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error);for(const name of names)for(const row of records[name]){tx.objectStore(name).put(row);count++;}});}
  const session=await adapter.open();try{
    for(let i=0;i<chats;i++){const key=`character:stage5-${i}.png:chat-${i}`;await put({chat_meta:[await session.getChatMeta(key)],recent_messages:await session.getRecentMessages(key),full_messages:await session.getFullMessages(key),historical_changes:await session.getHistoricalChanges(key),pending_changes:await session.getPendingChanges(key)});globalThis.legacySeedProgress={chat:i+1,total:chats,count};}
    let after='';do{const page=await session.listSnapshots({after});for(const item of page.items){await put({snapshots:[await session.getSnapshotHeader(item.id)]});let at=-1;while(true){const rows=await session.getSnapshotMessages({id:item.id,after:at});if(!rows.length)break;await put({snapshot_messages:rows});at=rows.at(-1).messageIndex;}}after=page.after;}while(after);
    assert(count===expectedCount,'Legacy source count mismatch');const oldControl=indexedDB.open('boxed-lllllabc-control',1);oldControl.onupgradeneeded=()=>oldControl.result.createObjectStore('state');const control=await request(oldControl);control.close();return {schema:db.version,controlSchema:1,count,stores:[...db.objectStoreNames]};
  }finally{session.close();db.close();}
}
