import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackendVerifier } from '../src/controllers/backend-verifier.js';
import { hashCanonicalChat } from '../src/backup/canonicalize.js';
import { createMessageRecord } from '../src/backup/pending.js';

function fixture(path, confirmFullBackup) {
  const chat = [{ mes: 'current message', swipes: ['current message'], swipe_id: 0 }];
  let pending = path === 'pending' ? [createMessageRecord({ chatKey: 'chat', messageIndex: 0, kind: 'message_edit', message: chat[0] })] : [];
  let latest = { code: 'idle' }, confirmations = 0, refreshes = 0;
  const statuses = [], meta = [];
  const verifier = createBackendVerifier({
    getContextReader: () => ({ readCurrentChat: () => ({ ok: true, chat, identity: { chatKey: 'chat' } }) }),
    getSettings: () => ({ enabled: true }), getLatestStatus: () => latest,
    setStatus: status => { latest = status; statuses.push(status); },
    refreshVisiblePanel: async () => { refreshes++; }, prioritizeFullBackupStatus: async (_key, status) => status,
    readCurrentPending: async () => pending,
    deleteConfirmedPending: async records => { assert.equal(records.length, 1); pending = []; },
    updateBackendMeta: async (_key, outcome) => meta.push(outcome),
    createDisplayStatus: code => ({ code }), needsFullBackupConfirmation: async () => true,
    confirmFullBackup: async () => { confirmations++; return confirmFullBackup(); },
    readBackend: async () => ({ ok: true, chat: [{ chat_metadata: {} }, ...structuredClone(chat)] }),
    retryDelays: [],
  });
  return { verifier, statuses, meta, get pending() { return pending; }, get latest() { return latest; }, get confirmations() { return confirmations; }, get refreshes() { return refreshes; },
    run: () => path === 'pending' ? verifier.verifyBackendNow({ chatKey: 'chat' }) : verifier.verifyBackendSnapshotNow({ chatKey: 'chat', expectedChatHash: hashCanonicalChat(chat) }) };
}

for (const path of ['pending', 'snapshot']) {
  for (const code of ['db-error', 'backup-update-failed', 'full-frozen', 'full-awaiting-confirmation']) {
    test(`${path} 核对保留完整备份确认返回的 ${code}，不发布 saved 或成功元数据`, async () => {
      const failure = { code, shortText: '完整备份尚未确认', detail: '保留原始失败说明' };
      const run = fixture(path, () => failure);
      const status = await run.run(); await run.verifier.whenIdle();
      assert.equal(run.confirmations, 1);
      assert.equal(run.refreshes, 1);
      assert.equal(status, failure); assert.equal(run.latest, failure);
      assert.equal(run.statuses.some(value => value.code === 'saved'), false);
      assert.equal(run.meta.includes('saved'), false);
      if (path === 'pending') assert.equal(run.pending.length, 1, '完整备份未完成不能先删 pending');
    });
  }
  test(`${path} 核对完整备份确认成功时仍发布 saved`, async () => {
    const run = fixture(path, () => null);
    const status = await run.run();
    assert.equal(run.confirmations, 1); assert.equal(status.code, 'saved'); assert.deepEqual(run.meta, ['saved']);
  });
  test(`${path} 核对在完整备份确认期间取消后，不发布旧确认失败`, async () => {
    let resolve, started;
    const waiting = new Promise(done => { resolve = done; });
    const confirming = new Promise(done => { started = done; });
    const run = fixture(path, async () => { started(); return waiting; });
    const operation = run.run(); await confirming;
    run.verifier.clearScheduledVerification();
    const before = run.latest;
    resolve({ code: 'backup-update-failed', shortText: '旧任务失败' });
    await operation; await run.verifier.whenIdle();
    assert.equal(run.latest, before); assert.equal(run.meta.includes('saved'), false);
    assert.equal(run.statuses.some(status => status.code === 'backup-update-failed'), false);
  });
}

test('自动核对读取 pending 失败时有限重试，保留原状态且不产生未处理拒绝', async t => {
  t.mock.method(console, 'warn', () => {});
  const callbacks = []; let reads = 0, next = 0, latest = { code: 'saved' };
  const verifier = createBackendVerifier({
    getSettings: () => ({ enabled: true }), getContextReader: () => ({ readCurrentChat: () => ({ ok: true, identity: { chatKey: 'chat' }, chat: [] }) }),
    getLatestStatus: () => latest, setStatus: status => { latest = status; }, readCurrentPending: async () => { reads++; throw new Error('read unavailable'); },
    retryDelays: [1, 2], setTimer: callback => { callbacks.push(callback); return ++next; }, clearTimer() {},
  });
  verifier.scheduleBackendVerification('chat', 0, 0);
  for (let n = 0; callbacks.length && n < 5; n++) await callbacks.shift()();
  assert.equal(reads, 3); assert.equal(callbacks.length, 0); assert.equal(latest.code, 'saved');
});
