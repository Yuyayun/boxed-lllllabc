import test from 'node:test';
import assert from 'node:assert/strict';
import { createRestoreController } from '../src/controllers/restore-controller.js';
import { currentSnapshotFingerprint, sameSnapshotContent } from '../src/snapshots/model.js';
import { readBackupCatalog } from '../src/storage/catalog-reader.js';

test('完整恢复延迟到预览；分页失败不应用聊天，也不冒充存储不可用', async () => {
  const current = { ok: true, identity: { chatKey: 'chat' }, chat: [{ mes: 'original' }] };
  let reads = 0, status;
  const session = { capabilities: { boundedBackup: 1 }, close() {}, getBackupSummary: async () => ({ revision: 1, meta: {}, counts: { pending_changes: 0, full_messages: 100, recent_messages: 0 } }), getBackupPage: async options => { reads++; if (options.store === 'full_messages') throw new Error('page failed'); return { rows: [], after: null }; } };
  const controller = createRestoreController({ storage: { open: async () => session }, getContextReader: () => ({ readCurrentChat: () => current }), getSettings: () => ({ enabled: true }), setStatus: value => { status = value; } });
  const ui = controller.createRestoreUiState({ current, messages: [], meta: {}, summary: { counts: { full_messages: 100 } } });
  assert.equal(reads, 0);
  const result = await ui.onPreviewFull();
  assert(!result.ok); assert.equal(current.chat[0].mes, 'original'); assert.equal(status.code, 'backup-read-failed');
});
test('快照整聊比较和临时指纹支持合计超过 200k 节点，既存快照格式不变', async () => {
  const chat = Array.from({ length: 3000 }, (_, i) => ({ mes: String(i), extra: Array.from({ length: 25 }, (_, key) => ({ key, value: true, info: '' })) }));
  const current = { identity: { chatKey: 'chat' }, chat, context: { chatMetadata: {} } };
  const fingerprint = await currentSnapshotFingerprint(current);
  assert.equal(fingerprint.length, 64); assert(sameSnapshotContent(chat, structuredClone(chat)));
  chat[427].mes = 'changed'; assert.notEqual(await currentSnapshotFingerprint(current), fingerprint);
});
test('目录只收集摘要页，单聊天异常保留其他聊天且阻止危险清理', async () => {
  let pages = 0;
  const catalog = await readBackupCatalog({ capabilities: { boundedBackup: 1 }, getBackupCatalogPage: async () => { pages++; return { items: [{ chatKey: 'bad', displayName: 'bad', error: 'bad record', recordCount: 0, storageBytes: 0, pending: { count: 0 } }, { chatKey: 'good', displayName: 'good', recordCount: 2, storageBytes: 100, pending: { count: 0 } }], after: null, revision: 1 }; }, getBackupCatalogData: () => { throw new Error('raw read'); } });
  assert.equal(pages, 1); assert.equal(catalog.chatCount, 2); assert.equal(catalog.invalidRecordCount, 1);
});
