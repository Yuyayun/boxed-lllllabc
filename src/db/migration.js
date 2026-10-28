import { INDEXES, STORES, TRANSFER_STORES } from "./schema.js";
import { DATASET_NAMES, datasetStore } from "../storage/dataset-layout.js";

export function migrateDatabase(db, transaction) {
  // Add empty destinations only. The versionchange transaction never iterates
  // or rewrites the existing 1.0.0 payloads.
  for (const name of DATASET_NAMES) {
    const physical = datasetStore(name, 1);
    if (db.objectStoreNames.contains(physical)) continue;
    const keyPath = name === "chat_meta" ? "chatKey"
      : name === "pending_changes" || name === "snapshots" ? "id"
      : name === "snapshot_messages" ? ["snapshotId", "messageIndex"] : ["chatKey", "messageIndex"];
    const store = db.createObjectStore(physical, { keyPath });
    if (name === "chat_meta") store.createIndex("by_lastBackupAt", "lastBackupAt", { unique: false });
    else store.createIndex(name === "snapshot_messages" ? "by_snapshot" : "by_chat", name === "snapshot_messages" ? "snapshotId" : "chatKey", { unique: false });
  }
  if (!db.objectStoreNames.contains(STORES.snapshots)) db.createObjectStore(STORES.snapshots, { keyPath: "id" }).createIndex("by_chat", "chatKey");
  if (!db.objectStoreNames.contains(STORES.snapshotMessages)) db.createObjectStore(STORES.snapshotMessages, { keyPath: ["snapshotId", "messageIndex"] }).createIndex("by_snapshot", "snapshotId");
  if (!db.objectStoreNames.contains(TRANSFER_STORES.meta)) db.createObjectStore(TRANSFER_STORES.meta, { keyPath: "key" });
  if (!db.objectStoreNames.contains(TRANSFER_STORES.rows)) {
    const rows = db.createObjectStore(TRANSFER_STORES.rows, { keyPath: ["id", "kind", "n"] });
    rows.createIndex("unique_record", ["id", "kind", "keyText"], { unique: true });
  }
  let chatMeta;
  if (!db.objectStoreNames.contains(STORES.chatMeta)) {
    chatMeta = db.createObjectStore(STORES.chatMeta, {
      keyPath: "chatKey",
    });
  } else {
    chatMeta = transaction.objectStore(STORES.chatMeta);
  }

  if (!chatMeta.indexNames.contains("by_lastBackupAt")) {
    chatMeta.createIndex("by_lastBackupAt", "lastBackupAt", { unique: false });
  }

  let recentMessages;
  if (!db.objectStoreNames.contains(STORES.recentMessages)) {
    recentMessages = db.createObjectStore(STORES.recentMessages, {
      keyPath: ["chatKey", "messageIndex"],
    });
  } else {
    recentMessages = transaction.objectStore(STORES.recentMessages);
  }

  if (!recentMessages.indexNames.contains(INDEXES.recentByChat)) {
    recentMessages.createIndex(INDEXES.recentByChat, "chatKey", { unique: false });
  }

  let pendingChanges;
  if (!db.objectStoreNames.contains(STORES.pendingChanges)) {
    pendingChanges = db.createObjectStore(STORES.pendingChanges, {
      keyPath: "id",
    });
  } else {
    pendingChanges = transaction.objectStore(STORES.pendingChanges);
  }

  if (!pendingChanges.indexNames.contains(INDEXES.pendingByChat)) {
    pendingChanges.createIndex(INDEXES.pendingByChat, "chatKey", { unique: false });
  }

  let fullMessages;
  if (!db.objectStoreNames.contains(STORES.fullMessages)) {
    fullMessages = db.createObjectStore(STORES.fullMessages, {
      keyPath: ["chatKey", "messageIndex"],
    });
  } else {
    fullMessages = transaction.objectStore(STORES.fullMessages);
  }

  if (!fullMessages.indexNames.contains(INDEXES.fullByChat)) {
    fullMessages.createIndex(INDEXES.fullByChat, "chatKey", { unique: false });
  }

  let historicalChanges;
  if (!db.objectStoreNames.contains(STORES.historicalChanges)) {
    historicalChanges = db.createObjectStore(STORES.historicalChanges, {
      keyPath: ["chatKey", "messageIndex"],
    });
  } else {
    historicalChanges = transaction.objectStore(STORES.historicalChanges);
  }

  if (!historicalChanges.indexNames.contains(INDEXES.historicalByChat)) {
    historicalChanges.createIndex(INDEXES.historicalByChat, "chatKey", { unique: false });
  }
}
