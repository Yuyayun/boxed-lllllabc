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

function createVersion4Database() {
  const stores = new Map([
    [STORES.chatMeta, createStore("chatKey")],
    [STORES.recentMessages, createStore(["chatKey", "messageIndex"])],
    [STORES.pendingChanges, createStore("id")],
    [STORES.fullMessages, createStore(["chatKey", "messageIndex"])],
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

test("从版本 4 升级时创建历史改动仓库和聊天索引", () => {
  const { database, transaction, stores } = createVersion4Database();

  migrateDatabase(database, transaction);

  const historicalChanges = stores.get(STORES.historicalChanges);
  assert.ok(historicalChanges);
  assert.deepEqual(historicalChanges.keyPath, ["chatKey", "messageIndex"]);
  assert.deepEqual(historicalChanges.indexes.get(INDEXES.historicalByChat), {
    keyPath: "chatKey",
    options: { unique: false },
  });
});
