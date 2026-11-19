import test from 'node:test';
import assert from 'node:assert/strict';
import {formatRuntimeLog} from '../src/storage/runtime-log-format.js';
import {supervisorProgressText} from '../src/ui/storage-switch.js';

test('日志时间按运行环境本地时区展示到秒，保留原始数据及非法时间戳', () => {
  const timestamp = '2026-11-17T23:40:01.642Z';
  const entry = Object.freeze({ timestamp, operation: 'putChatMeta', stage: 'finished' });
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  const expected = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  const text = formatRuntimeLog(entry);
  assert.equal(text.split(' | ')[0], expected);
  assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \| /);
  assert.doesNotMatch(text, /T\d{2}:|Z|\.642/);
  assert.equal(entry.timestamp, timestamp);
  for (const invalid of ['not-a-timestamp', '2026-99-99T99:99:99Z', '']) {
    assert.doesNotThrow(() => formatRuntimeLog({ ...entry, timestamp: invalid }));
    assert.equal(formatRuntimeLog({ ...entry, timestamp: invalid }).split(' | ')[0], invalid);
  }
});

test('搬家、清空、暂停及日常失败按真实对象说明，诊断字段不充当正文',()=>{
  const clear=formatRuntimeLog({kind:'clear',scope:'cleanup',from:'sqlite',to:'indexeddb',stage:'completed',taskId:'private-id'});
  assert.match(clear,/清空旧位置：浏览器本地备份/);assert.match(clear,/已清空/);assert.doesNotMatch(clear,/切换|搬家|private-id/);
  assert.match(formatRuntimeLog({scope:'migration',kind:'switch',from:'indexeddb',to:'sqlite',stage:'paused'}),/切换备份位置.*浏览器本地备份.*服务器备份.*任务已暂停/);
  const daily=formatRuntimeLog({scope:'daily',operation:'putChatMeta',stage:'error',errorCode:'SQLITE_FULL'});assert.match(daily,/保存聊天信息.*服务器空间不足/);
  const counted=formatRuntimeLog({count:10,verified:0,stage:'progress'});assert.match(counted,/已处理 10 条/);assert.match(counted,/核验 0 条/);assert.doesNotMatch(counted,/核验 10 条/);
  assert.match(formatRuntimeLog({taskId:'diagnostic-id',stage:'internal-stage'},{diagnostic:true}),/诊断：.*diagnostic-id/);
});
test('空闲不沿用旧阶段、数量或线程运行时间；排队与执行时间分别说明',()=>{
  const idle=supervisorProgressText({state:'idle',stage:'legacy-copy',count:100,elapsedMs:86400000});assert.equal(idle,'');
  assert.match(supervisorProgressText({state:'queued',elapsedMs:2000}),/排队，已等待 2 秒/);
  assert.match(supervisorProgressText({state:'working',elapsedMs:3000}),/当前任务已用 3 秒/);
});

test('欢迎页服务器检查取消按连接检查说明，写入取消仍保留结果核对提示',()=>{
  const status=formatRuntimeLog({operation:'_status',stage:'error',errorCode:'cancelled',elapsedMs:51400});
  assert.match(status,/检查服务器存储.*51.4 秒.*本次连接检查已取消.*cancelled/);
  assert.doesNotMatch(status,/日常备份操作|需要检查操作结果/);
  assert.match(formatRuntimeLog({operation:'putFullMessages',stage:'error',errorCode:'cancelled'}),/保存完整聊天备份.*需要检查操作结果/);
});
