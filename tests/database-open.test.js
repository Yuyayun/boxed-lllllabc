import test from 'node:test';
import assert from 'node:assert/strict';
import {openBackupDatabase,BACKUP_DATABASE_OPEN_TIMEOUT_MS} from '../src/db/index.js';
import {backupFailureStatus} from '../src/backup/failure-status.js';
import {describeStorageFailure} from '../src/storage/health.js';
function fixture(){
 const request={},events=[];let timer;
 const options={indexedDBImpl:{open:()=>request},setTimer:(callback,delay)=>{timer=callback;events.push(['timer',delay]);return 7;},clearTimer:id=>events.push(['clear',id])};
 return {request,options,events,timeout:()=>timer()};
}
test('database open queued without events times out and aborts a late upgrade without touching data',async()=>{
 const f=fixture(),pending=openBackupDatabase(f.options);assert.deepEqual(f.events,[['timer',BACKUP_DATABASE_OPEN_TIMEOUT_MS]]);
 f.timeout();await assert.rejects(pending,error=>error.code==='backup-database-timeout'&&/已有备份已保留/.test(error.message));
 let aborted=false,closed=false;f.request.transaction={abort:()=>{aborted=true;}};f.request.onupgradeneeded();assert(aborted);
 f.request.result={close:()=>{closed=true;}};f.request.onsuccess();assert(closed);
});
test('blocked database upgrade finishes with actionable copy and closes any late connection',async()=>{
 const f=fixture(),pending=openBackupDatabase(f.options);f.request.onblocked();
 await assert.rejects(pending,error=>error.code==='backup-database-blocked'&&/关闭其他酒馆页签/.test(error.message)&&describeStorageFailure(backupFailureStatus(error)).type==='compatibility');
 let closed=false;f.request.result={close:()=>{closed=true;}};f.request.onsuccess();assert(closed);
});
test('successful connection clears timeout and closes itself for a later version change',async()=>{
 const f=fixture();let closed=0;f.request.result={close:()=>closed++};const pending=openBackupDatabase(f.options);f.request.onsuccess();const db=await pending;
 assert(f.events.some(row=>row[0]==='clear'&&row[1]===7));db.onversionchange();assert.equal(closed,1);
});
test('browser VersionError points to frontend update, without deleting or lowering the database',async()=>{
 const f=fixture(),pending=openBackupDatabase(f.options);f.request.error=new DOMException('older version','VersionError');f.request.onerror();
 await assert.rejects(pending,error=>error.code==='backup-client-upgrade-required'&&/不要清除浏览器站点数据/.test(error.message)&&backupFailureStatus(error).shortText==='前端扩展需要更新'&&describeStorageFailure(error).type==='compatibility');
 const oldServer=Object.assign(new Error('服务器缺少新版记录能力'),{code:'backup-upgrade-required'});assert.equal(backupFailureStatus(oldServer).shortText,'服务器备份插件需要更新');
});
