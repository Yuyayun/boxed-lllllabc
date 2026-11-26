import { createIndexedDbStorage } from '../../src/storage/indexeddb-adapter.js';
import { backupVersionOptions, writeBackupRecords } from '../../src/storage/backup-batches.js';
import { distinctIndexKeys, runIdbTransaction, idbRequest } from '../../src/db/idb-helpers.js';
import { openBackupDatabase } from '../../src/db/index.js';
import { datasetStore } from '../../src/storage/dataset-layout.js';
import { createLocalRecovery, exportLocalRescue, openExistingBackupDatabase } from '../../src/storage/local-recovery.js';
import { readRescueVolume } from '../../src/storage/local-rescue-format.js';
import { createStorageControl } from '../../src/storage/control.js';
import { migrateDatabase } from '../../src/db/migration.js';
import { fullWriteGuard } from '../../src/storage/backup-versions.js';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function rejects(run, check) {
  try { await run(); } catch (error) { assert(check(error), `异常不符：${error.name} ${error.message}`); return error; }
  throw new Error('操作没有拒绝');
}
const rows = (key, prefix) => [0, 1].map(messageIndex => ({ chatKey: key, messageIndex, message: { mes: `${prefix}-${messageIndex}` } }));
async function withContinueFailure(run) {
  const original = IDBCursor.prototype.continue;
  let fired = false;
  IDBCursor.prototype.continue = function (...args) {
    if (!fired) { fired = true; throw new DOMException('injected continue failure', 'UnknownError'); }
    return original.apply(this, args);
  };
  try { await run(); assert(fired, '未注入推进异常'); }
  finally { IDBCursor.prototype.continue = original; }
}

export async function runIndexedDbRecoveryContract({ only, duplicateRows = 10000 } = {}) {
  assert(location.hostname === '127.0.0.1', '只允许隔离测试 origin');
  const checks = [], failures = [], metrics = { nativeWebLocks: Boolean(navigator.locks?.request) }, unhandled = [];
  const listener = event => { unhandled.push(event.reason?.message); event.preventDefault(); };
  addEventListener('unhandledrejection', listener);
  const test = async (name, run) => { if (only && !name.includes(only)) return; globalThis.boxedIdbCase = name; console.info(`IDB_CASE ${name}`); try { await run(); checks.push(name); console.info(`IDB_STEP 通过 ${name}`); } catch (error) { failures.push({ name, error: error.stack }); console.info(`IDB_STEP 失败 ${name}: ${error.message}`); } };
  await test('空目录及最后一页不用唯一方向游标', async () => {
    const a = IDBIndex.prototype.openCursor, b = IDBIndex.prototype.openKeyCursor;
    const wrap = original => function (range, direction) { assert(!['nextunique', 'prevunique'].includes(direction), '仍打开唯一方向游标'); return original.call(this, range, direction); };
    IDBIndex.prototype.openCursor = wrap(a); IDBIndex.prototype.openKeyCursor = wrap(b);
    const session = await createIndexedDbStorage().open();
    try {
      assert((await session.getBackupCatalogPage()).items.length === 0, '空库目录错误');
      assert((await session.getBackupCatalog()).chatCount === 0, '旧空目录错误');
      assert((await session.getBackupCatalogPage({ after: '\uffff' })).items.length === 0, '空范围目录错误');
    } finally { session.close(); IDBIndex.prototype.openCursor = a; IDBIndex.prototype.openKeyCursor = b; }
  });
  await test('分批替换推进失败完整回滚且不假报成功', async () => {
    const session = await createIndexedDbStorage().open(), chatKey = `character:batch-fault.png:${crypto.randomUUID()}`;
    try {
      await session.putFullMessages({ chatKey, messages: rows(chatKey, 'old') });
      const summary = await session.getBackupSummary(chatKey);
      const job = await session.beginBackupWrite({ chatKey, store: 'full_messages', count: 2, replace: true, ...backupVersionOptions(summary, 'full_messages', true) });
      await session.appendBackupWrite({ id: job.id, start: 0, rows: rows(chatKey, 'new') });
      await withContinueFailure(() => rejects(() => session.commitBackupWrite({ id: job.id }), error => error.name === 'UnknownError' && error.backupTransactionOutcome === 'aborted'));
      assert(JSON.stringify(await session.getFullMessages(chatKey)) === JSON.stringify(rows(chatKey, 'old')), '旧正文被部分提交');
      const latest = await session.getBackupSummary(chatKey);
      assert(latest.revision === summary.revision && latest.scopes.full_messages.revision === summary.scopes.full_messages.revision, '回滚版本错误');
      assert((await session.getBackupWriteStatus(job.id)).state === 'draft', '任务回执被改写');
    } finally { session.close(); }
  });
  await test('普通替换推进失败同样完整回滚', async () => {
    const session = await createIndexedDbStorage().open(), chatKey = `character:legacy-fault.png:${crypto.randomUUID()}`;
    try {
      await session.putFullMessages({ chatKey, messages: rows(chatKey, 'old') });
      await withContinueFailure(() => rejects(() => session.replaceFullSnapshot({ chatKey, messages: rows(chatKey, 'new') }), error => error.name === 'UnknownError' && error.backupTransactionOutcome === 'aborted'));
      assert(JSON.stringify(await session.getFullMessages(chatKey)) === JSON.stringify(rows(chatKey, 'old')), '旧替换没有回滚');
    } finally { session.close(); }
  });
  await test('去重键跳读有界、保留上界和键序', async () => {
    const db = await openBackupDatabase(), store = datasetStore('full_messages', 1);
    try {
      console.info('IDB_STEP 开始分批准备重复键夹具');
      for (let start = 0; start < duplicateRows; start += 100) await runIdbTransaction(db, store, 'readwrite', async tx => {
        for (let i = start; i < Math.min(start + 100, duplicateRows); i++) tx.objectStore(store).put({ chatKey: 'a', messageIndex: i });
      });
      console.info('IDB_STEP 重复键夹具提交完成');
      await runIdbTransaction(db, store, 'readwrite', async tx => {
        for (const chatKey of ['b', 'c', 'd']) tx.objectStore(store).put({ chatKey, messageIndex: 0 });
      });
      let requests = 0;
      const original = IDBIndex.prototype.openKeyCursor;
      IDBIndex.prototype.openKeyCursor = function (...args) { requests++; return original.apply(this, args); };
      try {
        const keys = await runIdbTransaction(db, store, 'readonly', tx => distinctIndexKeys(tx.objectStore(store).index('by_chat'), IDBKeyRange.bound('a', 'c'), 21));
        console.info('IDB_STEP 去重键查询完成');
        assert(JSON.stringify(keys) === '["a","b","c"]', '边界或去重错误');
        assert(requests === 3, `重复楼层导致 ${requests} 次请求`);
        metrics.distinctKeys = { duplicateRows, distinctKeys: keys.length, requests };
      } finally { IDBIndex.prototype.openKeyCursor = original; }
    } finally { db.close(); }
  });
  await test('临时读取失败重开事务，最多两次重试并合并并发读取', async () => {
    const session = await createIndexedDbStorage({ recoveryOptions: { delays: [0, 0] } }).open();
    const key = `character:read-retry.png:${crypto.randomUUID()}`;
    const original = IDBObjectStore.prototype.openCursor; let attempts = 0;
    try {
      await session.putFullMessages({ chatKey: key, messages: rows(key, 'retry') });
      const summary = await session.getBackupSummary(key), options = { chatKey: key, store: 'full_messages', ...backupVersionOptions(summary, 'full_messages') };
      IDBObjectStore.prototype.openCursor = function (...args) { if (this.name === 'full_messages' && ++attempts <= 2) throw new DOMException('temporary cursor failure', 'UnknownError'); return original.apply(this, args); };
      const pages = await Promise.all([session.getBackupPage(options), session.getBackupPage(options)]);
      assert(attempts === 3 && pages.every(page => page.rows.length === 2), `读取重试次数 ${attempts}`);
    } finally { IDBObjectStore.prototype.openCursor = original; session.close(); }
  });
  await test('持续读取故障不假报空结果、不重复扫描、不继续写入', async () => {
    const local = createIndexedDbStorage({ recoveryOptions: { delays: [0, 0] } }), session = await local.open();
    const key = `character:read-stop.png:${crypto.randomUUID()}`;
    const original = IDBIndex.prototype.count; let attempts = 0;
    try {
      IDBIndex.prototype.count = function (...args) { if (this.objectStore.name === 'full_messages') { attempts++; throw new DOMException('persistent count failure', 'UnknownError'); } return original.apply(this, args); };
      for (let i = 0; i < 3; i++) await rejects(() => session.getBackupSummary(key), error => error.name === 'UnknownError');
      assert(attempts === 3 && local.getRecoveryState().writePaused, '持续失败仍重复或未停写');
      await rejects(() => session.putFullMessages({ chatKey: key, messages: rows(key, 'forbidden') }), error => error.code === 'backup-local-paused');
      IDBIndex.prototype.count = original;
      await local.retryLocalReads(key);
      await session.putFullMessages({ chatKey: key, messages: rows(key, 'recovered') });
    } finally { IDBIndex.prototype.count = original; session.close(); }
  });
  await test('只有目录失败时当前聊天读写仍可使用', async () => {
    const local = createIndexedDbStorage({ recoveryOptions: { delays: [0, 0] } }), session = await local.open();
    const key = `character:catalog-only.png:${crypto.randomUUID()}`, original = IDBIndex.prototype.openKeyCursor;
    try {
      IDBIndex.prototype.openKeyCursor = function () { throw new DOMException('catalog only', 'UnknownError'); };
      await rejects(() => session.getBackupCatalogPage(), error => error.name === 'UnknownError');
      assert(!local.getRecoveryState().writePaused, '目录故障错误地暂停所有写入');
      await session.putFullMessages({ chatKey: key, messages: rows(key, 'still-ok') });
      assert((await session.getBackupSummary(key)).counts.full_messages === 2, '当前聊天受目录故障影响');
    } finally { IDBIndex.prototype.openKeyCursor = original; session.close(); }
  });
  await test('提交回执丢失时核验任务结果，不重复提交', async () => {
    const session = await createIndexedDbStorage().open(), key = `character:receipt.png:${crypto.randomUUID()}`;
    let commits = 0;
    try {
      const proxy = { ...session, commitBackupWrite: async options => { commits++; await session.commitBackupWrite(options); throw new TypeError('lost response'); } };
      const receipt = await writeBackupRecords(proxy, { chatKey: key, store: 'full_messages', rows: rows(key, 'committed'), replace: true });
      assert(commits === 1 && receipt.state === 'committed', '回执核验未确认已提交结果');
    } finally { session.close(); }
  });
  await test('continuePrimaryKey 抛错保留原异常和记录', async () => {
    const session = await createIndexedDbStorage().open(), key = `character:primary-jump.png:${crypto.randomUUID()}`;
    const original = IDBCursor.prototype.continuePrimaryKey;
    try {
      await session.putPendingChanges(['a', 'b', 'c'].map((id, messageIndex) => ({ id, chatKey: key, messageIndex, message: { mes: id } })));
      const summary = await session.getBackupSummary(key);
      IDBCursor.prototype.continuePrimaryKey = function () { throw new DOMException('injected primary jump', 'DataError'); };
      await rejects(() => session.getBackupPage({ chatKey: key, store: 'pending_changes', after: 'b', ...backupVersionOptions(summary, 'pending_changes') }), error => error.name === 'DataError' && error.backupTransactionOutcome === 'aborted');
      assert((await session.getPendingChanges(key)).length === 3, '推进异常改动待确认记录');
    } finally { IDBCursor.prototype.continuePrimaryKey = original; session.close(); }
  });
  await test('索引不可读时救援主键记录，结构与原库保持不变', async () => {
    const key = 'structured-rescue', db = await openBackupDatabase();
    const value = { chatKey: key, date: new Date(123), sparse: new Array(3), big: 7n, undef: undefined };
    value.sparse[2] = 'last';
    await runIdbTransaction(db, 'chat_meta', 'readwrite', tx => idbRequest(tx.objectStore('chat_meta').put(value))); db.close();
    const originalIndex = IDBObjectStore.prototype.index, originalTx = IDBDatabase.prototype.transaction;
    let writes = 0, found = false, maxVolumeBytes = 0;
    IDBObjectStore.prototype.index = function () { throw new DOMException('secondary index unavailable', 'UnknownError'); };
    IDBDatabase.prototype.transaction = function (names, mode, ...rest) { if (mode === 'readwrite') writes++; return originalTx.call(this, names, mode, ...rest); };
    try {
      const manifest = await exportLocalRescue({ onVolume: async volume => {
        maxVolumeBytes = Math.max(maxVolumeBytes, new TextEncoder().encode(JSON.stringify(volume)).byteLength);
        for (const row of await readRescueVolume(volume)) if (row.store === 'chat_meta' && row.key === key) {
          found = row.value.date.getTime() === 123 && row.value.big === 7n && !(0 in row.value.sparse) && row.value.sparse[2] === 'last' && Object.hasOwn(row.value, 'undef');
        }
      } });
      assert(found && writes === 0 && manifest.businessIntegrity === 'not-verified', `救援结果错误 ${JSON.stringify({ found, writes, manifest })}`);
      assert(manifest.tables.some(table => table.store === '__boxed_next_full_messages' && table.area === 1 && table.count === duplicateRows + 3), '另一数据区遗漏');
      metrics.rescue = { exportedRecords: manifest.exportedRecords, volumes: manifest.volumes.length, maxVolumeBytes, writes };
    } finally { IDBObjectStore.prototype.index = originalIndex; IDBDatabase.prototype.transaction = originalTx; }
    const verify = await openBackupDatabase();
    const saved = await runIdbTransaction(verify, 'chat_meta', 'readonly', tx => idbRequest(tx.objectStore('chat_meta').get(key))); verify.close();
    assert(saved.date.getTime() === 123 && saved.big === 7n, '原结构发生变化');
  });
  await test('单表游标失败仍可导出其他表，并标明失败范围', async () => {
    const original = IDBObjectStore.prototype.openCursor;
    IDBObjectStore.prototype.openCursor = function (...args) { if (this.name === 'full_messages') throw new DOMException('one table unreadable', 'UnknownError'); return original.apply(this, args); };
    try {
      const manifest = await exportLocalRescue({ onVolume: async volume => { await readRescueVolume(volume); } });
      assert(manifest.status === 'partial' && manifest.exportedRecords > 0, `部分救援未保留可读数据 ${JSON.stringify(manifest)}`);
      assert(manifest.tables.find(table => table.store === 'full_messages').status === 'failed', '没有标记失败表');
    } finally { IDBObjectStore.prototype.openCursor = original; }
  });
  await test('救援可取消，不生成虚假完整结果', async () => {
    const abort = new AbortController(); let volumes = 0;
    const manifest = await exportLocalRescue({ signal: abort.signal, onVolume: async () => { volumes++; }, onProgress: state => { if (state.count >= 50) abort.abort(); } });
    assert(manifest.cancelled && manifest.status === 'cancelled', '取消未传递');
    assert(manifest.volumes.length === volumes, '取消后清单卷数错误');
  });
  await test('活动区 B 跨 20/21 边界、四类重叠分页无重复漏项', async () => {
    const db = await openBackupDatabase(), keys = Array.from({ length: 24 }, (_, i) => `u${String(i).padStart(2, '0')}`), types = ['full_messages', 'recent_messages', 'historical_changes', 'pending_changes'];
    try {
      await runIdbTransaction(db, ['__boxed_transfer_meta', ...types.map(name => datasetStore(name, 1))], 'readwrite', tx => {
        tx.objectStore('__boxed_transfer_meta').put({ key: 'active-dataset', value: 1 });
        for (const [i, chatKey] of keys.entries()) for (const type of types.slice(0, 1 + i % 4)) {
          tx.objectStore(datasetStore(type, 1)).put({ chatKey, messageIndex: 0, ...(type === 'pending_changes' ? { id: `u-${i}` } : {}) });
        }
      });
      const session = await createIndexedDbStorage().open(), actual = [];
      try {
        let after = null;
        do { const page = await session.getBackupCatalogPage({ after }); assert(page.items.length <= 20, '目录超过 20 项'); actual.push(...page.items.map(item => item.chatKey)); after = page.after; } while (after !== null);
        const expected = ['a', 'b', 'c', 'd', ...keys].sort((a, b) => indexedDB.cmp(a, b));
        assert(JSON.stringify(actual) === JSON.stringify(expected), '跨页目录重复或漏项');
      } finally { session.close(); }
    } finally {
      await runIdbTransaction(db, '__boxed_transfer_meta', 'readwrite', tx => idbRequest(tx.objectStore('__boxed_transfer_meta').delete('active-dataset'))); db.close();
    }
  });
  await test('持久迁移锁不能被救援或重建绕过', async () => {
    const db = await openBackupDatabase();
    await runIdbTransaction(db, '__boxed_transfer_meta', 'readwrite', tx => idbRequest(tx.objectStore('__boxed_transfer_meta').put({ key: 'lock', value: 'unfinished-transfer' }))); db.close();
    try {
      const manifest = await exportLocalRescue({ onVolume: async () => { throw new Error('不应导出'); } });
      assert(manifest.error && manifest.exportedRecords === 0, '救援绕过迁移锁');
      const recovery = createLocalRecovery({ local: createIndexedDbStorage(), control: { read: async () => ({ active: 'indexeddb' }) } });
      await rejects(() => recovery.rebuild({ confirmed: true, databaseName: 'boxed-lllllabc', confirmedOrigin: location.origin }), error => /未完成的存储迁移/.test(error.message));
    } finally {
      const cleanup = await openBackupDatabase(); await runIdbTransaction(cleanup, '__boxed_transfer_meta', 'readwrite', tx => idbRequest(tx.objectStore('__boxed_transfer_meta').delete('lock'))); cleanup.close();
    }
  });
  await test('重建需要明确确认、活动本地位置及无未完成迁移', async () => {
    let deletions = 0;
    const fakeDb = { deleteDatabase() { deletions++; throw new Error('不允许删除'); } }, local = createIndexedDbStorage();
    for (const state of [{ active: 'sqlite' }, { active: 'indexeddb', journal: { id: 'unfinished' } }]) {
      const recovery = createLocalRecovery({ local, control: { read: async () => state }, indexedDBImpl: fakeDb });
      await rejects(() => recovery.rebuild({ confirmed: true, databaseName: 'boxed-lllllabc', confirmedOrigin: location.origin }), error => error.code === 'backup-local-recovery-blocked');
      assert(!recovery.state().busy, '拒绝后未释放操作门');
    }
    const recovery = createLocalRecovery({ local, control: { read: async () => { throw new Error('control unreadable'); } }, indexedDBImpl: fakeDb });
    await rejects(() => recovery.rebuild(), error => error.code === 'backup-local-recovery-blocked');
    await rejects(() => recovery.rebuild({ confirmed: true, databaseName: 'boxed-lllllabc', confirmedOrigin: location.origin }), error => /control unreadable/.test(error.message));
    assert(deletions === 0, '未确认、SQLite、迁移或控制错误导致删库');
  });
  await test('其他页签持有共享操作权时重建不删除', async () => {
    if (!navigator.locks?.request) {
      const recovery = createLocalRecovery({ control: { read: async () => ({ active: 'indexeddb' }) }, local: createIndexedDbStorage() });
      await rejects(() => recovery.rebuild({ confirmed: true, databaseName: 'boxed-lllllabc', confirmedOrigin: location.origin }), error => /跨页签/.test(error.message));
      return;
    }
    let release, acquired;
    const ready = new Promise(resolve => { acquired = resolve; });
    const holder = navigator.locks.request('boxed-lllllabc-storage-operation', { mode: 'shared' }, async () => { acquired(); await new Promise(resolve => { release = resolve; }); });
    await ready; let deletions = 0;
    try {
      const recovery = createLocalRecovery({ control: { read: async () => ({ active: 'indexeddb' }) }, local: createIndexedDbStorage(), indexedDBImpl: { deleteDatabase() { deletions++; } } });
      await rejects(() => recovery.rebuild({ confirmed: true, databaseName: 'boxed-lllllabc', confirmedOrigin: location.origin }), error => /其他酒馆页签/.test(error.message));
      assert(deletions === 0, '未取得独占权仍删除');
    } finally { release(); await holder; }
  });
  await test('删除阻塞不提前新建；重建后控制与设置保留且正常备份', async () => {
    const control = createStorageControl(), before = await control.read(), local = createIndexedDbStorage();
    localStorage.setItem('boxed-test-settings', 'keep');
    const holder = await idbRequest(indexedDB.open('boxed-lllllabc')); let blocked = false, rebuilt = false;
    const phases = [];
    const recovery = createLocalRecovery({ control, local, onRebuilt: async () => { rebuilt = true; }, onProgress: state => {
      phases.push(state.phase);
      if (state.phase === 'blocked') { blocked = true; assert(!phases.includes('creating'), '阻塞时提前新建'); setTimeout(() => holder.close(), 10); }
    } });
    let result;
    try { result = await recovery.rebuild({ confirmed: true, databaseName: 'boxed-lllllabc', confirmedOrigin: location.origin }); }
    finally { holder.close(); }
    assert(result.rebuilt && !result.backupCreated && blocked && rebuilt && !recovery.state().busy, '重建状态不准确');
    assert(JSON.stringify(await control.read()) === JSON.stringify(before) && localStorage.getItem('boxed-test-settings') === 'keep', '控制记录或设置被清除');
    const session = await local.open(), key = 'character:after-reset.png:synthetic';
    try {
      assert((await session.getBackupCatalogPage()).items.length === 0, '重建残留旧目录');
      await rejects(() => session.applyBackupPatch({ chatKey: key, store: 'full_messages', rows: rows(key, 'stale'), meta: {}, scope: { area: 0, epoch: 0, revision: 0 }, fullGuard: fullWriteGuard(undefined) }), error => error.code === 'backup-version-changed');
      await rejects(() => session.deleteBackupV2({ chatKey: key, store: 'full_messages', revision: 0 }), error => error.code === 'backup-version-changed');
      await writeBackupRecords(session, { chatKey: key, store: 'full_messages', rows: rows(key, 'fresh'), replace: true }); assert((await session.getFullMessages(key)).length === 2, '重建后不能正常备份');
    }
    finally { session.close(); }
  });
  await test('v8 旧库救援不升级，正常升级保留数据；不存在时不创建空库', async () => {
    await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase('boxed-lllllabc'); request.onsuccess = resolve; request.onerror = () => reject(request.error); });
    await rejects(() => openExistingBackupDatabase(), error => error.code === 'backup-database-missing');
    assert(!(await indexedDB.databases()).some(db => db.name === 'boxed-lllllabc'), '只读救援创建了空库');
    const request = indexedDB.open('boxed-lllllabc', 8); request.onupgradeneeded = () => migrateDatabase(request.result, request.transaction);
    const db = await idbRequest(request);
    await runIdbTransaction(db, 'chat_meta', 'readwrite', tx => idbRequest(tx.objectStore('chat_meta').put({ chatKey: 'legacy-v8', marker: 'preserve' }))); db.close();
    const existing = await openExistingBackupDatabase(); assert(existing.version === 8, '救援升级了旧库'); existing.close();
    const volumes = [], originalUUID = crypto.randomUUID;
    let manifest;
    try { crypto.randomUUID = undefined; manifest = await exportLocalRescue({ onVolume: async volume => { volumes.push(...await readRescueVolume(volume)); } }); }
    finally { crypto.randomUUID = originalUUID; }
    assert(manifest.databaseVersion === 8 && volumes.some(row => row.key === 'legacy-v8'), '旧版救援缺少数据');
    const normal = await openBackupDatabase(); assert(normal.version === 9, '正常升级未使用 v9');
    const meta = await runIdbTransaction(normal, 'chat_meta', 'readonly', tx => idbRequest(tx.objectStore('chat_meta').get('legacy-v8'))); normal.close();
    assert(meta.marker === 'preserve', '正常升级改写了旧值');
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  if (unhandled.length) failures.push({ name: '无未处理 Promise rejection', errors: unhandled });
  removeEventListener('unhandledrejection', listener);
  return { checks, failures, metrics };
}
