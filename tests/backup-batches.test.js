import test from 'node:test';
import assert from 'node:assert/strict';
import { backupBatches, writeBackupRecords } from '../src/storage/backup-batches.js';

test('备份同时按条数、协议字节和结构节点切批', () => {
  assert.equal(backupBatches(Array.from({ length: 51 }, () => ({ text: 'small' }))).length, 2);
  assert(backupBatches(Array.from({ length: 8 }, () => ({ text: 'x'.repeat(200000) }))).length > 1);
  assert(backupBatches(Array.from({ length: 40 }, () => ({ values: Array(2000).fill(null) }))).length > 1);
});
test('来源变化不提交暂存；旧后端大操作提示更新', async () => {
  let committed = false, aborted = false, checks = 0;
  const session = { capabilities: { boundedBackup: 1 }, getBackupSummary: async () => ({ revision: 0 }), beginBackupWrite: async () => ({ id: 'job' }), appendBackupWrite: async () => {}, commitBackupWrite: async () => { committed = true; }, abortBackupWrite: async () => { aborted = true; } };
  await assert.rejects(writeBackupRecords(session, { chatKey: 'chat', store: 'full_messages', rows: [{ messageIndex: 0 }], replace: true, sourceUnchanged: () => ++checks < 2 }), { code: 'backup-source-changed' });
  assert(!committed && aborted);
  await assert.rejects(writeBackupRecords({}, { chatKey: 'chat', store: 'full_messages', rows: Array.from({ length: 51 }, (_, messageIndex) => ({ messageIndex })) }), { code: 'backup-upgrade-required' });
});
test('提交回执丢失时查询结果，不能把已提交备份报成未写入', async () => {
  const session = { capabilities: { boundedBackup: 1 }, getBackupSummary: async () => ({ revision: 0 }), beginBackupWrite: async () => ({ id: 'job' }), appendBackupWrite: async () => {}, commitBackupWrite: async () => { throw new TypeError('connection lost'); }, getBackupWriteStatus: async () => ({ state: 'committed' }) };
  assert.equal((await writeBackupRecords(session, { chatKey: 'chat', store: 'full_messages', rows: [], replace: true })).state, 'committed');
});
