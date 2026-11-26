import test from 'node:test';
import assert from 'node:assert/strict';
import { iterateCursor, runIdbTransaction } from '../src/db/idb-helpers.js';
import { createIndexedDbReadRecovery } from '../src/storage/indexeddb-read-recovery.js';
import { createLocalRecovery, openExistingBackupDatabase } from '../src/storage/local-recovery.js';
import { encodeRescueRecord, sealRescueVolume, readRescueVolume } from '../src/storage/local-rescue-format.js';
import { createOperationGate } from '../src/storage/managed.js';
import { createBackupCoordinator } from '../src/controllers/backup-coordinator.js';
import { describeStorageFailure } from '../src/storage/health.js';
import { markIndexedDbError, isIndexedDbFailure } from '../src/db/idb-errors.js';
import { readFile } from 'node:fs/promises';
import { createStorageController } from '../src/controllers/storage-controller.js';

const memoryStore = () => { const data = new Map(); return { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; };
const unknown = () => markIndexedDbError(new DOMException('Unable to open cursor', 'UnknownError'));

test('游标同步打开、取结果、回调拒绝和推进异常均拒绝原操作', async () => {
  for (const kind of ['open', 'result', 'callback', 'continue']) {
    const error = unknown(), request = {};
    const source = { openCursor() { if (kind === 'open') throw error; return request; } };
    const result = iterateCursor(source, undefined, () => kind === 'callback' ? Promise.reject(error) : undefined);
    if (kind !== 'open') {
      if (kind === 'result') Object.defineProperty(request, 'result', { get() { throw error; } });
      else request.result = { continue() { throw error; } };
      request.onsuccess();
    }
    await assert.rejects(result, value => value === error);
  }
});

test('回调失败先 abort，等待事务终态，保留原始错误', async () => {
  let aborts = 0;
  const tx = { abort() { aborts++; } }, db = { transaction: () => tx }, error = unknown();
  const pending = runIdbTransaction(db, ['test'], 'readwrite', () => { throw error; });
  let finished = false; pending.catch(() => { finished = true; });
  await Promise.resolve(); assert.equal(aborts, 1); assert.equal(finished, false);
  tx.onabort(); await assert.rejects(pending, value => value === error && value.backupTransactionOutcome === 'aborted');
});

test('事务提前完成不能将未结束的业务回调假报成功', async () => {
  const tx = {}, db = { transaction: () => tx };
  let complete;
  const pending = runIdbTransaction(db, ['test'], 'readwrite', () => new Promise(resolve => { complete = resolve; }));
  tx.oncomplete();
  await assert.rejects(pending, error => error.code === 'outcome-unknown' && error.backupTransactionOutcome === 'committed');
  complete('late');
});

test('abort 自身抛错不遮盖原始故障，也不宣称已经回滚', async () => {
  const tx = { abort() { throw new DOMException('already complete', 'InvalidStateError'); } }, error = unknown();
  await assert.rejects(runIdbTransaction({ transaction: () => tx }, [], 'readwrite', () => { throw error; }), value => value === error && value.backupTransactionOutcome === 'unknown');
});

test('只读有限重试、并发合并、缓存持续故障；重查失败继续停写', async () => {
  let attempts = 0;
  const recovery = createIndexedDbReadRecovery({ store: memoryStore(), wait: async () => {} });
  const run = async () => { attempts++; throw unknown(); };
  await Promise.all([assert.rejects(recovery.read('getBackupSummary', ['chat'], run)), assert.rejects(recovery.read('getBackupSummary', ['chat'], run))]);
  assert.equal(attempts, 3);
  await assert.rejects(recovery.read('getBackupSummary', ['chat'], run)); assert.equal(attempts, 3);
  assert.throws(recovery.assertWritable, /暂停/);
  await assert.rejects(recovery.retry(async () => { throw unknown(); })); assert.throws(recovery.assertWritable, /暂停/);
  await recovery.retry(async () => ({})); assert.doesNotThrow(recovery.assertWritable);
});

test('版本冲突和配额错误不触发游标重连', async () => {
  for (const error of [Object.assign(new Error('changed'), { code: 'backup-version-changed' }), new DOMException('full', 'QuotaExceededError')]) {
    let attempts = 0;
    const recovery = createIndexedDbReadRecovery({ store: memoryStore(), wait: async () => {} });
    await assert.rejects(recovery.read('getBackupSummary', [], async () => { attempts++; throw error; }));
    assert.equal(attempts, 1); assert.equal(recovery.state().writePaused, false);
  }
});

test('直接更新结果未知跨页面实例保留暂停，不能只凭重连解锁', async () => {
  const store = memoryStore(), recovery = createIndexedDbReadRecovery({ store });
  recovery.writeFailed('applyBackupPatch', [{ chatKey: 'synthetic' }], Object.assign(unknown(), { backupTransactionOutcome: 'unknown' }));
  const reopened = createIndexedDbReadRecovery({ store });
  assert.throws(reopened.assertWritable, /暂停/);
  await reopened.retry(async () => ({})); assert.throws(reopened.assertWritable, /暂停/);
  reopened.reset(); assert.doesNotThrow(createIndexedDbReadRecovery({ store }).assertWritable);
});

test('有凭证的未知提交只有核实 committed 才解除暂停', async () => {
  const recovery = createIndexedDbReadRecovery({ store: memoryStore() });
  recovery.writeFailed('commitBackupWrite', [{ id: 'synthetic-job' }], Object.assign(unknown(), { backupTransactionOutcome: 'unknown' }));
  await recovery.retry(async id => id ? { state: 'draft' } : undefined); assert.throws(recovery.assertWritable, /暂停/);
  await recovery.retry(async id => id ? { state: 'committed' } : undefined); assert.doesNotThrow(recovery.assertWritable);
});

test('提交凭证成功不会解除独立连接故障，终态清理所有监听器与计时器', async () => {
  const recovery = createIndexedDbReadRecovery({ store: memoryStore() });
  recovery.block(unknown());
  recovery.writeFailed('commitBackupWrite', [{ id: 'receipt' }], Object.assign(unknown(), { backupTransactionOutcome: 'unknown' }));
  await recovery.read('getBackupWriteStatus', ['receipt'], async () => ({ state: 'committed' }));
  assert.equal(recovery.state().unknownWrites.length, 0); assert.throws(recovery.assertWritable);
  const added = [], removed = [], timers = new Set();
  const tx = { addEventListener: (...args) => added.push(['tx', ...args]), removeEventListener: (...args) => removed.push(['tx', ...args]) };
  const db = { transaction: () => tx, addEventListener: (...args) => added.push(['db', ...args]), removeEventListener: (...args) => removed.push(['db', ...args]) };
  const pending = runIdbTransaction(db, [], 'readonly', () => 'done', undefined, { setTimer: fn => { timers.add(fn); return fn; }, clearTimer: fn => timers.delete(fn) });
  await Promise.resolve(); tx.oncomplete(); assert.equal(await pending, 'done');
  assert.equal(timers.size, 0); assert.deepEqual(removed, added);
});

test('只读旧库打开省略版本，意外升级中止而不创建空库', async () => {
  let args, aborted = 0;
  const request = { transaction: { abort() { aborted++; } } };
  const pending = openExistingBackupDatabase({ indexedDBImpl: { open(...input) { args = input; return request; } } });
  request.onupgradeneeded();
  await assert.rejects(pending, error => error.code === 'backup-database-missing');
  assert.deepEqual(args, ['boxed-lllllabc']); assert.equal(aborted, 1);
});

test('删除阻塞时不新建、不重复删除；删除失败释放处理状态', async () => {
  let request, deletes = 0, opens = 0, resumes = 0;
  const recovery = createLocalRecovery({ origin: 'https://example.test', control: { read: async () => ({ active: 'indexeddb' }) },
    local: { open() { opens++; } }, locks: { request: async (_name, _options, run) => run({}) },
    indexedDBImpl: { deleteDatabase() { deletes++; return request = {}; } }, resume: async () => { resumes++; } });
  const input = { confirmed: true, databaseName: 'boxed-lllllabc', confirmedOrigin: 'https://example.test' };
  const pending = recovery.rebuild(input);
  await new Promise(resolve => setImmediate(resolve)); request.onblocked();
  assert.equal(recovery.state().phase, 'blocked'); assert.equal(opens, 0);
  await assert.rejects(recovery.rebuild(input), /正在进行/); assert.equal(deletes, 1);
  request.error = unknown(); request.onerror(); await assert.rejects(pending, error => error.name === 'UnknownError');
  assert.equal(opens, 0); assert.equal(resumes, 1); assert.equal(recovery.state().busy, false);
});

test('新建失败不能宣称重建成功，留下明确停写状态', async () => {
  let blocked = 0, rebuilt = 0;
  const local = { clearRecoveryState() {}, markRecoveryFailure() { blocked++; }, open: async () => { throw unknown(); } };
  const recovery = createLocalRecovery({ origin: 'https://example.test', control: { read: async () => ({ active: 'indexeddb' }) }, local,
    locks: { request: async (_name, _options, run) => run({}) }, indexedDBImpl: { deleteDatabase() { const request = {}; queueMicrotask(() => request.onsuccess()); return request; } }, onRebuilt: async () => { rebuilt++; } });
  await assert.rejects(recovery.rebuild({ confirmed: true, databaseName: 'boxed-lllllabc', confirmedOrigin: 'https://example.test' }));
  assert.equal(rebuilt, 0); assert.equal(blocked, 2); assert.equal(recovery.state().busy, false);
});

test('救援卷无损解码、校验篡改；不支持的值明确失败', async () => {
  const sparse = new Array(3); sparse[2] = undefined;
  const value = { sparse, date: new Date(123), bigint: 123n, negativeZero: -0 };
  const volume = await sealRescueVolume({ exportId: 'test', volume: 1 }, [encodeRescueRecord('full_messages', ['chat', 0], value)]);
  const rows = await readRescueVolume(JSON.parse(JSON.stringify(volume)));
  assert.deepEqual(rows[0].value, value);
  const changed = structuredClone(volume); changed.records[0] = ['null']; await assert.rejects(readRescueVolume(changed), /校验不符/);
  assert.throws(() => encodeRescueRecord('chat_meta', 'x', new Map()), /不支持/);
});

test('不同操作的暂停原因互不解除', async () => {
  const gate = createOperationGate(); await gate.pause(); await gate.pause('local-recovery'); gate.resume();
  assert.equal(gate.isPaused(), true); await assert.rejects(gate.run(async () => {}), /锁定/);
  gate.resume('local-recovery'); assert.equal(gate.isPaused(), false);
});

test('本地关键保护记录读取失败不能当成无需确认或正常 saved', async () => {
  const failure = unknown();
  const coordinator = createBackupCoordinator({ storage: { getMode: () => 'indexeddb', open: async () => { throw failure; } }, getSettings: () => ({ enabled: true, fullBackupEnabled: true }), getContextReader: () => ({}) });
  assert.equal((await coordinator.prioritizeFullBackupStatus('synthetic', { code: 'saved' })).code, 'db-error');
  await assert.rejects(coordinator.needsFullBackupConfirmation('synthetic'), error => error === failure);
});

test('故障缓存达到上限也不能遗忘关键读取失败并恢复写入', async () => {
  const recovery = createIndexedDbReadRecovery({ store: memoryStore(), delays: [] });
  await assert.rejects(recovery.read('getChatMeta', ['guard'], async () => { throw unknown(); }));
  for (let i = 0; i < 101; i++) await assert.rejects(recovery.read('getBackupCatalogPage', [i], async () => { throw unknown(); }));
  assert.equal(recovery.state().failedReads, 100); assert.throws(recovery.assertWritable, /暂停/);
});

test('静默无进展且没有 abort 事件时有界返回未知结果', async () => {
  const timers = [], tx = { abort() {} };
  const pending = runIdbTransaction({ transaction: () => tx }, [], 'readwrite', () => new Promise(() => {}), undefined, { setTimer: callback => { timers.push(callback); return timers.length; }, clearTimer() {} });
  timers[0](); timers[1]();
  await assert.rejects(pending, error => error.code === 'backup-operation-timeout' && error.backupTransactionOutcome === 'unknown');
});

test('非 Error 回调拒绝也不能假报成功', async () => {
  const tx = { abort() { queueMicrotask(() => tx.onabort()); } };
  await assert.rejects(runIdbTransaction({ transaction: () => tx }, [], 'readwrite', () => { throw undefined; }), error => error.message === 'undefined' && error.backupTransactionOutcome === 'aborted');
});

test('已存在的另一个页面实例在写入前也检查未知提交标记', async () => {
  const store = memoryStore(), first = createIndexedDbReadRecovery({ store }), second = createIndexedDbReadRecovery({ store });
  first.writeFailed('applyBackupPatch', [], Object.assign(unknown(), { backupTransactionOutcome: 'unknown' }));
  assert.throws(second.assertWritable, /暂停/); assert.equal(second.state().unknownWrites.length, 1);
});

test('保护标记无法持久化时仍保留本页未知结果，不能重连后解锁', async () => {
  const recovery = createIndexedDbReadRecovery({ store: { getItem: () => null, setItem() { throw new Error('disabled'); }, removeItem() {} } });
  recovery.writeFailed('applyBackupPatch', [], Object.assign(unknown(), { backupTransactionOutcome: 'unknown' }));
  await recovery.retry(async () => undefined); assert.throws(recovery.assertWritable, /暂停/);
});

test('打开阻塞和超时不反复排队重连，持续事件直接复用故障状态', async () => {
  for (const code of ['backup-database-blocked', 'backup-database-timeout']) {
    let attempts = 0;
    const recovery = createIndexedDbReadRecovery({ store: memoryStore(), wait: async () => {} });
    const run = async () => { attempts++; throw Object.assign(new Error(code), { code }); };
    await assert.rejects(recovery.read('open', [], run)); await assert.rejects(recovery.read('open', [], run));
    assert.equal(attempts, 1); assert.throws(recovery.assertWritable, /暂停/);
  }
});

test('未知写入与目录错误提示不声称已回滚或未写入', () => {
  assert.equal(describeStorageFailure({ code: 'outcome-unknown', detail: '需要核对' }).shortText, '备份结果待核对');
  assert.equal(describeStorageFailure({ code: 'db-error', detail: '只有目录暂不可读' }).detail, '只有目录暂不可读');
});

test('目录重试失败保持非关键，逐项保留故障信息与提示', async () => {
  const notices = [], recovery = createIndexedDbReadRecovery({ store: memoryStore(), delays: [], onFailure: item => notices.push(item) });
  await assert.rejects(recovery.read('getBackupCatalog', ['catalog'], async () => { throw unknown(); }));
  await assert.rejects(recovery.retry(async (_id, operation, args) => { if (operation) { assert.deepEqual(args, ['catalog']); throw unknown(); } }));
  assert.equal(recovery.state().failedReads, 1); assert.equal(recovery.state().writePaused, false); assert.doesNotThrow(recovery.assertWritable);
  assert(notices.every(item => item.operation === 'getBackupCatalog' && !item.critical));
  await recovery.retry(async () => {}); assert.equal(recovery.state().failedReads, 0);
});

test('关键与非关键故障分别解决，部分成功不被其他失败阻挡或清除', async () => {
  for (const resolveCritical of [true, false]) {
    const recovery = createIndexedDbReadRecovery({ store: memoryStore(), delays: [] });
    for (const operation of ['getBackupCatalogPage', 'getChatMeta']) await assert.rejects(recovery.read(operation, [operation], async () => { throw unknown(); }));
    const visits = [];
    await assert.rejects(recovery.retry(async (_id, operation) => { if (!operation) return; visits.push(operation); if ((operation === 'getChatMeta') !== resolveCritical) throw unknown(); }));
    assert.deepEqual(visits, ['getBackupCatalogPage', 'getChatMeta']); assert.equal(recovery.state().failedReads, 1);
    assert.equal(recovery.state().writePaused, !resolveCritical);
    await recovery.retry(async () => {}); assert.equal(recovery.state().failedReads, 0); assert.doesNotThrow(recovery.assertWritable);
  }
});

test('当前聊天健康检查失败仍检查其他故障项，已恢复目录可独立清除', async () => {
  const recovery = createIndexedDbReadRecovery({ store: memoryStore(), delays: [] });
  for (const operation of ['getBackupCatalog', 'getChatMeta']) await assert.rejects(recovery.read(operation, [], async () => { throw unknown(); }));
  await assert.rejects(recovery.retry(async (_id, operation) => { if (operation !== 'getBackupCatalog') throw unknown(); }));
  assert.equal(recovery.state().failedReads, 1); assert.throws(recovery.assertWritable);
  await recovery.retry(async () => {}); assert.doesNotThrow(recovery.assertWritable);
});

test('目录故障不阻断未知提交凭证检查，凭证也不解除独立关键故障', async () => {
  const recovery = createIndexedDbReadRecovery({ store: memoryStore(), delays: [] });
  for (const operation of ['getBackupCatalog', 'getChatMeta']) await assert.rejects(recovery.read(operation, [], async () => { throw unknown(); }));
  recovery.writeFailed('commitBackupWrite', [{ id: 'receipt' }], Object.assign(unknown(), { backupTransactionOutcome: 'unknown' }));
  let checked = 0;
  await assert.rejects(recovery.retry(async (id, operation) => { if (id) { checked++; return { state: 'committed' }; } if (operation) throw unknown(); }));
  assert.equal(checked, 1); assert.equal(recovery.state().unknownWrites.length, 0); assert.equal(recovery.state().failedReads, 2); assert.throws(recovery.assertWritable);
  await recovery.retry(async () => {}); assert.doesNotThrow(recovery.assertWritable);
});

test('真实请求来源可识别 TypeError/AbortError，业务回调和版本冲突不误标', async () => {
  for (const error of [new TypeError('native'), new DOMException('native', 'AbortError')]) {
    const request = { source: null, error }, pending = (await import('../src/db/idb-helpers.js')).idbRequest(request);
    request.onerror(); await assert.rejects(pending); assert.equal(isIndexedDbFailure(error), true);
  }
  const ordinary = new TypeError('business'), tx = { abort() { queueMicrotask(() => tx.onabort()); } };
  await assert.rejects(runIdbTransaction({ transaction: () => tx }, [], 'readwrite', () => { throw ordinary; }));
  assert.equal(ordinary.backupTransactionOutcome, 'aborted'); assert.equal(isIndexedDbFailure(ordinary), false);
  const conflict = Object.assign(new Error('version'), { code: 'backup-version-changed' }); markIndexedDbError(conflict); assert.equal(isIndexedDbFailure(conflict), false);
  const recovery = createIndexedDbReadRecovery({ store: memoryStore(), delays: [] });
  recovery.writeFailed('applyBackupPatch', [], ordinary); assert.doesNotThrow(recovery.assertWritable);
});

test('已确认回滚的原生写入失败不升级未知结果，也不锁死后续业务补写', () => {
  const recovery = createIndexedDbReadRecovery({ store: memoryStore() });
  for (const name of ['QuotaExceededError', 'DataCloneError', 'UnknownError']) {
    recovery.writeFailed('putFullMessages', [], Object.assign(markIndexedDbError(new DOMException('aborted', name)), { backupTransactionOutcome: 'aborted' }));
    assert.equal(recovery.state().unknownWrites.length, 0); assert.doesNotThrow(recovery.assertWritable);
  }
});

test('真实外层函数只处理明确存储故障，业务和 UI 异常及 SQLite 原样传播', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8'), start = source.indexOf('async function runBackupNow('), end = source.indexOf('\nfunction exposeDebugApi()', start);
  for (const mode of ['indexeddb', 'sqlite']) for (const native of [false, true]) for (const kind of ['context', 'business', 'ui', 'cancel']) {
    let blocked = false, notices = 0;
    const error = kind === 'context' ? new TypeError(kind) : kind === 'cancel' ? new DOMException(kind, 'AbortError') : new Error(kind); if (native) markIndexedDbError(error);
    const run = new Function('operationGate', 'backupStorage', 'adapters', 'localRecoveryUi', 'createBackupStatus', 'setStatus', 'backupCoordinator', 'storageController', 'latestStatus', 'isIndexedDbFailure', `return ${source.slice(start, end)}`)(
      { isPaused: () => false, run: fn => fn() }, { getMode: () => mode }, { indexeddb: { getRecoveryState: () => ({ writePaused: blocked, unknownWrites: [] }), markRecoveryFailure() { blocked = true; } } },
      { showFault() { notices++; } }, (code, shortText, detail) => ({ code, shortText, detail }), () => {}, { runBackupNow: async () => { throw error; } }, { handleBackupStatus() {} }, {}, isIndexedDbFailure);
    if (native && mode === 'indexeddb') { assert.equal((await run()).code, 'db-error'); assert(blocked); assert.equal(notices, 1); }
    else { await assert.rejects(run, value => value === error); assert(!blocked); assert.equal(notices, 0); }
  }
  const callbackSource = source.match(/onStorageFailure: (error => \{[^\n]+\}),/)[1];
  for (const mode of ['indexeddb', 'sqlite']) for (const native of [false, true]) {
    let paused = false;
    const callback = new Function('backupStorage', 'adapters', 'isIndexedDbFailure', `return ${callbackSource}`)(
      { getMode: () => mode }, { indexeddb: { getRecoveryState: () => ({ writePaused: paused }), markRecoveryFailure: () => { paused = true; } } }, isIndexedDbFailure);
    callback(native ? markIndexedDbError(new TypeError('native')) : new TypeError('business'));
    assert.equal(paused, mode === 'indexeddb' && native);
  }
});

test('本地存储概览重绘异常原样传播，不伪造数据库故障或救援提示', async () => {
  let failRender = false, failures = 0, closed = 0;
  const error = new TypeError('synthetic render failure');
  const controller = createStorageController({ storage: { getMode: () => 'indexeddb', open: async () => ({ getBackupCatalog: async () => ({ chats: [], storageBytes: 0 }), close() { closed++; } }) },
    estimateStorage: async () => ({}), renderOverview() { if (failRender) throw error; }, onLocalFailure() { failures++; } });
  await controller.refresh(); failRender = true;
  await assert.rejects(controller.refresh(), value => value === error);
  assert.equal(failures, 0); assert.equal(controller.getSnapshot().failure, null); assert.equal(closed, 2);
});
