import test from 'node:test';
import assert from 'node:assert/strict';
import {createSqliteStorage} from '../src/storage/sqlite-client.js';
import {STORAGE_PROTOCOL} from '../src/storage/protocol.js';
const json=value=>new Response(JSON.stringify({protocol:STORAGE_PROTOCOL,ok:true,...value}),{headers:{'Content-Type':'application/json'}});
test('日志请求超时独立反馈，不被普通备份成功清掉；再次记录成功才恢复',async()=>{
  let failed=true;const states=[];
  const adapter=createSqliteStorage({logTimeoutMs:10,onLogStatus:state=>states.push(state.available),fetchImpl:async(url,{signal})=>{
    if(url.endsWith('logs/event')&&failed)return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));
    return json({logHealth:{available:true},database:{batchTransfer:3}});
  }});
  await assert.rejects(adapter.logEvent({}),e=>e.name==='AbortError');assert.equal(states.at(-1),false);
  assert.equal((await adapter.status()).ok,true);assert.equal(states.at(-1),false);
  failed=false;await adapter.logEvent({});assert.equal(states.at(-1),true);
});
test('容量状态接口不可用时拒绝预检，不把未知空间当成足够',async()=>{
  const adapter=createSqliteStorage({fetchImpl:async()=>{throw new Error('status unavailable');}});
  await assert.rejects(adapter.checkCapacity({bytes:1000,count:10}),/status unavailable/);
});
