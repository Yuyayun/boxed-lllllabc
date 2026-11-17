export function createBackupStatus(code, shortText, detail = '') {
  const errorName = detail instanceof Error ? String(detail.name || '') : '';
  const quotaFailure = code === 'db-error' && errorName === 'QuotaExceededError';
  return { code, shortText: quotaFailure ? '空间不足，备份未写入' : shortText,
    detail: detail instanceof Error ? detail.message : String(detail ?? ''),
    ...(errorName ? { errorName } : {}), ...(detail?.code ? { storageErrorCode: detail.code } : {}), updatedAt: new Date().toISOString() };
}
