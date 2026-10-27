import { renderCurrentChatPanel } from '/scripts/extensions/third-party/boxed-lllllabc/src/ui/current-chat-panel.js';
import { updateStatusLine, openStatusDialog, closeStatusDialog } from '/scripts/extensions/third-party/boxed-lllllabc/src/ui/status-line.js';
import { openFrozenBackupDialog, closeFrozenBackupDialog } from '/scripts/extensions/third-party/boxed-lllllabc/src/ui/frozen-backup-dialog.js';
import { openSaveRequestDialog, closeSaveRequestDialog } from '/scripts/extensions/third-party/boxed-lllllabc/src/ui/save-request-dialog.js';
import { renderBatchCleanupSection, closeBatchCleanupDialog } from '/scripts/extensions/third-party/boxed-lllllabc/src/ui/batch-cleanup.js';
import { buildBackupCatalog } from '/scripts/extensions/third-party/boxed-lllllabc/src/backup/catalog.js';
import { createBatchCleanupPlan } from '/scripts/extensions/third-party/boxed-lllllabc/src/backup/batch-cleanup.js';
import { batchData } from './batch-fixture.js';

const allowed = () => { if (location.origin !== 'http://127.0.0.1:18000') throw new Error('只允许隔离测试酒馆'); };
export function showCopyPanel(frozen = false) {
  allowed();
  const data = batchData(), key = data.chatMeta[frozen ? 1 : 0].chatKey;
  const status = { code: frozen ? 'full-frozen' : 'unconfirmed', shortText: frozen ? '完整备份已暂停更新' : '酒馆保存待确认',
    detail: frozen ? '聊天内容疑似异常缩短，完整备份已保留。' : '酒馆聊天文件内容尚未与当前聊天一致。', updatedAt: new Date().toISOString() };
  updateStatusLine(status); openStatusDialog();
  const body = document.querySelector('#boxed-lllllabc-status-dialog .boxed-lllllabc-dialog-body');
  renderCurrentChatPanel(body, { status, meta: data.chatMeta[frozen ? 1 : 0], messages: data.recentMessages.filter(r => r.chatKey === key),
    fullMessages: data.fullMessages.filter(r => r.chatKey === key), pending: data.pendingChanges.filter(r => r.chatKey === key),
    settings: { enabled: true, recentBackupEnabled: true, fullBackupEnabled: true },
    restore: { onRequestSave() {}, onOpenRecovery() {} }, onVerify() {}, onCreateSnapshot() {} });
}
export function showCopyFrozen() {
  allowed(); closeStatusDialog();
  openFrozenBackupDialog({ plan: { chatName: '文案验收聊天', backupCount: 8, currentCount: 3,
    backupRange: '第 0–7 层', currentRange: '第 0–2 层', incidentText: '聊天内容疑似异常缩短。' }, onConfirm() { throw new Error('只检查文案，不执行备份操作'); } });
}
export function showCopySave() {
  allowed(); closeFrozenBackupDialog();
  openSaveRequestDialog({ chatName: '文案验收聊天', pending: batchData().pendingChanges,
    onConfirm() { throw new Error('只检查文案，不请求保存'); } });
}
export function showCopyBatch(mode) {
  allowed(); closeStatusDialog(); closeFrozenBackupDialog(); closeSaveRequestDialog(); closeBatchCleanupDialog();
  document.getElementById('boxed-copy-fixture')?.remove();
  const catalog = buildBackupCatalog(batchData()), host = document.createElement('div');
  host.id = 'boxed-copy-fixture';
  host.append(renderBatchCleanupSection({ catalog,
    onPreview: selection => createBatchCleanupPlan({ catalog, selection, mode }),
    onExecute() { throw new Error('只检查预览文案，不执行删除'); } }));
  document.body.append(host);
  host.querySelector('details').open = true;
  host.querySelector('button').click();
}
