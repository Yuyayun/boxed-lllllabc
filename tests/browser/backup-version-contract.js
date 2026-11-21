import { backupVersionCases } from '../contracts/backup-version-contract.js';
import { createIndexedDbStorage } from '../../src/storage/indexeddb-adapter.js';
import * as batches from '../../src/storage/backup-batches.js';
import { createBatchCleanupPlan } from '../../src/backup/batch-cleanup.js';
import { createRestoreController } from '../../src/controllers/restore-controller.js';
import { canonicalizeMessage } from '../../src/backup/canonicalize.js';
import * as database from '../../src/db/index.js';

const assert = (value, message) => { if (!value) throw new Error(message); };
export async function runBackupVersionContract() {
  if (location.hostname !== '127.0.0.1') throw new Error('仅在隔离测试 origin 执行');
  const checks = [], adapter = createIndexedDbStorage();
  for (const { name, run } of backupVersionCases({ ...batches, createBatchCleanupPlan })) {
    const opened = await adapter.open();
    try { await run({ ...opened, testMode: 'indexeddb' }); checks.push(name); }
    finally { opened.close(); }
  }

  const session = await adapter.open(), key = `character:preview-test.png:${crypto.randomUUID()}`;
  const identity = { ok: true, chatKey: key, meta: { chatKey: key, chatType: 'character', chatId: key, characterAvatar: 'preview-test.png' } };
  const chat = Array.from({ length: 95 }, (_, i) => ({ mes: `当前 ${i}`, is_user: true }));
  const rows = chat.map((_row, index) => ({ ...canonicalizeMessage({ mes: `备份 ${index}`, is_user: true }, index), chatKey: key }));
  chat.pop(); // Recent restore appends a missing tail rather than replacing an existing floor.
  try {
    await session.replaceRecentSnapshot({ meta: identity.meta, messages: [rows[94]] });
    await session.replaceFullSnapshot({ chatKey: key, messages: rows, meta: { ...identity.meta, fullBackupState: 'frozen' } });
    await session.putHistoricalChanges([{ chatKey: key, messageIndex: 26, message: rows[26], canonicalHash: rows[26].canonicalHash }]);
    await session.putPendingChanges([{ id: `${key}:26`, chatKey: key, messageIndex: 26, message: rows[26], canonicalHash: rows[26].canonicalHash }]);
    const actions = [
      ['onPreviewFull', undefined, ['full_messages', 'pending_changes']],
      ['onPreviewRecent', 94, ['pending_changes', 'recent_messages']],
      ['onPreviewHistorical', 26, ['historical_changes', 'pending_changes']],
      ['onPreviewPending', undefined, ['pending_changes']],
      ['onRequestSave', undefined, ['pending_changes']],
      ['onOpenRecovery', undefined, ['full_messages', 'historical_changes', 'pending_changes', 'recent_messages']],
    ];
    for (const [action, argument, expectedStores] of actions) {
      const read = new Set(); let recentUpdates = 0, saveDialog = false;
      const storage = { getMode: () => 'indexeddb', open: async () => ({ ...session, close() {}, async getBackupPage(options) {
        read.add(options.store);
        assert(expectedStores.includes(options.store), `${action} 读取了无关正文 ${options.store}`);
        if (action === 'onPreviewFull' && options.store === 'full_messages') {
          recentUpdates++;
          await session.replaceRecentSnapshot({ meta: identity.meta, messages: [{ ...rows[94], canonicalHash: `recent-${recentUpdates}` }] });
          await session.reconcileChatIdentity(identity);
        }
        return session.getBackupPage(options);
      } }) };
      const controller = createRestoreController({ storage, getContextReader: () => ({ readCurrentChat: () => ({ ok: true, identity, chat }) }),
        getSettings: () => ({ enabled: true }), setStatus() {}, openSaveDialog() { saveDialog = true; } });
      const ui = controller.createRestoreUiState({ current: { ok: true, identity, chat }, messages: [rows[94]], pending: [], meta: identity.meta, summary: await session.getBackupSummary(key) });
      const result = await ui[action](argument);
      assert(result?.ok !== false, `${action} 读取失败: ${result?.reason}`);
      assert(JSON.stringify([...read].sort()) === JSON.stringify(expectedStores), `${action} 依赖不完整`);
      if (action === 'onRequestSave') assert(saveDialog, '保存确认窗口没有打开');
      else assert(document.querySelector(action === 'onOpenRecovery' ? '#boxed-lllllabc-recovery-center-dialog' : '#boxed-lllllabc-restore-dialog'), `${action} 未生成预览`);
      if (action === 'onPreviewFull') assert(recentUpdates === 2, '完整预览应在 recent 交错更新时一次读完');
      document.querySelectorAll('.boxed-lllllabc-dialog').forEach(element => element.remove());
      checks.push(`真实入口依赖: ${action}`);
    }

    // Exercise the raw-key delete branch, including an already absent key.
    const db = await database.openBackupDatabase();
    try {
      const before = await session.getBackupSummary(key);
      await database.deletePendingChanges(db, ['nonexistent-version-test-id']);
      const after = await session.getBackupSummary(key);
      assert(after.scopes.pending_changes.revision === before.scopes.pending_changes.revision, '删除不存在的键不应推进版本');
      await database.deletePendingChanges(db, [`${key}:26`]);
      const deleted = await session.getBackupSummary(key);
      assert(deleted.scopes.pending_changes.revision === before.scopes.pending_changes.revision + 1, '真实键删除必须推进版本');
      checks.push('原生键删除仅在记录存在时推进版本');
    } finally { db.close(); }
  } finally { session.close(); }
  return checks;
}
