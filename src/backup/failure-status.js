import { createBackupStatus } from './recent.js';

export function backupFailureStatus(error, operation = '更新') {
  if (['database-unavailable','unavailable','permission-denied','owner-mismatch','protocol-incompatible'].includes(error?.code)) return createBackupStatus('db-error', '备份不可用', error);
  if (error?.code === 'backup-upgrade-required') return createBackupStatus('backup-update-failed', '服务器备份插件需要更新', error);
  if (error?.code === 'outcome-unknown' || ['AbortError','TimeoutError'].includes(error?.name)) return createBackupStatus('backup-update-failed', '备份结果待核对', error);
  return createBackupStatus(operation === '读取' ? 'backup-read-failed' : 'backup-update-failed', operation === '读取' ? '当前聊天备份读取失败' : '当前聊天备份更新失败', error);
}
