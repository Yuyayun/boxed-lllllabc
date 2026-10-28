import test from 'node:test';
import assert from 'node:assert/strict';
import {createTransferCoordinator} from '../src/storage/transfer-v3.js';
test('IndexedDB 数字错误码的配额异常在持久日志保留具体名称，任务仍锁定待恢复',async()=>{
  let state={active:'indexeddb',previous:null,lastTransfer:null,journal:null};const events=[],control={read:async()=>structuredClone(state),update:async update=>(state=update(structuredClone(state)))};
  const indexeddb={batchVersion:3,batchTransfer:async action=>{if(action==='inspect')return {active:0};throw new DOMException('synthetic quota failure','QuotaExceededError');}};
  const sqlite={batchVersion:3,status:async()=>({ok:true,database:{batchTransfer:3,writable:true}}),batchTransfer:async()=>({active:0}),logEvent:async event=>events.push(event)};
  const coordinator=createTransferCoordinator({control,adapters:{indexeddb,sqlite},locks:{request:async(_name,_options,fn)=>fn()}});
  await assert.rejects(coordinator.switchTo('sqlite',{confirmed:true}),error=>error.name==='QuotaExceededError');assert.ok(state.journal);assert.equal(state.active,'indexeddb');assert.ok(events.some(event=>event.stage==='error'&&event.errorCode==='QuotaExceededError'));assert.ok(events.every(event=>!('message' in event)));
});
