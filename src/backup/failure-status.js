import { createBackupStatus } from './status.js';

export function backupFailureStatus(error, operation = '更新') {
  if (error?.code === 'backup-client-upgrade-required') return createBackupStatus('backup-update-failed', '前端扩展需要更新', error);
  if (['backup-database-blocked','backup-database-timeout'].includes(error?.code)) return createBackupStatus('db-error', '本地备份暂不可用', error);
  if (['backup-local-paused','backup-control-unavailable'].includes(error?.code)) return createBackupStatus('db-error', '本地备份暂时暂停', error);
  if (['database-unavailable','unavailable','permission-denied','owner-mismatch','protocol-incompatible'].includes(error?.code)) return createBackupStatus('db-error', '备份不可用', error);
  if (error?.code === 'backup-upgrade-required') return createBackupStatus('backup-update-failed', '服务器备份插件需要更新', error);
  if (operation !== '读取' && (error?.code === 'outcome-unknown' || error?.backupTransactionOutcome !== 'aborted' && ['AbortError','TimeoutError'].includes(error?.name))) return createBackupStatus('backup-update-failed', '备份结果待核对', error);
  const status = createBackupStatus(operation === '读取' ? 'backup-read-failed' : 'backup-update-failed', operation === '读取' ? '当前聊天备份读取失败' : error?.name === 'QuotaExceededError' ? '空间不足，备份未写入' : '当前聊天备份更新失败', error);
  if (operation !== '读取' && !/保留/.test(status.detail)) status.detail += ' 已有备份仍保留。';
  return status;
}
