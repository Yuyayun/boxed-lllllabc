import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshBoundedFullBackup } from '../src/backup/full-bounded.js';
import { canonicalizeMessage } from '../src/backup/canonicalize.js';
import { createFullBackupDecision } from '../src/backup/full.js';
import { createBackupCoordinator } from '../src/controllers/backup-coordinator.js';
import { nativeMessageHash } from '../src/backup/native-content.js';

test('已确认的新消息与编辑使用目标楼层并集，不读取正文或全部摘要', async () => {
  const current = { ok: true, identity: { chatKey: 'chat' }, chat: Array.from({ length: 3001 }, (_, i) => ({ mes: String(i) })) };
  const nativeHashes=current.chat.slice(0,3000).map(nativeMessageHash);
  current.chat[427].mes = 'edited'; let written;
  const session = { capabilities: { boundedBackup: 1 }, getBackupSummary: async () => ({ meta: { fullBackupAt: 'before' }, counts: { full_messages: 3000 }, revision: 1 }), getBackupPage: () => { throw new Error('must not read'); }, applyBackupPatch: async options => { written = options; } };
  await refreshBoundedFullBackup({ session, current, triggers: [{ eventName: 'message_edited', args: [427] }, { eventName: 'message_received', args: [3000] }], views: new Map([['chat', { count: 3000, at: 'before',nativeHashes }]]), readCurrent: () => current });
  assert.deepEqual(written.rows.map(row => row.messageIndex), [427, 3000]);
});
test('旧决策的混合事件同样不能遗漏旧楼层编辑', () => {
  const result = createFullBackupDecision({ existingMessages: [canonicalizeMessage({ mes: 'old' }, 0)], currentChat: [{ mes: 'edited' }, { mes: 'new' }], triggers: [{ eventName: 'message_edited', args: [0] }, { eventName: 'message_received', args: [1] }] });
  assert.deepEqual(result.messages.map(row => row.messageIndex), [0, 1]);
});
test('无事件的原地来源变化在最终提交前被拦截', async () => {
  const current = { ok: true, identity: { chatKey: 'chat' }, chat: [{ mes: 'original' }] }; let committed = false;
  const session = { capabilities: { boundedBackup: 1 }, getBackupSummary: async () => ({ meta: {}, counts: { full_messages: 0 }, revision: 0 }), beginBackupWrite: async () => ({ id: 'job' }), appendBackupWrite: async () => { current.chat[0].mes = 'changed'; }, abortBackupWrite: async () => {}, commitBackupWrite: async () => { committed = true; } };
  await assert.rejects(refreshBoundedFullBackup({ session, current, triggers: [{ eventName: 'extension-loaded', args: [] }], views: new Map(), readCurrent: () => current }), { code: 'backup-source-changed' });
  assert(!committed);
});
test('完整备份失败仍保存 pending，且后续保存核对不能覆盖失败状态', async () => {
  let written = false, latest;
  const current = { ok: true, chat: [{ mes: 'new' }], identity: { ok: true, chatKey: 'chat', meta: { chatKey: 'chat' } } };
  const session = { close() {}, reconcileChatIdentity: async () => ({ status: 'current' }), getChatMeta: async () => ({}), putPendingChanges: async () => { written = true; }, getFullMessages: async () => { throw Object.assign(new Error('read limit'), { code: 'too-large' }); } };
  const coordinator = createBackupCoordinator({ storage: { open: async () => session }, getContextReader: () => ({ readCurrentChat: () => current }), getSettings: () => ({ enabled: true, fullBackupEnabled: true, recentBackupEnabled: false, historicalBackupEnabled: false }), getLatestStatus: () => latest, setStatus: value => { latest = value; }, refreshVisiblePanel: async () => {}, readChatCatalog: async () => [] });
  const previous = console.error; console.error = () => {};
  try { await coordinator.runBackupNow({ eventName: 'message_received', args: [0] }); } finally { console.error = previous; }
  assert(written); assert.equal(latest.code, 'backup-update-failed');
  assert.equal((await coordinator.prioritizeFullBackupStatus('chat', { code: 'saved' })).code, 'backup-update-failed');
});
