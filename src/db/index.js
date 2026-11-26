import { migrateDatabase } from "./migration.js";
import { DB_NAME, DB_VERSION, TRANSFER_STORES, STORES } from "./schema.js";
import { createBackupOperations } from "../storage/operations.js";
import { createSnapshotOperations } from "../storage/snapshot-operations.js";
import { ACTIVE_DATASET_KEY, datasetId, datasetStore } from "../storage/dataset-layout.js";
import { mutationDriver } from './mutation-driver.js';
import { BACKUP_BUDGET, boundedRecordSize } from '../storage/backup-batches.js';
import { BACKUP_STORES } from '../storage/backup-batches.js';
import { backupVersionKey } from '../storage/backup-versions.js';
import { idbRequest as requestToPromise, iterateCursor, distinctIndexKeys, runIdbTransaction } from './idb-helpers.js';
import { markIndexedDbError } from './idb-errors.js';

export const BACKUP_DATABASE_OPEN_TIMEOUT_MS = 5000;

export function openBackupDatabase({ indexedDBImpl=globalThis.indexedDB,timeoutMs=BACKUP_DATABASE_OPEN_TIMEOUT_MS,
  setTimer=globalThis.setTimeout,clearTimer=globalThis.clearTimeout }={}) {
  if (!indexedDBImpl) {
    return Promise.reject(markIndexedDbError(new Error("IndexedDB 不可用。")));
  }

  return new Promise((resolve, reject) => {
    let request,timer,settled=false;
    const fail=error=>{if(settled)return;settled=true;clearTimer(timer);reject(markIndexedDbError(databaseOpenError(error)));};
    try {request = indexedDBImpl.open(DB_NAME, DB_VERSION);}
    catch(error){fail(error);return;}
    // An open queued behind another blocked request may receive no onblocked.
    // Bound that wait too, and discard any late connection/upgrade attempt.
    timer=setTimer(()=>fail(Object.assign(new Error('打开本地备份等待超时。请关闭其他酒馆页签后重试；如前端扩展已更新，请刷新当前页面。已有备份已保留。'),{code:'backup-database-timeout'})),timeoutMs);

    request.onupgradeneeded = () => {
      try {
        if (settled) { request.transaction.abort(); return; }
        migrateDatabase(request.result, request.transaction);
      } catch (error) { try { request.transaction.abort(); } catch {} fail(error); }
    };

    request.onsuccess = () => {
      if (settled) {request.result.close();return;}
      settled=true;clearTimer(timer);
      request.result.onversionchange=()=>request.result.close();
      resolve(request.result);
    };
    request.onerror = () => fail(request.error ?? new Error("打开 IndexedDB 失败。"));
    request.onblocked = () => fail(Object.assign(new Error('本地备份升级被其他酒馆页签占用，请关闭其他酒馆页签后重试；已有备份已保留。'),{code:'backup-database-blocked'}));
  });
}

function databaseOpenError(error) {
  if(error?.name!=='VersionError')return error;
  return Object.assign(new Error('当前页面的箱装前端版本较旧，不能打开已升级的本地备份。请更新前端扩展并刷新页面；不要清除浏览器站点数据。',{cause:error}),{name:'VersionError',code:'backup-client-upgrade-required'});
}

export const {
  replaceRecentSnapshot,
  mergeRecentSnapshotMeta,
  putChatMeta,
  getRecentMessages,
  getFullMessages,
  getHistoricalChanges,
  putFullMessages,
  putHistoricalChanges,
  replaceFullSnapshot,
  getChatMeta,
  getBackupCatalogData,
  getBackupCatalog,
  reconcileChatIdentity,
  migrateRenamedChatIdentity,
  deleteBackupTypeForChat,
  deleteBackupBatch,
  resolveFrozenFullBackup,
  putPendingChanges,
  replacePendingChanges,
  getPendingChanges,
  deletePendingChanges,
  deletePendingChangesIfUnchanged,
  pendingDeletionFingerprint,
  updateChatMetaSummary,
} = createBackupOperations({ runTransaction, requestToPromise, catalogDriver: {
  count: store => requestToPromise(store.count()),
  keys: store => [STORES.chatMeta, datasetStore(STORES.chatMeta, 1)].includes(store.name) ? requestToPromise(store.getAllKeys()) : distinctIndexKeys(store.index('by_chat')),
} });

export const { beginSnapshot, appendSnapshotMessages, publishSnapshot, getSnapshotHeader, getSnapshotMessages, listSnapshots, renameSnapshot, deleteSnapshot } = createSnapshotOperations({ runTransaction, requestToPromise });

function snapshotDriver(store) {
  return {
    ...mutationDriver(store),
    async page({ snapshotId, after, limit = 50 }) {
      const query = snapshotId ? IDBKeyRange.bound([snapshotId, after], [snapshotId, Infinity], true) : IDBKeyRange.lowerBound(after, true);
      const rows = []; let bytes = 0, nodes = 100;
      await iterateCursor(store, query, cursor => {
        const size = boundedRecordSize(cursor.value);
        if (rows.length && (rows.length >= limit || bytes + size.bytes > BACKUP_BUDGET.bytes || nodes + size.nodes > BACKUP_BUDGET.nodes)) return false;
        rows.push(cursor.value); bytes += size.bytes; nodes += size.nodes;
      });
      return rows;
    },
  };
}

function runTransaction(db, storeNames, mode, callback) {
  const guarded = db.objectStoreNames?.contains(TRANSFER_STORES.meta);
  const physicalNames = storeNames.flatMap(name => [name, datasetStore(name, 1)].filter(physical => db.objectStoreNames?.contains(physical) ?? physical === name));
  return runIdbTransaction(db, guarded ? [...physicalNames, TRANSFER_STORES.meta] : physicalNames, mode, async transaction => {
    const changedStores = new Set();
    if (guarded && (await requestToPromise(transaction.objectStore(TRANSFER_STORES.meta).get("lock")))?.value) throw new Error("切换备份位置期间备份操作已锁定。");
    const active = guarded ? datasetId((await requestToPromise(transaction.objectStore(TRANSFER_STORES.meta).get(ACTIVE_DATASET_KEY)))?.value) : 0;
    const stores = new Map(storeNames.map(name => {
      const store = transaction.objectStore(datasetStore(name, active));
      return [name, name === STORES.snapshots || name === STORES.snapshotMessages ? snapshotDriver(store)
        : mutationDriver(store, mode === 'readwrite' && BACKUP_STORES.includes(name) ? () => changedStores.add(name) : undefined)];
    }));
    const result = await callback(stores);
    if (guarded && mode === "readwrite") {
      const meta = transaction.objectStore(TRANSFER_STORES.meta);
      const revision = (await requestToPromise(meta.get("revision")))?.value ?? 0;
      await requestToPromise(meta.put({ key: "revision", value: revision + 1 }));
      for (const name of changedStores) {
        const key = backupVersionKey(name), previous = (await requestToPromise(meta.get(key)))?.value ?? 0;
        await requestToPromise(meta.put({ key, value: previous + 1 }));
      }
    }
    return result;
  });
}
