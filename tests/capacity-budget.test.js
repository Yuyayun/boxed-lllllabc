import test from 'node:test';
import assert from 'node:assert/strict';
import {migrationSpaceBudget} from '../src/storage/capacity-budget.js';
import {createSqliteStorage} from '../src/storage/sqlite-client.js';
import {STORAGE_PROTOCOL} from '../src/storage/protocol.js';
test('容量覆盖新数据、索引、WAL 和余量，小记录也有开销，异常数字拒绝',()=>{
  const manifest={bytes:479*1024*1024,count:4551};const sqlite=migrationSpaceBudget(manifest,'sqlite'),idb=migrationSpaceBudget(manifest,'indexeddb');assert.ok(sqlite.requiredAdditionalBytes>manifest.bytes*3);assert.ok(idb.requiredAdditionalBytes>manifest.bytes*2);assert.ok(migrationSpaceBudget({bytes:10,count:10000},'sqlite').indexes>100*1024*1024);for(const value of [-1,NaN,Infinity,Number.MAX_SAFE_INTEGER])assert.throws(()=>migrationSpaceBudget({bytes:value,count:1},'sqlite'));
});
test('不重复要求已占用目标库体积，可用空间不足时在写入前停止',async()=>{
  const manifest={bytes:1024,count:2},required=migrationSpaceBudget(manifest,'sqlite').requiredAdditionalBytes;let free=required;
  const adapter=createSqliteStorage({fetchImpl:async()=>({ok:true,status:200,json:async()=>({ok:true,protocol:STORAGE_PROTOCOL,database:{bytes:10*1024*1024*1024,availableBytes:free}})})});await adapter.checkCapacity(manifest);free--;await assert.rejects(adapter.checkCapacity(manifest),/空间不足/);
});
