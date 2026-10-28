import test from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_PROTOCOL, validateBatchCall, encodeStorageValue } from '../src/storage/protocol.js';
import { createSqliteStorage } from '../src/storage/sqlite-client.js';
import { validateStorageControl } from '../src/storage/control.js';

test('协议 6 的迁移调用限制方法、参数、方向及分页字段，拒绝旧协议状态', async()=>{
  assert.equal(STORAGE_PROTOCOL,6);
  assert.throws(()=>validateBatchCall('constructor',[]));
  assert.throws(()=>validateBatchCall('begin',[{id:'protocol-test',role:'source',from:'indexeddb',to:'sqlite'}],'sqlite'));
  assert.throws(()=>validateBatchCall('prepareStep',['protocol-test',{sql:'DELETE'}]));
  assert.throws(()=>validateBatchCall('sourceNext',['protocol-test',0,{},'extra']));
  const adapter=createSqliteStorage({fetchImpl:async()=>({ok:true,status:200,json:async()=>({ok:true,protocol:5})})});
  assert.equal((await adapter.status()).code,'protocol-incompatible');
});

test('新迁移请求保留同源/CSRF，实际中断使用结果未知，不把 AbortError 数字 code 当失败结果',async()=>{
  let called=false;
  const adapter=createSqliteStorage({timeoutMs:5,getRequestHeaders:()=>({'X-CSRF-Token':'fixture'}),fetchImpl:async(url,options)=>{
    assert.ok(url.endsWith('/batch-transfer'));assert.equal(options.credentials,'same-origin');assert.equal(options.headers['X-CSRF-Token'],'fixture');called=true;
    return await new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))));
  }});
  await assert.rejects(adapter.batchTransfer('inspect',['protocol-test']),e=>e.code==='outcome-unknown');assert.equal(called,true);
  let request;
  const success=createSqliteStorage({fetchImpl:async(_url,options)=>{request=JSON.parse(options.body);return {ok:true,status:200,json:async()=>({ok:true,protocol:6,value:encodeStorageValue({phase:'committed'})})};}});
  assert.equal((await success.batchTransfer('inspect',['protocol-test'])).phase,'committed');assert.equal(request.protocol,6);
});

test('控制记录接受新版提交/撤销阶段，拒绝状态与活动位置矛盾及未知任务版本',()=>{
  const base={active:'indexeddb',previous:null,lastTransfer:null,journal:{version:3,id:'protocol-test',kind:'switch',from:'indexeddb',to:'sqlite',phase:'committing'}};
  assert.equal(validateStorageControl(base),base);
  assert.throws(()=>validateStorageControl({...base,active:'sqlite'}));
  assert.throws(()=>validateStorageControl({...base,journal:{...base.journal,version:4}}));
  assert.equal(validateStorageControl({...base,journal:{...base.journal,phase:'aborting'}}).active,'indexeddb');
  assert.equal(validateStorageControl({...base,active:'sqlite',previous:'indexeddb',lastTransfer:'protocol-test',journal:{...base.journal,phase:'activated'}}).active,'sqlite');
});
