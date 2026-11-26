import { DB_NAME, DB_VERSION, TRANSFER_STORES } from '../db/schema.js';
import { idbRequest, iterateCursor, runIdbTransaction } from '../db/idb-helpers.js';
import { ACTIVE_DATASET_KEY, DATASET_NAMES, datasetStore } from './dataset-layout.js';
import { BACKUP_BUDGET, boundedRecordSize } from './backup-batches.js';
import { STORAGE_LOCK } from './managed.js';
import { LOCAL_RESCUE_FORMAT, LOCAL_RESCUE_VERSION, encodeRescueRecord, sealRescueVolume } from './local-rescue-format.js';
import { newOperationId } from '../backup/pending-journal.js';

const VOLUME_BYTES = 4 * 1024 * 1024;
const fail = (message, code = 'backup-local-recovery-blocked') => Object.assign(new Error(message), { code });
const cancelled = () => new DOMException('已取消只读救援，原库没有改动。', 'AbortError');
const checkSignal = signal => { if (signal?.aborted) throw cancelled(); };
const errorInfo = error => ({ name: error?.name || 'Error', message: error?.message || String(error), ...(error?.code ? { code: error.code } : {}) });

export function openExistingBackupDatabase({ indexedDBImpl = globalThis.indexedDB, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let request, done = false, timer;
    const stop = error => { if (!done) { done = true; clearTimeout(timer); reject(error); } };
    try { request = indexedDBImpl.open(DB_NAME); } catch (error) { stop(error); return; }
    timer = setTimeout(() => stop(fail('读取旧本地备份等待超时，请关闭其他酒馆页签后重试。', 'backup-database-timeout')), timeoutMs);
    request.onupgradeneeded = () => {
      try { request.transaction.abort(); } catch {}
      stop(fail('没有找到可直接读取的旧本地备份，未创建空库。', 'backup-database-missing'));
    };
    request.onerror = () => stop(request.error ?? fail('无法打开旧本地备份。'));
    request.onblocked = () => stop(fail('其他酒馆页签占用了旧本地备份，请关闭后重试。'));
    request.onsuccess = () => {
      if (done) { request.result.close(); return; }
      done = true; clearTimeout(timer);
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

async function guard(db) {
  if (!db.objectStoreNames.contains(TRANSFER_STORES.meta)) return { active: 0, legacy: true };
  return runIdbTransaction(db, TRANSFER_STORES.meta, 'readonly', async tx => {
    const store = tx.objectStore(TRANSFER_STORES.meta), result = {};
    for (const key of [ACTIVE_DATASET_KEY, 'lock', 'revision', 'backup-scope-epoch']) result[key] = (await idbRequest(store.get(key)))?.value ?? null;
    return result;
  });
}

function areaOf(name) {
  if (DATASET_NAMES.includes(name)) return 0;
  return DATASET_NAMES.some(item => datasetStore(item, 1) === name) ? 1 : null;
}

async function rescuePage(db, name, after, signal) {
  return runIdbTransaction(db, name, 'readonly', async tx => {
    const records = []; let bytes = 0, nodes = 100, next = null;
    await iterateCursor(tx.objectStore(name), after === null ? undefined : IDBKeyRange.lowerBound(after, true), item => {
      checkSignal(signal);
      const value = { store: name, key: item.primaryKey, value: item.value }, size = boundedRecordSize(value);
      if (!size.fits) throw fail('单条原始备份超过安全上限，已保留原库。', 'backup-limit');
      if (records.length && (records.length >= BACKUP_BUDGET.rows || bytes + size.bytes > BACKUP_BUDGET.bytes || nodes + size.nodes > BACKUP_BUDGET.nodes)) { next = records.at(-1).key; return false; }
      records.push({ key: item.primaryKey, encoded: encodeRescueRecord(name, item.primaryKey, item.value) });
      bytes += size.bytes; nodes += size.nodes;
    });
    return { records, bytes, after: next };
  });
}

export async function exportLocalRescue({ openExisting = openExistingBackupDatabase, signal, onVolume, onProgress = () => {}, origin = globalThis.location?.origin } = {}) {
  if (typeof onVolume !== 'function') throw new Error('救援需要逐卷保存入口。');
  const id = newOperationId(), createdAt = new Date().toISOString();
  const db = await openExisting();
  const manifest = { format: LOCAL_RESCUE_FORMAT, version: LOCAL_RESCUE_VERSION, type: 'manifest', exportId: id, databaseName: DB_NAME, databaseVersion: db.version, origin, createdAt, tables: [], volumes: [], businessIntegrity: 'not-verified', cancelled: false };
  let bucket = [], bucketBytes = 0, initialGuard, guardError;
  const flush = async () => {
    if (!bucket.length) return;
    checkSignal(signal);
    const volume = await sealRescueVolume({ exportId: id, volume: manifest.volumes.length + 1, databaseName: DB_NAME, databaseVersion: db.version, origin, createdAt }, bucket);
    try { await onVolume(volume); }
    catch (error) { manifest.exportError = errorInfo(error); throw error; }
    manifest.volumes.push({ volume: volume.volume, count: bucket.length, digest: volume.digest });
    bucket = []; bucketBytes = 0;
    if (manifest.volumes.length >= 10000) throw fail('救援分卷数量达到安全上限，已保留原库。', 'backup-limit');
  };
  try {
    try { initialGuard = await guard(db); }
    catch (error) { guardError = errorInfo(error); }
    if (initialGuard?.lock) throw fail('存在未完成的存储迁移，请先核对原任务；未修改或绕过迁移锁。');
    manifest.guard = initialGuard ?? null;
    const active = initialGuard?.[ACTIVE_DATASET_KEY];
    manifest.activeDataset = initialGuard && (active === null || active === 0 || active === 1 || initialGuard.legacy) ? active ?? 0 : null;
    if (guardError) manifest.guardError = guardError;
    for (const name of [...db.objectStoreNames]) {
      checkSignal(signal);
      const table = { store: name, area: areaOf(name), count: 0, pages: 0, lastKey: null, status: 'reading', scanStable: false };
      manifest.tables.push(table); onProgress({ phase: 'reading', store: name, count: 0 });
      try {
        let countBefore;
        try { countBefore = await runIdbTransaction(db, name, 'readonly', tx => idbRequest(tx.objectStore(name).count())); }
        catch (error) { table.countError = errorInfo(error); }
        let after = null;
        do {
          checkSignal(signal);
          table.readAfter = after;
          if (initialGuard && JSON.stringify(await guard(db)) !== JSON.stringify(initialGuard)) throw fail('读取期间本地备份发生变化，已停止当前表。', 'backup-version-changed');
          const page = await rescuePage(db, name, after, signal);
          for (const row of page.records) {
            const bytes = new TextEncoder().encode(JSON.stringify(row.encoded)).byteLength;
            if (bucket.length && (bucket.length >= 10000 || bucketBytes + bytes > VOLUME_BYTES)) await flush();
            bucket.push(row.encoded); bucketBytes += bytes;
            table.count++; table.lastKey = row.key;
          }
          table.pages++; after = page.after;
          onProgress({ phase: 'reading', store: name, count: table.count });
        } while (after !== null);
        let countAfter;
        try { countAfter = await runIdbTransaction(db, name, 'readonly', tx => idbRequest(tx.objectStore(name).count())); }
        catch (error) { table.countError = errorInfo(error); }
        const sameGuard = initialGuard && !initialGuard.legacy && manifest.activeDataset !== null && JSON.stringify(await guard(db)) === JSON.stringify(initialGuard);
        table.scanStable = Boolean(sameGuard && countBefore === countAfter && table.count === countBefore);
        table.status = table.scanStable ? table.count ? 'scanned' : 'empty' : 'unverified';
      } catch (error) {
        table.status = table.count ? 'partial' : 'failed'; table.error = errorInfo(error);
        table.failedAfter = table.readAfter ?? null; table.failedToEnd = true;
        if (error.name === 'AbortError' || manifest.exportError) throw error;
      }
    }
    await flush();
  } catch (error) {
    manifest.cancelled = error.name === 'AbortError'; manifest.error = errorInfo(error);
    // Previously read records remain exportable even if a later table failed.
    if (!manifest.cancelled && !manifest.exportError && bucket.length) { try { await flush(); } catch (next) { manifest.exportError = errorInfo(next); } }
  } finally { db.close(); }
  manifest.finishedAt = new Date().toISOString();
  manifest.exportedRecords = manifest.volumes.reduce((sum, volume) => sum + volume.count, 0);
  manifest.status = manifest.cancelled ? 'cancelled' : manifest.error || manifest.tables.some(table => ['partial', 'failed', 'unverified'].includes(table.status)) ? 'partial' : 'scanned';
  return manifest;
}

export function createLocalRecovery({ control, local, locks = globalThis.navigator?.locks, indexedDBImpl = globalThis.indexedDB,
  pause = async () => {}, resume = async () => {}, onRebuilt = async () => {}, onProgress = () => {}, openExisting, origin = globalThis.location?.origin } = {}) {
  let busy = false, phase = 'idle';
  const progress = value => { phase = value.phase; onProgress(value); };
  async function exclusive(operation) {
    if (busy) throw fail('另一项本地备份处理正在进行。');
    busy = true;
    try {
      if (!locks?.request) throw fail('当前浏览器无法安全取得跨页签操作权，请保留旧库并使用人工处理说明。');
      await pause();
      return await locks.request(STORAGE_LOCK, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) throw fail('其他酒馆页签仍在使用备份，请关闭后重试。');
        const state = await control.read();
        if (state.active !== 'indexeddb' || state.journal) throw fail(state.journal ? '存在未完成的存储操作，请先核对原任务。' : '当前使用服务器备份，不执行浏览器本地救援或重建。');
        return operation();
      });
    } finally { busy = false; phase = 'idle'; await resume(); }
  }
  return {
    state: () => ({ busy, phase }),
    rescue: options => exclusive(() => exportLocalRescue({ ...options, origin, openExisting: openExisting ?? (() => openExistingBackupDatabase({ indexedDBImpl })), onProgress: progress })),
    retry: chatKey => exclusive(() => local.retryLocalReads(chatKey)),
    async rebuild({ confirmed = false, databaseName, confirmedOrigin } = {}) {
      if (!confirmed || databaseName !== DB_NAME || confirmedOrigin !== origin) throw fail('请先确认当前站点及整个本地备份库的删除范围。');
      return exclusive(async () => {
        // A readable persistent lock or a future schema is a reason to stop.
        // An unreadable old payload is precisely what confirmed rebuilding is
        // for; control state and the exclusive lease have already been checked.
        let old, previousGuard;
        try { old = await (openExisting ?? (() => openExistingBackupDatabase({ indexedDBImpl })))(); }
        catch { /* Do not require the failed payload database to open. */ }
        if (old) {
          try {
            if (old.version > DB_VERSION) throw fail('本地备份来自更新的前端版本，请更新扩展；未删除新版数据。', 'backup-client-upgrade-required');
            try { previousGuard = await guard(old); } catch { /* Unreadable payload metadata stays unverified. */ }
            if (previousGuard?.lock) throw fail('旧库登记了未完成的存储迁移，请先核对原任务；未删除旧库。');
          } finally { old.close(); }
        }
        progress({ phase: 'deleting' });
        await new Promise((resolve, reject) => {
          const request = indexedDBImpl.deleteDatabase(DB_NAME);
          request.onblocked = () => progress({ phase: 'blocked' });
          request.onerror = () => reject(request.error ?? fail('删除旧本地备份失败，未开始新建。'));
          request.onsuccess = resolve;
        }).catch(error => { local.markRecoveryFailure?.(error); throw error; });
        progress({ phase: 'creating' });
        // Use the normal adapter's opener, not the read-only rescue connection.
        local.clearRecoveryState();
        local.markRecoveryFailure?.(fail('正在核验重建后的本地备份，写入暂时暂停。'));
        let session;
        try {
          session = await local.open();
          const db = await openBackupDatabaseForRecovery(indexedDBImpl);
          try {
            if (db.version !== DB_VERSION || !DATASET_NAMES.every(name => [0, 1].every(area => db.objectStoreNames.contains(datasetStore(name, area))))) throw fail('新本地备份结构核验失败。');
            await runIdbTransaction(db, [...db.objectStoreNames], 'readonly', async tx => {
              for (const name of db.objectStoreNames) if (await idbRequest(tx.objectStore(name).count()) !== 0) throw fail('新本地备份出现意外记录，未宣称重建完成。');
            });
            // Existing v9 guards must not match an old page's zero/default
            // versions after deleting and re-creating the physical database.
            let fence = Date.now() * 1000 + Math.floor(Math.random() * 1000);
            while ([0, previousGuard?.revision, previousGuard?.['backup-scope-epoch']].includes(fence)) fence++;
            if (!Number.isSafeInteger(fence) || fence <= 0) throw fail('无法建立新本地备份的版本保护，请检查设备时间后重试。');
            await runIdbTransaction(db, TRANSFER_STORES.meta, 'readwrite', async tx => {
              const meta = tx.objectStore(TRANSFER_STORES.meta);
              await idbRequest(meta.put({ key: 'revision', value: fence }));
              await idbRequest(meta.put({ key: 'backup-scope-epoch', value: fence }));
            });
          } finally { db.close(); }
          if ((await session.getBackupCatalogPage()).items.length) throw fail('新本地备份目录不是空目录。');
        } catch (error) { local.markRecoveryFailure?.(error); throw error; }
        finally { session?.close(); }
        local.clearRecoveryState(); await onRebuilt(); progress({ phase: 'rebuilt' });
        return { rebuilt: true, backupCreated: false };
      });
    },
  };
}

// Deferred import keeps the adapter/index module dependency acyclic at load time.
async function openBackupDatabaseForRecovery(indexedDBImpl) {
  const { openBackupDatabase } = await import('../db/index.js');
  return openBackupDatabase({ indexedDBImpl });
}
