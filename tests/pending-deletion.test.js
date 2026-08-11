import test from "node:test";
import assert from "node:assert/strict";

import { deletePendingChangesIfUnchanged } from "../src/db/index.js";

test("后端旧响应不能删除核对期间已经更新的同主键 pending", async () => {
  const captured = makePending("old-hash", "2026-08-11T00:00:00.000Z");
  const newer = makePending("new-hash", "2026-08-11T00:00:01.000Z");
  const { db, records } = createPendingDatabase([newer]);

  const deleted = await deletePendingChangesIfUnchanged(db, [captured]);

  assert.deepEqual(deleted, []);
  assert.deepEqual(records.get(newer.id), newer);
});

test("pending 内容仍与核对快照一致时才允许删除", async () => {
  const captured = makePending("same-hash", "2026-08-11T00:00:00.000Z");
  const { db, records } = createPendingDatabase([captured]);

  const deleted = await deletePendingChangesIfUnchanged(db, [structuredClone(captured)]);

  assert.deepEqual(deleted, [captured.id]);
  assert.equal(records.has(captured.id), false);
});

test("核对代次已失效时即使记录未变也停止删除", async () => {
  const captured = makePending("same-hash", "2026-08-11T00:00:00.000Z");
  const { db, records } = createPendingDatabase([captured]);

  const deleted = await deletePendingChangesIfUnchanged(db, [captured], {
    shouldDelete: () => false,
  });

  assert.deepEqual(deleted, []);
  assert.equal(records.has(captured.id), true);
});

function makePending(canonicalHash, updatedAt) {
  return {
    id: "character:tester.png:chat-a:0",
    chatKey: "character:tester.png:chat-a",
    messageIndex: 0,
    kind: "message_edit",
    hashVersion: 2,
    canonicalHash,
    canonicalChatHash: "",
    chatLength: null,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt,
  };
}

function createPendingDatabase(initialRecords) {
  const records = new Map(initialRecords.map((record) => [record.id, structuredClone(record)]));
  const store = {
    get(id) {
      return request(structuredClone(records.get(id)));
    },
    delete(id) {
      records.delete(id);
      return request(undefined);
    },
  };
  const db = {
    transaction() {
      const transaction = {
        objectStore() {
          return store;
        },
        abort() {
          queueMicrotask(() => this.onabort?.());
        },
      };
      setTimeout(() => transaction.oncomplete?.(), 10);
      return transaction;
    },
  };
  return { db, records };
}

function request(result) {
  const value = { result, error: null };
  queueMicrotask(() => value.onsuccess?.());
  return value;
}
