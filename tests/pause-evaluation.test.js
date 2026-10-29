import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createBackendVerifier} from '../src/controllers/backend-verifier.js';
import {createOperationGate} from '../src/storage/managed.js';

// Execute the actual integration callback with controlled asynchronous drains;
// this is an evaluation fixture, not a proposed change to the pause policy.
test('暂停的三个取消点跨越真实异步排空窗口，删掉最后一个会留下新安排的验证',async()=>{
  const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
  const match=source.match(/pause: async \(operation\) => \{([\s\S]*?)\n  \},\n  validate:/);assert.ok(match);
  const results=[];
  for(const clears of [3,2,1]){
    const timers=new Map();let next=0,cancelCount=0,cancelMs=0;
    const real=createBackendVerifier({setTimer:callback=>{const id=++next;timers.set(id,callback);return id;},clearTimer:id=>timers.delete(id)});
    const verifier={...real,clearScheduledVerification(){const start=performance.now();cancelCount++;real.clearScheduledVerification();cancelMs+=performance.now()-start;}};
    verifier.scheduleBackendVerification('before-pause',2000,0);
    const gate=createOperationGate();let release,entered;const reached=new Promise(resolve=>{entered=resolve;});
    const running=gate.run(async()=>{await new Promise(resolve=>{release=resolve;});verifier.scheduleBackendVerification('after-running-operation',2000,0);});
    let occurrence=0;const body=match[1].replace(/backendVerifier\?\.clearScheduledVerification\(\);/g,text=>++occurrence<=clears?text:'');
    const pause=vm.runInNewContext(`(async(operation)=>{${body}})`,{
      isGenerating:()=>false,switchUi:{block(){}},backendVerifier:verifier,operationGate:gate,
      backupEvents:{async pause(){verifier.scheduleBackendVerification('after-flush',2000,0);entered();}},contextFingerprint:async()=>'',migrationContext:null,
    });
    const waiting=pause({kind:'switch'});await reached;await Promise.resolve();release();await running;await waiting;
    results.push({clears,cancelCount,cancelMs,pendingTimers:timers.size});
    assert.equal(gate.isPaused(),true);if(clears===3)assert.equal(timers.size,0);else assert.equal(timers.size,1);
    real.clearScheduledVerification();gate.resume();verifier.scheduleBackendVerification('normal-after-resume',2000,0);assert.equal(timers.size,1);real.clearScheduledVerification();
  }
  console.log('PAUSE_EVALUATION',JSON.stringify(results));
});
