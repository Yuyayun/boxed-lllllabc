import test from 'node:test';
import assert from 'node:assert/strict';
import {formatRuntimeLog} from '../src/storage/runtime-log-format.js';
import {supervisorProgressText} from '../src/ui/storage-switch.js';
import {STORAGE_OPERATIONS,BATCH_TRANSFER_METHODS} from '../src/storage/protocol.js';
import {RUNTIME_LOG_OPERATIONS,runtimeLogContext,runtimeLogOutcome} from '../src/storage/runtime-log-labels.js';

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

test('所有开放的备份和分批存储操作都有明确中文名称，分批操作能说明备份类型',()=>{
  for(const operation of [...STORAGE_OPERATIONS,...Object.keys(BATCH_TRANSFER_METHODS)]){
    assert(Object.hasOwn(RUNTIME_LOG_OPERATIONS,operation),operation+' 缺少日志名称');
    const text=formatRuntimeLog({operation,stage:'finished'});
    assert.doesNotMatch(text,/其他服务器存储操作|日常备份操作/);
  }
  const context=runtimeLogContext('getBackupPage',[{store:'historical_changes',chatKey:'SECRET'}]);
  assert.deepEqual(context,{backupStore:'historical_changes'});
  assert.match(formatRuntimeLog({operation:'getBackupPage',...context,stage:'finished'}),/分批读取历史楼层改动.*本批读取完成/);
  assert.deepEqual(runtimeLogContext('getBackupPage',[{store:'SECRET'}]),{});
  assert.deepEqual(runtimeLogContext('getBackupPage',[{store:Object.create(null)}]),{});
});

test('暂存、步骤结束及整项任务完成不混写，存储请求完成不宣称酒馆已保存',()=>{
  assert.match(formatRuntimeLog({operation:'appendBackupWrite',stage:'finished'}),/尚未提交正式备份/);
  assert.match(formatRuntimeLog({operation:'appendSnapshotMessages',stage:'finished'}),/尚未发布/);
  const step=formatRuntimeLog({taskId:'known-task',kind:'switch',operation:'commit',stage:'finished'});
  assert.match(step,/切换备份位置.*提交本次存储变更.*本步骤完成/);assert.doesNotMatch(step,/任务完成/);
  assert.match(formatRuntimeLog({taskId:'known-task',kind:'switch',stage:'completed'}),/任务完成/);
  assert.doesNotMatch(formatRuntimeLog({operation:'putFullMessages',stage:'finished'}),/酒馆.*已保存/);
  const committed={operation:'abortBackupWrite',stage:'finished',...runtimeLogOutcome('abortBackupWrite',{state:'committed',store:'full_messages',chatKey:'SECRET'})};
  assert.match(formatRuntimeLog(committed),/备份已经提交，未执行暂存撤销/);assert.doesNotMatch(JSON.stringify(committed),/SECRET/);
  assert.match(formatRuntimeLog({operation:'getBackupWriteStatus',stage:'finished',...runtimeLogOutcome('getBackupWriteStatus',null)}),/未找到写入回执.*继续核对/);
});

test('结果未知、读取取消和数据库异常提供不同的处理指引，保留诊断代码',()=>{
  assert.match(formatRuntimeLog({operation:'getBackupPage',stage:'error',errorCode:'cancelled'}),/读取已取消.*可重新查看/);
  assert.match(formatRuntimeLog({operation:'commitBackupWrite',stage:'timeout',errorCode:'outcome-unknown'}),/结果尚待核对.*先检查保存状态或存储任务记录/);
  assert.match(formatRuntimeLog({operation:'getBackupPage',stage:'error',errorCode:'backup-version-changed'}),/备份内容.*变化.*重新查看/);
  assert.match(formatRuntimeLog({operation:'putFullMessages',stage:'error',errorCode:'database-error',sqliteCode:13}),/服务器空间不足.*database-error/);
  assert.match(formatRuntimeLog({operation:'putFullMessages',stage:'error',errorCode:'database-error',sqliteCode:8}),/只读.*写入权限/);
  assert.match(formatRuntimeLog({operation:'putFullMessages',stage:'error',errorCode:'ERR_SQLITE_ERROR',sqliteCode:13}),/服务器空间不足.*ERR_SQLITE_ERROR/);
});

test('日志说明初始化阶段和等待时间，未知旧操作安全回退，时区可显式选择',()=>{
  const text=formatRuntimeLog({operation:'initialize',workStage:'startup-audit',stage:'error',errorCode:'database-unavailable',elapsedMs:51400,queuedMs:50000,payload:'SECRET'});
  assert.match(text,/准备服务器存储.*逐页检查已有备份.*51.4 秒.*等待 50.0 秒/);assert.doesNotMatch(text,/SECRET/);
  for(const operation of ['future-operation','constructor','toString'])assert.match(formatRuntimeLog({operation,stage:'error',errorCode:'constructor'}),/其他服务器存储操作.*未识别的操作异常/);
  assert.match(formatRuntimeLog({timestamp:'2026-11-19T16:00:00Z',operation:'_status',stage:'finished'},{utc:true}),/^2026-11-19T16:00:00Z/);
});
