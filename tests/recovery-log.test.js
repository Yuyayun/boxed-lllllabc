import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecoveryLogRecorder,recordRecoverySafely} from '../src/storage/recovery-log.js';
import {createSqliteStorage} from '../src/storage/sqlite-client.js';

const base={chatKey:'PRIVATE_CHAT:branch:checkpoint',recoveryId:'recovery-test-123',recoverySource:'pending',stage:'restore-started',targetCount:83};
test('恢复只发关键节点，共用编号，正文与聊天文件名不会入日志',async()=>{
 const events=[],log=createRecoveryLogRecorder({send:async event=>events.push(event),getStorageMode:()=> 'sqlite'});
 for(const stage of ['restore-started','restore-submitted','restore-confirmed'])for(let n=0;n<100;n++)log.record({...base,stage,raw:'SECRET'});
 await log.idle();assert.equal(events.length,3);assert.equal(new Set(events.map(event=>event.recoveryId)).size,1);assert.equal(new Set(events.map(event=>event.chatRef)).size,1);assert.doesNotMatch(JSON.stringify(events),/PRIVATE_CHAT|SECRET/);
});
test('不同聊天的匿名引用分开，未确认不会宣称完成',async()=>{
 const events=[],log=createRecoveryLogRecorder({send:async event=>events.push(event)});
 log.record(base);log.record({...base,recoveryId:'another-id',chatKey:'other-branch',stage:'restore-submitted'});await log.idle();assert.notEqual(events[0].chatRef,events[1].chatRef);assert(events.every(event=>event.stage!=='restore-confirmed'));
});
test('慢速连接有界排队，失败后冷却一分钟，不阻塞调用者',async()=>{
 let release,sends=0,now=1000000;const log=createRecoveryLogRecorder({send:async()=>{sends++;await new Promise(resolve=>{release=resolve;});throw new Error('offline');},now:()=>now});
 for(let n=0;n<10000;n++)log.record({...base,recoveryId:'attempt-'+n});await new Promise(resolve=>setTimeout(resolve,0));assert.equal(sends,1);release();await log.idle();assert.equal(sends,1);
 for(let n=0;n<1000;n++)log.record({...base,recoveryId:'retry-'+n});await log.idle();assert.equal(sends,1);
});
test('旧服务器不支持新日志能力时，不追加任何日志请求',async()=>{
 const calls=[],storage=createSqliteStorage({fetchImpl:async(url)=>{calls.push(url);return new Response(JSON.stringify({protocol:6,ok:true,capabilities:{logs:1},database:{writable:true}}),{headers:{'content-type':'application/json'}});}});
 await storage.status();assert.equal(await storage.recordRecoveryEvent({}),false);assert.equal(calls.length,1);
});
test('日志回调同步异常或异步拒绝均不改变保存结果',async()=>{
 assert.doesNotThrow(()=>recordRecoverySafely(()=>{throw new Error('offline');},base));recordRecoverySafely(async()=>{throw new Error('offline');},base);await new Promise(resolve=>setTimeout(resolve,0));
});

test('恢复日志连接失败和日志目录故障会通知界面，实际写入恢复后解除提示',async()=>{
 let failed=false,available=false;const statuses=[];
 const storage=createSqliteStorage({onLogStatus:status=>statuses.push(status),fetchImpl:async()=>{
  if(failed)throw new Error('offline');
  return new Response(JSON.stringify({protocol:6,ok:true,capabilities:{logs:1,recoveryLogs:1},logHealth:{available}}),{headers:{'content-type':'application/json'}});
 }});
 await storage.status();await storage.recordRecoveryEvent({});assert.equal(statuses.at(-1).available,false);
 failed=true;await assert.rejects(storage.recordRecoveryEvent({}),/offline/);assert.equal(statuses.at(-1).available,false);
 failed=false;available=true;await storage.recordRecoveryEvent({});assert.equal(statuses.at(-1).available,true);
});
