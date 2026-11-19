// Storage safety regressions derived from the reproduced 1.0.2 defects.
// Run with Node 22.14+ and BOXED_SERVER_ROOT pointing at the 1.0.2 server source:
// node --test --test-concurrency=1 tests/diagnostics/historical-restore-race.mjs
// All storage is an isolated in-memory SQLite database. No SillyTavern is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBackupCoordinator } from '../../src/controllers/backup-coordinator.js';
import { createBackendVerifier } from '../../src/controllers/backend-verifier.js';
import { createRestoreController } from '../../src/controllers/restore-controller.js';
import { readBackupRecords, readBackupBundle } from '../../src/storage/backup-batches.js';
import { canonicalizeMessage } from '../../src/backup/canonicalize.js';
import { createHistoricalRecord } from '../../src/backup/historical.js';
import { createFullRestorePlan, createHistoricalRestorePlan } from '../../src/backup/restore.js';
import { executeRestorePlan } from '../../src/backup/restore-executor.js';
import fs from 'node:fs';
import os from 'node:os';

const root = fileURLToPath(new URL('../../', import.meta.url));
const serverRoot = process.env.BOXED_SERVER_ROOT ?? path.join(root, '.local-test', 'boxed-lllllabc-server-dev');
const { SqliteRepository } = await import(pathToFileURL(path.join(serverRoot, 'src', 'sqlite.js')).href);
const BEFORE = '修改前的 user 正文';
const AFTER = '修改后的 user 正文';
const chatKey = 'character:diagnostic-only.png:historical-race';

async function fixture({ length = 1136, index = 1116, file = ':memory:' } = {}) {
  let repo = new SqliteRepository(file);
  const settings = { enabled: true, recentBackupEnabled: true, fullBackupEnabled: true, historicalBackupEnabled: true, recentLimit: 10, backendVerifyDelayMs: 2000 };
  const current = {
    ok: true,
    identity: { ok: true, chatKey, meta: { chatKey, chatType: 'character', characterAvatar: 'diagnostic-only.png', chatId: 'historical-race' } },
    chat: Array.from({ length }, (_, n) => ({ name: n === index ? '测试用户' : '测试角色', is_user: n === index, mes: n === index ? BEFORE : `测试正文 ${n}` })),
  };
  let queue = Promise.resolve(), hook = null, latest = { code: 'idle' }, verifier;
  const statuses = [], errors = [], timers = new Map();
  let timerId = 0;
  const direct = (method, ...args) => {
    const operation = queue.then(() => repo.execute(method, args));
    queue = operation.catch(() => {});
    return operation;
  };
  const call = async (method, ...args) => {
    const after = await hook?.(method, args);
    try { const value = await direct(method, ...args); return typeof after === 'function' ? after(value) : value; }
    catch (error) { errors.push({ method, store: args[0]?.store, code: error.code }); throw error; }
  };
  const session = new Proxy({ capabilities: { boundedBackup: 1 }, close() {} }, {
    get: (target, key) => key === 'then' ? undefined : target[key] ?? ((...args) => call(key, ...args)),
  });
  const storage = { open: async () => session };
  let coordinator;
  const initialize = () => {
  coordinator = createBackupCoordinator({
    storage,
    getContextReader: () => ({ readCurrentChat: () => current }),
    getSettings: () => settings,
    getLatestStatus: () => latest,
    setStatus: value => { latest = value; statuses.push(value.code); },
    refreshVisiblePanel: async () => {},
    // Match the production initialization in index.js, including cancellation.
    prepareBackup: async () => { verifier?.clearScheduledVerification(); await verifier?.whenIdle(); },
    clearScheduledVerification: () => verifier?.clearScheduledVerification(),
    verifyBackendNow: options => verifier.verifyBackendNow(options),
    verifyBackendSnapshotNow: options => verifier.verifyBackendSnapshotNow(options),
    scheduleBackendVerification: (...args) => verifier.scheduleBackendVerification(...args),
    scheduleBackendSnapshotVerification: (...args) => verifier.scheduleBackendSnapshotVerification(...args),
    verificationRetryLimit: 0,
    readChatCatalog: async () => ({ ok: true, entries: [] }),
  });
  verifier = createBackendVerifier({
    storage,
    getContextReader: () => ({ readCurrentChat: () => current }),
    getSettings: () => settings,
    getLatestStatus: () => latest,
    setStatus: value => { latest = value; statuses.push(value.code); },
    refreshVisiblePanel: async () => {},
    readCurrentPending: coordinator.readCurrentPending,
    updateBackendMeta: coordinator.updateBackendMeta,
    createDisplayStatus: coordinator.createDisplayStatus,
    prioritizeFullBackupStatus: coordinator.prioritizeFullBackupStatus,
    needsFullBackupConfirmation: coordinator.needsFullBackupConfirmation,
    confirmFullBackup: coordinator.confirmFullBackupAfterBackendVerification,
    ensurePendingBackups: coordinator.ensurePendingBackups,
    onPendingBackupsConfirmed: coordinator.onPendingBackupsConfirmed,
    hasBackupProblem: coordinator.hasBackupProblem,
    // Model a native chat file which already contains the current user edit.
    readBackend: async () => ({ ok: true, chat: [{ chat_metadata: {} }, ...structuredClone(current.chat)] }),
    retryDelays: [],
    setTimer: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimer: id => timers.delete(id),
  });
  };
  initialize();
  const read = store => readBackupRecords(session, chatKey, store);
  const snapshot = async () => {
    const full = await read('full_messages'), historical = await read('historical_changes'), pending = await read('pending_changes');
    const meta = await call('getChatMeta', chatKey);
    return { status: latest.code, full: full[index]?.raw.mes, historical: historical.find(row => row.messageIndex === index)?.message.raw.mes,
      pendingCount: pending.length, pendingTarget: pending.find(row => row.messageIndex === index)?.message.raw.mes,
      fullCount: full.length, fullReason: meta.fullBackupLastReason, fullState: meta.fullBackupState };
  };
  const verify = () => verifier.verifyBackendNow({ chatKey, retryIndex: 0 });
  const nextMessage = async ({ user = false } = {}) => {
    const nextIndex = current.chat.length;
    current.chat.push({ name: user ? '测试用户' : '测试角色', ...(user ? { is_user: true } : {}), mes: `新楼层 ${nextIndex}` });
    coordinator.noteSourceChange();
    return coordinator.runBackupNow({ eventName: user ? 'message_sent' : 'message_received', args: [nextIndex] });
  };
  const edit = () => {
    current.chat[index].mes = AFTER;
    coordinator.noteSourceChange();
    return coordinator.runBackupNow({ eventName: 'message_edited', args: [index] });
  };
  const restoredText = async source => {
    const chat = structuredClone(current.chat);
    chat[index].mes = '模拟需要恢复的损坏内容';
    const pending = await read('pending_changes');
    const plan = source === 'full'
      ? createFullRestorePlan({ chat, chatKey, fullMessages: await read('full_messages'), pending })
      : createHistoricalRestorePlan({ chat, chatKey, historical: await read('historical_changes'), pending, messageIndex: index });
    assert.equal(plan.blockedReason, '');
    // The real restore executor applies the plan to a separate synthetic chat;
    // native rendering and saving remain inert in this storage investigation.
    const result = await executeRestorePlan({
      plan, readCurrent: () => ({ ok: true, chat, identity: { chatKey } }), readPending: async () => pending,
      replacePending: async () => {}, writePending: async () => {}, render: async () => {}, save: async () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(chat[index].is_user, true);
    return chat[index].mes;
  };
  // Establish the real full-backup view cache, then a previous historical edit.
  await coordinator.runBackupNow({ eventName: 'extension-loaded', args: [] });
  await direct('putHistoricalChanges', [createHistoricalRecord({ chat: current.chat, chatKey, eventName: 'message_edited', args: [index], recentLimit: 10, settings })]);
  return { current, settings, storage, get coordinator() { return coordinator; }, get verifier() { return verifier; }, direct, read, snapshot, verify, nextMessage, edit, restoredText, statuses, errors,
    async restart({ database = false } = {}) {
      verifier.clearScheduledVerification(); await queue;
      if (database) { assert.notEqual(file, ':memory:'); repo.close(); repo = new SqliteRepository(file); await repo.initialize(); }
      latest = { code: 'idle' }; initialize();
    },
    setStatus(value) { latest = value; statuses.push(value.code); },
    async runScheduledVerification() {
      assert.equal(timers.size, 1, 'one automatic verification should be scheduled');
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      return callback();
    },
    setHook(value) { hook = value; }, async close() { verifier.clearScheduledVerification(); await queue; repo.close(); } };
}

for (const options of [{ length: 1136, index: 1116 }, { length: 1136, index: 26 }]) {
  test(`对照：${options.length} 层的 user 第 ${options.index} 层正常编辑、核对、两类恢复都是新正文`, async t => {
    const f = await fixture(options);
    try {
      await f.edit();
      const before = await f.snapshot();
      assert.equal(before.full, AFTER); assert.equal(before.historical, AFTER); assert.equal(before.pendingTarget, AFTER);
      await f.verify();
      const after = await f.snapshot();
      assert.equal(after.status, 'saved'); assert.equal(after.pendingCount, 0);
      assert.equal(await f.restoredText('full'), AFTER); assert.equal(await f.restoredText('historical'), AFTER);
      t.diagnostic(JSON.stringify({ index: options.index, beforeVerify: before, afterVerify: after }));
    } finally { await f.close(); }
  });
}

test('手动核对在 full 更新中插入时，先补齐备份再清保护记录，整聊恢复保留新 user 正文', async t => {
  const f = await fixture();
  try {
    f.setHook(async (method, [options]) => {
      if (method !== 'applyBackupPatch' || options.store !== 'full_messages') return;
      f.setHook(null);
      await f.verify();
    });
    const result = await f.edit();
    assert.equal(result.storageErrorCode, 'backup-version-changed');
    const failed = await f.snapshot();
    assert.equal(failed.full, AFTER); assert.equal(failed.historical, AFTER); assert.equal(failed.pendingCount, 0);
    await f.runScheduledVerification(); assert.equal((await f.snapshot()).status, 'saved');
    await f.nextMessage(); await f.verify();
    const after = await f.snapshot();
    assert.equal(after.status, 'saved'); assert.equal(after.fullCount, 1137); assert.equal(after.fullReason, 'message_received');
    assert.equal(after.full, AFTER); assert.equal(await f.restoredText('full'), AFTER);
    assert.equal(await f.restoredText('historical'), AFTER);
    t.diagnostic(JSON.stringify({ failed, afterNextMessage: after, errors: f.errors }));
  } finally { await f.close(); }
});

for (const index of [1116, 26]) {
test(`user 第 ${index} 层编辑备份中又收到新消息，中断的修改在下轮补齐并恢复为新正文`, async t => {
  const f = await fixture({ index });
  try {
    let cleanups = 0, queued;
    f.setHook(async method => {
      if (method !== 'cleanupBackupWrites' || ++cleanups !== 4) return;
      f.setHook(null);
      // Pending, historical and recent are already handled; full has captured
      // its source epoch. A normal new event invalidates that last step.
      queued = f.nextMessage();
    });
    const result = await f.edit();
    assert.equal(result.storageErrorCode, 'backup-source-changed');
    assert(queued, 'must inject the next event during full preparation');
    await queued; await f.verify();
    const after = await f.snapshot();
    assert.equal(after.status, 'saved'); assert.equal(after.pendingCount, 0);
    assert.equal(after.full, AFTER); assert.equal(after.historical, AFTER);
    assert.equal(await f.restoredText('full'), AFTER); assert.equal(await f.restoredText('historical'), AFTER);
    assert.equal(f.errors.some(error => error.code === 'backup-conflict'), false);
    t.diagnostic(JSON.stringify({ index, firstFailure: result.storageErrorCode, afterNextMessage: after }));
  } finally { await f.close(); }
});
}

for (const stores of [['historical_changes'], ['historical_changes', 'full_messages']]) {
  test(`${stores.join('+')} 更新不被无关 meta 写入打断，恢复使用新正文`, async t => {
    const f = await fixture();
    try {
      const remaining = new Set(stores);
      f.setHook(async (method, [options]) => {
        if (method !== 'applyBackupPatch' || !remaining.delete(options.store)) return;
        // Make a real unrelated write between summary and patch; let the real
        // SQLite revision guard reject it, rather than fabricating an error.
        await f.direct('updateChatMetaSummary', chatKey, { diagnosticUnrelatedWrite: options.store });
      });
      const result = await f.edit(); f.setHook(null);
      assert.equal(result.code, 'checking');
      const failed = await f.snapshot();
      assert.equal(failed.pendingTarget, AFTER);
      await f.nextMessage(); await f.verify();
      const after = await f.snapshot();
      assert.equal(after.status, 'saved'); assert.equal(after.pendingCount, 0);
      assert.equal(after.historical, AFTER); assert.equal(await f.restoredText('historical'), AFTER);
      assert.equal(after.full, AFTER);
      assert.equal(await f.restoredText('full'), after.full);
      t.diagnostic(JSON.stringify({ interruptedStores: stores, failed, afterNextMessage: after, errors: f.errors }));
    } finally { await f.close(); }
  });
}

test('真实正文版本冲突后手动重新核对，同时补回 full 与 historical', async t => {
  const f = await fixture();
  try {
    const remaining = new Set(['historical_changes', 'full_messages']);
    f.setHook(async (method, [options]) => {
      if (method === 'applyBackupPatch' && remaining.delete(options.store)) await bumpBody(f, options.store);
    });
    await f.edit(); f.setHook(null);
    await f.coordinator.runBackupNow({ eventName: 'manual-refresh', args: [], verifyNow: true });
    const after = await f.snapshot();
    assert.equal(after.full, AFTER); assert.equal(after.historical, AFTER); assert.equal(after.pendingCount, 0);
    assert.equal(await f.restoredText('full'), AFTER); assert.equal(await f.restoredText('historical'), AFTER);
    t.diagnostic(JSON.stringify(after));
  } finally { await f.close(); }
});

test('反馈对照：SQLite 新 user 消息已写入 recent/full/pending，自动核对前仍显示黄灯', async t => {
  const f = await fixture();
  try {
    await f.nextMessage({ user: true });
    const before = await f.snapshot();
    const full = await f.read('full_messages'), recent = await f.read('recent_messages'), pending = await f.read('pending_changes');
    assert.equal(before.status, 'checking'); assert.equal(before.pendingCount, 1);
    for (const message of [full.at(-1).raw, recent.at(-1).raw, pending[0].message.raw]) {
      assert.equal(message.mes, '新楼层 1136'); assert.equal(message.is_user, true);
    }
    await f.runScheduledVerification();
    const after = await f.snapshot();
    assert.equal(after.status, 'saved'); assert.equal(after.pendingCount, 0);
    t.diagnostic(JSON.stringify({ beforeCheckStatus: before.status, newUserMessagePresentIn: ['recent', 'full', 'pending'], afterCheckStatus: after.status }));
  } finally { await f.close(); }
});

test('黄灯下进入请求保存，自动核对核销 pending 后重新读取，正常打开确认且保持保存状态', async t => {
  const f = await fixture();
  try {
    let nativeSaveCalls = 0, dialogOpened = 0;
    f.current.context = { saveChat: async () => { nativeSaveCalls++; } };
    await f.nextMessage({ user: true });
    assert.equal((await f.snapshot()).status, 'checking');
    const summary = await f.direct('getBackupSummary', chatKey);
    const controller = createRestoreController({
      storage: f.storage, getContextReader: () => ({ readCurrentChat: () => f.current }),
      getSettings: () => f.settings, setStatus: f.setStatus,
      openSaveDialog: ({ pending }) => { dialogOpened++; assert.equal(pending.length, 0); },
    });
    const ui = controller.createRestoreUiState({ current: f.current, messages: [], meta: summary.meta, summary });
    f.setHook(async (method, [options]) => {
      if (method !== 'getBackupPage' || options.store !== 'pending_changes') return;
      f.setHook(null);
      // Fire the already-scheduled automatic check after the save entrance has
      // captured its summary, before it reads its first pending page.
      await f.runScheduledVerification();
    });
    const result = await ui.onRequestSave();
    assert.equal(result, undefined); assert.equal(dialogOpened, 1); assert.equal(nativeSaveCalls, 0);
    const after = await f.snapshot(), last = (await f.read('full_messages')).at(-1);
    assert.equal(after.status, 'saved'); assert.equal(after.pendingCount, 0);
    assert.equal(last.raw.mes, '新楼层 1136'); assert.equal(last.raw.is_user, true);
    assert(f.errors.some(error => error.method === 'getBackupPage' && error.code === 'backup-version-changed'));
    t.diagnostic(JSON.stringify({ result, finalStatus: after.status, pendingCount: after.pendingCount, newUserMessageStillInFull: last.raw.mes, nativeSaveCalls, errors: f.errors }));
  } finally { await f.close(); }
});

async function bumpBody(f, store) {
  if (store === 'full_messages') await f.direct('putFullMessages', { chatKey: 'concurrent-test-chat', messages: [{ messageIndex: 0, raw: { mes: 'concurrent body' } }] });
  else await f.direct('putHistoricalChanges', [{ chatKey: 'concurrent-test-chat', messageIndex: 0, message: { raw: { mes: 'concurrent body' } } }]);
}

for (const database of [false, true]) {
test(`历史与完整备份均失败后，${database ? 'SQLite 重启' : '刷新页面'}仍保留补写线索并恢复新正文`, async t => {
  const directory = database ? fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'boxed-repair-restart-')) : null;
  const f = await fixture({ file: directory ? path.join(directory, 'test.sqlite') : ':memory:' });
  try {
    const remaining = new Set(['historical_changes', 'full_messages']);
    f.setHook(async (method, [options]) => { if (method === 'applyBackupPatch' && remaining.delete(options.store)) await bumpBody(f, options.store); });
    const failure = await f.edit(); f.setHook(null);
    assert.equal(failure.storageErrorCode, 'backup-version-changed');
    const pending = await f.read('pending_changes');
    assert.equal(pending[0].message.raw.mes, AFTER);
    assert.deepEqual(await f.direct('deletePendingChangesIfUnchanged', pending), []);
    await f.restart({ database });
    await f.coordinator.runBackupNow({ eventName: 'extension-loaded', args: [] }); await f.verify();
    const after = await f.snapshot();
    assert.equal(after.status, 'saved'); assert.equal(after.pendingCount, 0); assert.equal(after.full, AFTER); assert.equal(after.historical, AFTER);
    assert.equal(await f.restoredText('full'), AFTER); assert.equal(await f.restoredText('historical'), AFTER);
    t.diagnostic(JSON.stringify({ databaseRestart: database, after }));
  } finally {
    await f.close();
    if (directory) { const resolved = fs.realpathSync(directory); assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir())); assert(path.basename(resolved).startsWith('boxed-repair-restart-')); fs.rmSync(resolved, { recursive: true }); }
  }
});
}

test('酒馆已保存但补写连续失败时，保留新正文 pending 且不变绿', async t => {
  const f = await fixture();
  try {
    f.setHook(async (method, [options]) => { if (method === 'applyBackupPatch' && ['historical_changes', 'full_messages'].includes(options.store)) await bumpBody(f, options.store); });
    await f.edit(); await f.verify();
    const after = await f.snapshot();
    assert.notEqual(after.status, 'saved'); assert.equal(after.pendingTarget, AFTER); assert.equal(after.pendingCount, 1);
    f.setHook(null); await f.verify();
    const repaired = await f.snapshot(); assert.equal(repaired.status, 'saved'); assert.equal(repaired.full, AFTER); assert.equal(repaired.historical, AFTER); assert.equal(repaired.pendingCount, 0);
    t.diagnostic(JSON.stringify({ failed: after, repaired }));
  } finally { f.setHook(null); await f.close(); }
});

test('1136 层 full 分页期间删除 pending 或更新 meta，不使正文读取失效', async () => {
  const f = await fixture();
  try {
    await f.edit(); let pages = 0;
    f.setHook(async (method, [options]) => {
      if (method !== 'getBackupPage' || options.store !== 'full_messages') return;
      if (++pages === 2) { const records = await f.direct('getPendingChanges', chatKey); await f.direct('deletePendingChangesIfUnchanged', records); await f.direct('updateChatMetaSummary', chatKey, { lastBackendStatus: 'saved' }); }
    });
    const rows = await f.read('full_messages');
    assert.equal(rows.length, 1136); assert.equal(rows[1116].raw.mes, AFTER); assert.equal(pages, Math.ceil(1136 / 50));
  } finally { f.setHook(null); await f.close(); }
});

test('正文确实变动时丢弃旧分页，从头得到同一新版，不拼接旧首层与新中间层', async () => {
  const f = await fixture();
  try {
    let pages = 0;
    f.setHook(async (method, [options]) => {
      if (method !== 'getBackupPage' || options.store !== 'full_messages' || ++pages !== 2) return;
      await f.direct('putFullMessages', { chatKey, messages: [0, 500, 1135].map(index => canonicalizeMessage({ mes: '新版正文' }, index)) });
    });
    const rows = await f.read('full_messages');
    for (const index of [0, 500, 1135]) assert.equal(rows[index].raw.mes, '新版正文');
    assert.equal(rows.length, 1136); assert(pages > Math.ceil(1136 / 50));
  } finally { f.setHook(null); await f.close(); }
});

test('恢复涉及的 full/historical 在中途同时更新时，整组重新读取而不混合版本', async () => {
  const f = await fixture();
  try {
    let changed = false;
    f.setHook(async (method, [options]) => {
      if (method !== 'getBackupPage' || options.store !== 'historical_changes' || changed) return;
      changed = true;
      const message = canonicalizeMessage({ is_user: true, mes: '同一新版' }, 1116);
      await f.direct('putFullMessages', { chatKey, messages: [message] });
      await f.direct('putHistoricalChanges', [{ chatKey, messageIndex: 1116, message, canonicalHash: message.canonicalHash }]);
    });
    const { records } = await readBackupBundle(await f.storage.open(), chatKey, ['full_messages', 'historical_changes']);
    assert.equal(records.full_messages[1116].raw.mes, '同一新版'); assert.equal(records.historical_changes[0].message.raw.mes, '同一新版');
  } finally { f.setHook(null); await f.close(); }
});

test('持续正文变化只有限重试，保留已有正式备份', async () => {
  const f = await fixture();
  try {
    let attempts = 0;
    f.setHook(async (method, [options]) => { if (method === 'getBackupPage' && options.store === 'full_messages') { attempts++; await bumpBody(f, 'full_messages'); } });
    await assert.rejects(f.read('full_messages'), { code: 'backup-version-changed' });
    assert.equal(attempts, 3); f.setHook(null); assert.equal((await f.read('full_messages')).length, 1136);
  } finally { f.setHook(null); await f.close(); }
});

test('单批 full 已提交但响应中断时，通过备份证明核对成功，不再次覆盖正文', async () => {
  const f = await fixture();
  try {
    let fullWrites = 0;
    f.setHook(async (method, [options]) => {
      if (method !== 'applyBackupPatch' || options.store !== 'full_messages') return;
      fullWrites++; f.setHook(null);
      return () => { throw new TypeError('simulated response interrupted after commit'); };
    });
    const failed = await f.edit(); assert.equal(failed.storageErrorCode, 'outcome-unknown');
    const before = await f.direct('getBackupSummary', chatKey); await f.verify();
    const after = await f.snapshot(), version = await f.direct('getBackupSummary', chatKey);
    assert.equal(after.status, 'saved'); assert.equal(after.pendingCount, 0); assert.equal(after.full, AFTER); assert.equal(after.historical, AFTER);
    assert.equal(fullWrites, 1); assert.deepEqual(version.scopes.full_messages, before.scopes.full_messages);
  } finally { f.setHook(null); await f.close(); }
});

test('明确删除尾部后备份中断，随后追加新消息仍接续删除，不误冻结旧完整副本', async () => {
  const f = await fixture();
  try {
    await f.edit(); await f.verify();
    f.current.chat.splice(-10); f.coordinator.noteSourceChange(); let cleanups = 0, queued;
    f.setHook(async method => { if (method === 'cleanupBackupWrites' && ++cleanups === 3) { f.setHook(null); queued = f.nextMessage(); } });
    const failure = await f.coordinator.runBackupNow({ eventName: 'message_deleted', args: [1126] });
    assert.equal(failure.storageErrorCode, 'backup-source-changed'); assert(queued);
    await queued; await f.verify();
    const after = await f.snapshot(); assert.equal(after.status, 'saved'); assert.equal(after.fullCount, 1127); assert.equal(after.fullState, 'active'); assert.equal(after.pendingCount, 0);
    assert.equal(await f.restoredText('full'), AFTER); assert.equal(await f.restoredText('historical'), AFTER);
  } finally { f.setHook(null); await f.close(); }
});
