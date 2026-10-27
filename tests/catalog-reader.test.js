import test from 'node:test';
import assert from 'node:assert/strict';
import { readCatalogByChat, readBackupCatalog, CATALOG_STORES } from '../src/storage/catalog-reader.js';
import { buildBackupCatalog } from '../src/backup/catalog.js';
import { inspectBackupCatalogData } from '../src/storage/health.js';
import { batchData } from './browser/batch-fixture.js';

test('逐聊天目录与原目录的统计、指纹、顺序和保护状态等价',async()=>{
 const data=batchData(),fields=['chatMeta','recentMessages','pendingChanges','fullMessages','historicalChanges'];
 const stores=new Map(CATALOG_STORES.map((name,index)=>[name,{rows:data[fields[index]],get(key){return this.rows.find(row=>row.chatKey===key);},index(){return {getAll:key=>this.rows.filter(row=>row.chatKey===key)};}}]));
 const driver={keys:store=>[...new Set(store.rows.map(row=>row.chatKey).filter(Boolean))],count:store=>store.rows.length};
 assert.deepEqual(await readCatalogByChat(stores,driver,value=>value),buildBackupCatalog(data));
 data.recentMessages.push({chatKey:'character:a.png:one',messageIndex:-1},{messageIndex:0,raw:{mes:'unindexed'}});
 const damaged=await readCatalogByChat(stores,driver,value=>value);assert.equal(damaged.invalidRecordCount,2);assert.equal(damaged.recordCount,15);
});
test('目录端口失败不会退回旧整包读取；兼容旧测试驱动时保留原构建器',async()=>{
 let rawRead=false;
 await assert.rejects(readBackupCatalog({getBackupCatalog:async()=>{throw new Error('断线');},getBackupCatalogData:async()=>{rawRead=true;}}),/断线/);assert.equal(rawRead,false);
 const marker={ok:'catalog'};assert.equal(await readBackupCatalog({getBackupCatalogData:async()=>({old:true})},data=>{assert.equal(data.old,true);return marker;}),marker);
});
