import test from 'node:test';
import assert from 'node:assert/strict';
import {formatRuntimeLog} from '../src/storage/runtime-log-format.js';
import {supervisorProgressText} from '../src/ui/storage-switch.js';
test('搬家、清空、暂停及日常失败按真实对象说明，诊断字段不充当正文',()=>{
  const clear=formatRuntimeLog({kind:'clear',scope:'cleanup',from:'sqlite',to:'indexeddb',stage:'completed',taskId:'private-id'});
  assert.match(clear,/清空旧位置：浏览器本地备份/);assert.match(clear,/已清空/);assert.doesNotMatch(clear,/切换|搬家|private-id/);
  assert.match(formatRuntimeLog({scope:'migration',kind:'switch',from:'indexeddb',to:'sqlite',stage:'paused'}),/切换备份位置.*浏览器本地备份.*服务器备份.*任务已暂停/);
  const daily=formatRuntimeLog({scope:'daily',operation:'putChatMeta',stage:'error',errorCode:'SQLITE_FULL'});assert.match(daily,/保存聊天信息.*服务器空间不足/);
  const counted=formatRuntimeLog({count:10,verified:0,stage:'progress'});assert.match(counted,/已处理 10 条/);assert.match(counted,/核验 0 条/);assert.doesNotMatch(counted,/核验 10 条/);
  assert.match(formatRuntimeLog({taskId:'diagnostic-id',stage:'internal-stage'},{diagnostic:true}),/诊断：.*diagnostic-id/);
});
test('空闲不沿用旧阶段、数量或线程运行时间；排队与执行时间分别说明',()=>{
  const idle=supervisorProgressText({state:'idle',stage:'legacy-copy',count:100,elapsedMs:86400000});assert.equal(idle,'服务器当前空闲。');
  assert.match(supervisorProgressText({state:'queued',elapsedMs:2000}),/排队，已等待 2 秒/);
  assert.match(supervisorProgressText({state:'working',elapsedMs:3000}),/当前任务已用 3 秒/);
});
