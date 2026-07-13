import test from "node:test";
import assert from "node:assert/strict";

import { migrateDatabase } from "../src/db/migration.js";
import { INDEXES, STORES } from "../src/db/schema.js";

function createStore(keyPath) {
  const indexes = new Map();
  return {
    keyPath,
    indexNames: {
      contains(name) {
        return indexes.has(name);
      },
    },
    createIndex(name, indexKeyPath, options) {
      indexes.set(name, { keyPath: indexKeyPath, options });
    },
    indexes,
  };
}

function createVersion3Database() {
  const stores = new Map([
    [STORES.chatMeta, createStore("chatKey")],
    [STORES.recentMessages, createStore(["chatKey", "messageIndex"])],
    [STORES.pendingChanges, createStore("id")],
  ]);
  const database = {
    objectStoreNames: {
      contains(name) {
        return stores.has(name);
      },
    },
    createObjectStore(name, options) {
      const store = createStore(options.keyPath);
      stores.set(name, store);
      return store;
    },
  };
  const transaction = {
    objectStore(name) {
      return stores.get(name);
    },
  };
  return { database, transaction, stores };
}

test("从版本 3 升级时创建完整备份仓库和聊天索引", () => {
  const { database, transaction, stores } = createVersion3Database();

  migrateDatabase(database, transaction);

  const fullMessages = stores.get(STORES.fullMessages);
  assert.ok(fullMessages);
  assert.deepEqual(fullMessages.keyPath, ["chatKey", "messageIndex"]);
  assert.deepEqual(fullMessages.indexes.get(INDEXES.fullByChat), {
    keyPath: "chatKey",
    options: { unique: false },
  });
});
