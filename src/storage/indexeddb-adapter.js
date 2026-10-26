import * as database from "../db/index.js";
import { createIndexedDbTransfer } from "./indexeddb-transfer.js";

// Keep compound operations in src/db/index.js: their validation and writes must
// continue to run in the same IndexedDB transaction.
const OPERATIONS = Object.freeze({
  beginSnapshot: database.beginSnapshot,
  appendSnapshotMessages: database.appendSnapshotMessages,
  publishSnapshot: database.publishSnapshot,
  getSnapshotHeader: database.getSnapshotHeader,
  getSnapshotMessages: database.getSnapshotMessages,
  listSnapshots: database.listSnapshots,
  renameSnapshot: database.renameSnapshot,
  deleteSnapshot: database.deleteSnapshot,
  getChatMeta: database.getChatMeta,
  putChatMeta: database.putChatMeta,
  updateChatMetaSummary: database.updateChatMetaSummary,
  getRecentMessages: database.getRecentMessages,
  replaceRecentSnapshot: database.replaceRecentSnapshot,
  getFullMessages: database.getFullMessages,
  putFullMessages: database.putFullMessages,
  replaceFullSnapshot: database.replaceFullSnapshot,
  getHistoricalChanges: database.getHistoricalChanges,
  putHistoricalChanges: database.putHistoricalChanges,
  getPendingChanges: database.getPendingChanges,
  putPendingChanges: database.putPendingChanges,
  replacePendingChanges: database.replacePendingChanges,
  deletePendingChanges: database.deletePendingChanges,
  deletePendingChangesIfUnchanged: database.deletePendingChangesIfUnchanged,
  getBackupCatalogData: database.getBackupCatalogData,
  reconcileChatIdentity: database.reconcileChatIdentity,
  migrateRenamedChatIdentity: database.migrateRenamedChatIdentity,
  deleteBackupTypeForChat: database.deleteBackupTypeForChat,
  deleteBackupBatch: database.deleteBackupBatch,
  resolveFrozenFullBackup: database.resolveFrozenFullBackup,
});

/**
 * A storage session exposes domain operations, never a raw database handle.
 * Callers must close it in finally, including when an operation fails.
 * This adapter preserves database names, schemas and transaction boundaries.
 */
export function createIndexedDbStorage({ openDatabase = database.openBackupDatabase } = {}) {
  return Object.freeze({
    mode: "indexeddb",
    async checkCapacity(manifest) {
      let estimate;
      try { estimate = await globalThis.navigator?.storage?.estimate?.(); }
      catch { return; }
      if (Number.isFinite(estimate?.quota) && Number.isFinite(estimate?.usage) && estimate.quota - estimate.usage < manifest.bytes * 2) throw new Error("浏览器可用配额不足以保留暂存和回滚副本，未替换目标数据。");
    },
    transfer: createIndexedDbTransfer({ openDatabase }),
    async open() {
      const db = await openDatabase();
      const session = { close: () => db.close() };
      for (const [name, operation] of Object.entries(OPERATIONS)) {
        session[name] = (...args) => operation(db, ...args);
      }
      return Object.freeze(session);
    },
  });
}
