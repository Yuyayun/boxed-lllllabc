import test from 'node:test';
import assert from 'node:assert/strict';
import { protectPendingRecord, pendingRepairTriggers } from '../src/backup/pending-protection.js';
import { createMessageRecord, createStructuralPendingRecord } from '../src/backup/pending.js';
import { canonicalizeMessage, hashCanonicalChat } from '../src/backup/canonicalize.js';
import { createBackupOperations } from '../src/storage/operations.js';
import { readBackupRecords } from '../src/storage/backup-batches.js';

const settings = { fullBackupEnabled: true, historicalBackupEnabled: true, recentBackupEnabled: true, recentLimit: 10 };
function fixture() {
  const tables = new Map(['chat_meta', 'pending_changes', 'full_messages', 'historical_changes', 'recent_messages'].map(name => [name, new Map()]));
  const key = (store, row) => JSON.stringify(store === 'chat_meta' ? row.chatKey : store === 'pending_changes' ? row.id : [row.chatKey, row.messageIndex]);
  const driver = name => ({ get: value => tables.get(name).get(JSON.stringify(value)), put: row => tables.get(name).set(key(name, row), structuredClone(row)), delete: value => tables.get(name).delete(JSON.stringify(value)) });
  const operations = createBackupOperations({
    requestToPromise: async value => value,
    runTransaction: async (_db, names, _mode, callback) => {
      return callback(new Map(names.map(name => [name, driver(name)])));
    },
  });
  const record = protectPendingRecord(createMessageRecord({ chatKey: 'chat', messageIndex: 26, kind: 'message_edit', message: { is_user: true, mes: 'new' } }), settings, 1136);
  return { operations, record, driver, tables };
}

test('旧 user 编辑必须留待 historical/full 完成，最近楼层另外要求 recent 完成', () => {
  const f = fixture();
  assert.deepEqual(f.record.backupTargets, ['full_messages', 'historical_changes']);
  assert.deepEqual(protectPendingRecord({ ...f.record, messageIndex: 1135 }, settings, 1136).backupTargets, ['recent_messages', 'full_messages']);
});

test('酒馆已确认但 historical 或 full 仍旧时，事务内拒绝删除最后一份新正文保护', async () => {
  const f = fixture(), expected = f.record;
  f.driver('pending_changes').put(expected);
  const fresh = { ...expected.message, chatKey: 'chat' };
  f.driver('full_messages').put(fresh);
  f.driver('historical_changes').put({ chatKey: 'chat', messageIndex: 26, message: canonicalizeMessage({ mes: 'old' }, 26) });
  assert.deepEqual(await f.operations.deletePendingChangesIfUnchanged(null, [expected]), []);
  assert(f.driver('pending_changes').get(expected.id));
  f.driver('historical_changes').put({ chatKey: 'chat', messageIndex: 26, message: fresh });
  assert.deepEqual(await f.operations.deletePendingChangesIfUnchanged(null, [expected]), [expected.id]);
});

test('保护目标改变或核对期间取消时，旧任务不能删记录', async () => {
  const f = fixture(); f.driver('pending_changes').put(f.record);
  assert.deepEqual(await f.operations.deletePendingChangesIfUnchanged(null, [{ ...f.record, backupTargets: [] }]), []);
  f.driver('full_messages').put({ ...f.record.message, chatKey: 'chat' });
  f.driver('historical_changes').put({ chatKey: 'chat', messageIndex: 26, message: f.record.message });
  let checks = 0;
  assert.deepEqual(await f.operations.deletePendingChangesIfUnchanged(null, [f.record], { shouldDelete: () => ++checks < 2 }), []);
});

test('持久 pending 生成补写目标，但不会把旧 B 覆盖到用户新改的 C', () => {
  const f = fixture(), current = { identity: { chatKey: 'chat' }, chat: Array.from({ length: 1136 }, () => ({ mes: '' })) };
  current.chat[26] = { is_user: true, mes: 'new' };
  assert.deepEqual(pendingRepairTriggers([f.record], current, settings), [{ eventName: 'message_edited', args: [26] }]);
  current.chat[26].mes = 'newer'; assert.deepEqual(pendingRepairTriggers([f.record], current, settings), []);
});

test('聊天结构保护先要求完整副本哈希一致，后来的普通 full 写入撤销旧证明', async () => {
  const f = fixture(), chat = [{ mes: 'current' }], hash = hashCanonicalChat(chat);
  const record = protectPendingRecord(createStructuralPendingRecord({ chatKey: 'chat', kind: 'restore', chat }), settings, chat.length);
  f.driver('pending_changes').put(record); f.driver('chat_meta').put({ chatKey: 'chat', fullBackupChatHash: 'old' });
  assert.deepEqual(await f.operations.deletePendingChangesIfUnchanged(null, [record]), []);
  f.driver('chat_meta').put({ chatKey: 'chat', fullBackupChatHash: hash });
  await f.operations.putFullMessages(null, { chatKey: 'chat', messages: [canonicalizeMessage({ mes: 'changed' }, 0)] });
  assert.deepEqual(await f.operations.deletePendingChangesIfUnchanged(null, [record]), []);
  f.driver('chat_meta').put({ chatKey: 'chat', fullBackupChatHash: hash });
  assert.deepEqual(await f.operations.deletePendingChangesIfUnchanged(null, [record]), [record.id]);
});

test('稳定版本下的损坏记录不当成时序冲突重试', async () => {
  let reads = 0;
  const session = { capabilities: { boundedBackup: 1 }, getBackupSummary: async () => ({ revision: 3, counts: { full_messages: 1 } }), getBackupPage: async () => { reads++; throw Object.assign(new Error('bad record'), { code: 'backup-conflict' }); } };
  await assert.rejects(readBackupRecords(session, 'chat', 'full_messages'), /bad record/); assert.equal(reads, 1);
});
