import { migrateDatabase } from "./migration.js";
import { DB_NAME, DB_VERSION, TRANSFER_STORES, STORES } from "./schema.js";
import { createBackupOperations } from "../storage/operations.js";
import { createSnapshotOperations } from "../storage/snapshot-operations.js";
import { encodeStorageValue } from "../storage/protocol.js";

export function openBackupDatabase() {
  if (!globalThis.indexedDB) {
    return Promise.reject(new Error("IndexedDB 不可用。"));
  }

  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    let blocked = false;

    request.onupgradeneeded = () => {
      if (blocked) { request.transaction.abort(); return; }
      migrateDatabase(request.result, request.transaction);
    };

    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
    request.onerror = () => reject(request.error ?? new Error("打开 IndexedDB 失败。"));
    request.onblocked = () => { blocked = true; reject(new Error("IndexedDB 升级被其他页面阻塞，请关闭其他酒馆页签后重试。")); };
  });
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
} = createBackupOperations({ runTransaction, requestToPromise });

export const { beginSnapshot, appendSnapshotMessages, publishSnapshot, getSnapshotHeader, getSnapshotMessages, listSnapshots, renameSnapshot, deleteSnapshot } = createSnapshotOperations({ runTransaction, requestToPromise });

function snapshotDriver(store) {
  return {
    get: store.get.bind(store), put: store.put.bind(store), delete: store.delete.bind(store), index: store.index.bind(store),
    page({ snapshotId, after, limit = 50 }) {
      return new Promise((resolve, reject) => {
        const query = snapshotId ? IDBKeyRange.bound([snapshotId, after], [snapshotId, Infinity], true) : IDBKeyRange.lowerBound(after, true);
        const read = store.openCursor(query), rows = []; let bytes = 0;
        read.onerror = () => reject(read.error);
        read.onsuccess = () => {
          try {
            const cursor = read.result;
            if (!cursor) return resolve(rows);
            const size = new TextEncoder().encode(JSON.stringify(encodeStorageValue(cursor.value))).byteLength;
            if (rows.length && (rows.length >= limit || bytes + size > 2 * 1024 * 1024)) return resolve(rows);
            rows.push(cursor.value); bytes += size; cursor.continue();
          } catch (error) { reject(error); }
        };
      });
    },
  };
}

function runTransaction(db, storeNames, mode, callback) {
  return new Promise((resolve, reject) => {
    const guarded = db.objectStoreNames?.contains(TRANSFER_STORES.meta);
    const transaction = db.transaction(guarded ? [...storeNames, TRANSFER_STORES.meta] : storeNames, mode);
    const stores = new Map(storeNames.map((name) => {
      const store = transaction.objectStore(name);
      return [name, name === STORES.snapshots || name === STORES.snapshotMessages ? snapshotDriver(store) : store];
    }));
    let callbackResult;

    transaction.oncomplete = () => resolve(callbackResult);
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB 事务失败。"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB 事务中止。"));

    Promise.resolve()
      .then(async () => {
        if (guarded && (await requestToPromise(transaction.objectStore(TRANSFER_STORES.meta).get("lock")))?.value) throw new Error("切换存储方式期间备份操作已锁定。");
        return callback(stores);
      })
      .then(async (result) => {
        if (guarded && mode === "readwrite") {
          const meta = transaction.objectStore(TRANSFER_STORES.meta);
          const revision = (await requestToPromise(meta.get("revision")))?.value ?? 0;
          await requestToPromise(meta.put({ key: "revision", value: revision + 1 }));
        }
        return result;
      })
      .then((result) => {
        callbackResult = result;
      })
      .catch((error) => {
        transaction.abort();
        reject(error);
      });
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 请求失败。"));
  });
}
