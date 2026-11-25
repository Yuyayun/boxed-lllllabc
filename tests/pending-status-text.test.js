import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackupCoordinator} from '../src/controllers/backup-coordinator.js';
import {createMessageRecord,summarizePendingChanges} from '../src/backup/pending.js';
import {createPendingObserver,createRestoreJournal} from '../src/backup/pending-journal.js';

const coordinator = createBackupCoordinator({});
const old = messageIndex => createMessageRecord({chatKey:'copy-fixture',messageIndex,kind:'message_edit',message:{mes:'fixture'}});
function capture(before, after, eventName = 'message_updated', args = []) {
  const current = {ok:true,chat:structuredClone(before),identity:{chatKey:'copy-fixture'}};
  const observer = createPendingObserver({readCurrent:()=>current});observer.reset();current.chat=structuredClone(after);
  return observer.capture({eventName,args}).records;
}

test('四种拼接提示改为完整句子，状态码、详情、原记录及其他状态不变',()=>{
  const pending=[old(10)],before=structuredClone(pending),summary=summarizePendingChanges(pending);
  for (const [code,text,expected] of [
    ['checking','正在检查保存状态','正在核对第 10 层是否已保存'],
    ['unconfirmed','酒馆保存待确认','第 10 层保存待确认'],
    ['verify-unavailable','无法确认保存状态','暂时无法核对第 10 层是否已保存'],
    ['unconfirmed','酒馆已保存，备份待补全','酒馆已保存，第 10 层备份待补全'],
  ]) {
    const status=coordinator.createDisplayStatus(code,text,'原详情',pending);
    assert.equal(status.code,code);assert.equal(status.detail,'原详情');assert.equal(status.shortText,expected);
  }
  assert.deepEqual(pending,before);assert.deepEqual(summarizePendingChanges(pending),summary);
  for(const [code,text] of [['saved','酒馆聊天已保存'],['disabled','备份未启用'],['full-frozen','完整备份已暂停更新']])
    assert.equal(coordinator.createDisplayStatus(code,text).shortText,text);
  assert.equal(coordinator.createDisplayStatus('unconfirmed','酒馆保存待确认').shortText,'酒馆保存待确认');
});

test('新版编辑与追加从操作位置显示楼层；不连续楼层不捏造成整段',()=>{
  const edit=capture([{mes:'a'},{mes:'b'},{mes:'c'}],[{mes:'a'},{mes:'changed'},{mes:'c'}],'message_updated',[1]);
  assert.equal(coordinator.createDisplayStatus('unconfirmed','酒馆保存待确认','',edit).shortText,'第 1 层保存待确认');
  const append=capture([{mes:'a'}],[{mes:'a'},{mes:'new'},{mes:'newer'}],'message_received',[1]);
  assert.equal(coordinator.createDisplayStatus('unconfirmed','酒馆保存待确认','',append).shortText,'第 1–2 层保存待确认');
  assert.equal(coordinator.createDisplayStatus('unconfirmed','酒馆保存待确认','',[old(10),old(12)]).shortText,'第 10、12 层保存待确认');
  assert.equal(coordinator.createDisplayStatus('unconfirmed','酒馆保存待确认','',[0,2,4,6].map(old)).shortText,'多处改动保存待确认');
});

test('删除用操作前的位置，不把移动后的楼层写成未保存消息',()=>{
  const before=['a','b','c','d'].map(mes=>({mes}));
  const rows=capture(before,[before[0],before[3]],'message_deleted',[1]);
  assert.equal(coordinator.createDisplayStatus('unconfirmed','酒馆保存待确认','',rows).shortText,'原第 1–2 层的删除待确认');
  assert.equal(coordinator.createDisplayStatus('checking','正在检查保存状态','',rows).shortText,'正在核对原第 1–2 层的删除结果');
  const later=capture([before[0],before[3]],[before[0]],'message_deleted',[1]);
  assert.equal(coordinator.createDisplayStatus('unconfirmed','酒馆保存待确认','',[...rows,...later]).shortText,'多次删除待确认');
});

test('恢复提示涵盖被替代的旧记录，未知位置和混合操作保守描述',()=>{
  const previous=[old(99)],restore=createRestoreJournal({chat:[{mes:'a'}],targetChat:[{mes:'b'}],chatKey:'copy-fixture',pending:previous});
  assert.equal(coordinator.createDisplayStatus('unconfirmed','酒馆保存待确认','',[...previous,...restore]).shortText,'恢复内容保存待确认');
  assert.equal(coordinator.createDisplayStatus('unconfirmed','酒馆保存待确认','',[{messageIndex:null,kind:'message_delete'}]).shortText,'旧改动保存待确认');
  assert.equal(coordinator.createDisplayStatus('unconfirmed','酒馆保存待确认','',[{pendingFormat:1,pendingType:'observation_gap'}]).shortText,'聊天改动保存待确认');
  assert.equal(coordinator.createDisplayStatus('unconfirmed','酒馆保存待确认','',[...previous,...restore,old(3)]).shortText,'多处改动保存待确认');
});
