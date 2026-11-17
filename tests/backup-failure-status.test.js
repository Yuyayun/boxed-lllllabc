import test from 'node:test';
import assert from 'node:assert/strict';
import { backupFailureStatus } from '../src/backup/failure-status.js';

test('系统不可用、当前操作失败和结果未知使用简明且不同的语义', () => {
  assert.equal(backupFailureStatus(Object.assign(new Error('offline'), { code: 'unavailable' })).code, 'db-error');
  const limited = backupFailureStatus(Object.assign(new Error('批次超限'), { code: 'too-large' }));
  assert.equal(limited.code, 'backup-update-failed'); assert.match(limited.detail, /已有备份仍保留/);
  const unknown = backupFailureStatus(Object.assign(new Error('结果待核对'), { code: 'outcome-unknown' }));
  assert.equal(unknown.shortText, '备份结果待核对'); assert.doesNotMatch(unknown.detail, /保持不变|未写入/);
  assert.equal(backupFailureStatus(Object.assign(new Error('读取中断'), { name: 'AbortError' }), '读取').code, 'backup-read-failed');
});
