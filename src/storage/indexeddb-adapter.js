import * as database from "../db/index.js";
import { createIndexedDbTransfer } from "./indexeddb-transfer.js";
import { createIndexedDbBatchTransfer } from "./indexeddb-batch-transfer.js";
import { BATCH_TRANSFER_VERSION, validateBatchCall } from "./protocol.js";
import {migrationSpaceBudget} from './capacity-budget.js';
import { createIndexedDbBackupBatches } from './indexeddb-backup-batches.js';
import { createIndexedDbReadRecovery } from './indexeddb-read-recovery.js';
import { backupVersionOptions } from './backup-batches.js';

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
  getBackupCatalog: database.getBackupCatalog,
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
export function createIndexedDbStorage({ openDatabase = database.openBackupDatabase,onLegacyProgress=()=>{}, onFailure, recoveryOptions } = {}) {
  const recovery = createIndexedDbReadRecovery({ ...recoveryOptions, onFailure });
  const batches = createIndexedDbBatchTransfer({ openDatabase });
  const backupBatches = createIndexedDbBackupBatches({ openDatabase });
  return Object.freeze({
    mode: "indexeddb",
    getRecoveryState: recovery.state,
    clearRecoveryState: recovery.reset,
    markRecoveryFailure: recovery.block,
    async retryLocalReads(chatKey) {
      return recovery.retry(async (id, operation, args) => {
        if (id) return backupBatches.getBackupWriteStatus(id);
        if (operation && backupBatches[operation]) {
          if (operation === 'getBackupPage') {
            const options = args[0], summary = await backupBatches.getBackupSummary(options.chatKey);
            return backupBatches.getBackupPage({ ...options, ...backupVersionOptions(summary, options.store) });
          }
          return backupBatches[operation](...args);
        }
        const db = await openDatabase();
        try {
          if (operation && OPERATIONS[operation]) return await OPERATIONS[operation](db, ...args);
          if (chatKey) return await backupBatches.getBackupSummary(chatKey);
        }
        finally { db.close(); }
      });
    },
    batchVersion: BATCH_TRANSFER_VERSION,
    batchTransfer(action, args) { validateBatchCall(action, args, "indexeddb"); return batches[action](...args); },
    async checkCapacity(manifest) {
      let estimate;
      try { estimate = await globalThis.navigator?.storage?.estimate?.(); }
      catch { return; }
      if (Number.isFinite(estimate?.quota) && Number.isFinite(estimate?.usage) && estimate.quota - estimate.usage < migrationSpaceBudget(manifest,'indexeddb').requiredAdditionalBytes) throw new Error("浏览器可用配额不足以保留新数据区、索引及写入余量，未替换目标数据。");
    },
    transfer: createIndexedDbTransfer({ openDatabase,onLegacyProgress }),
    async open() {
      let db = await recovery.read('open', [], openDatabase), closed = false;
      const invalidate = () => { db?.close(); db = null; };
      const connection = async () => { if (closed) throw new Error('备份会话已关闭。'); return db ??= await openDatabase(); };
      const session = { close() { closed = true; invalidate(); }, capabilities: { boundedBackup: 1, pendingBackupProof: 1, pendingJournal: 1 } };
      const readNames = new Set(['getChatMeta','getRecentMessages','getFullMessages','getHistoricalChanges','getPendingChanges','getBackupCatalogData','getBackupCatalog','getBackupSummary','getBackupPage','getBackupCatalogPage','getBackupWriteStatus','getSnapshotHeader','getSnapshotMessages','listSnapshots']);
      const install = (name, operation) => {
        session[name] = async (...args) => {
          if (closed) throw new Error('备份会话已关闭。');
          if (readNames.has(name)) return recovery.read(name, args, () => operation(...args), invalidate);
          recovery.assertWritable();
          try { return await operation(...args); }
          catch (error) { recovery.writeFailed(name, args, error); invalidate(); throw error; }
        };
      };
      for (const [name, operation] of Object.entries(backupBatches)) install(name, operation);
      for (const [name, operation] of Object.entries(OPERATIONS)) {
        install(name, async (...args) => operation(await connection(), ...args));
      }
      return Object.freeze(session);
    },
  });
}
