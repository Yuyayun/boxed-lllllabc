import { migrateDatabase } from "./migration.js";
import { DB_NAME, DB_VERSION, TRANSFER_STORES } from "./schema.js";
import { createBackupOperations } from "../storage/operations.js";

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
  resolveFrozenFullBackup,
  putPendingChanges,
  replacePendingChanges,
  getPendingChanges,
  deletePendingChanges,
  deletePendingChangesIfUnchanged,
  pendingDeletionFingerprint,
  updateChatMetaSummary,
} = createBackupOperations({ runTransaction, requestToPromise });

function runTransaction(db, storeNames, mode, callback) {
  return new Promise((resolve, reject) => {
    const guarded = db.objectStoreNames?.contains(TRANSFER_STORES.meta);
    const transaction = db.transaction(guarded ? [...storeNames, TRANSFER_STORES.meta] : storeNames, mode);
    const stores = new Map(storeNames.map((name) => [name, transaction.objectStore(name)]));
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
