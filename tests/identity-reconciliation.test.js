import test from "node:test";
import assert from "node:assert/strict";

import {
  mergeIdentityMeta,
  rekeyBackupRecord,
  selectIdentityReconciliationSource,
} from "../src/db/identity-reconciliation.js";
import { reconcileChatIdentity } from "../src/db/index.js";
import { STORES } from "../src/db/schema.js";

function makeIdentity({ chatId = "新名字", integrity = "integrity-a" } = {}) {
  return {
    chatKey: `character:tester.png:${chatId}`,
    legacyChatKeys: [`character:7:${chatId}`],
    meta: {
      identityVersion: 2,
      chatType: "character",
      characterId: "7",
      characterAvatar: "tester.png",
      characterName: "测试角色",
      chatId,
      chatIntegrity: integrity,
    },
  };
}

test("旧版 characterId 键按相同角色和聊天文件接续", () => {
  const identity = makeIdentity({ chatId: "原名字" });
  const result = selectIdentityReconciliationSource({
    identity,
    metas: [{
      chatKey: "character:7:原名字",
      chatType: "character",
      characterAvatar: "tester.png",
      chatId: "原名字",
    }],
  });

  assert.deepEqual(result, {
    status: "migrate",
    sourceKey: "character:7:原名字",
    reason: "location",
  });
});

test("聊天改名后按 integrity 接续原来的备份", () => {
  const identity = makeIdentity({ chatId: "新名字", integrity: "integrity-a" });
  const result = selectIdentityReconciliationSource({
    identity,
    metas: [{
      chatKey: "character:tester.png:原名字",
      identityVersion: 2,
      chatType: "character",
      characterAvatar: "tester.png",
      chatId: "原名字",
      chatIntegrity: "integrity-a",
    }],
  });

  assert.deepEqual(result, {
    status: "migrate",
    sourceKey: "character:tester.png:原名字",
    reason: "integrity",
  });
});

test("相同 integrity 对应多份聊天时拒绝猜测迁移", () => {
  const identity = makeIdentity();
  const result = selectIdentityReconciliationSource({
    identity,
    metas: ["甲", "乙"].map((chatId) => ({
      chatKey: `character:tester.png:${chatId}`,
      chatType: "character",
      characterAvatar: "tester.png",
      chatId,
      chatIntegrity: "integrity-a",
    })),
  });

  assert.deepEqual(result, { status: "ambiguous", reason: "integrity" });
});

test("迁移记录时更新复合键和 pending 主键", () => {
  assert.deepEqual(
    rekeyBackupRecord({ chatKey: "旧键", messageIndex: 4, text: "内容" }, "新键", "recent"),
    { chatKey: "新键", messageIndex: 4, text: "内容" },
  );
  assert.deepEqual(
    rekeyBackupRecord({ id: "旧键:structural", chatKey: "旧键", messageIndex: null }, "新键", "pending"),
    { id: "新键:structural", chatKey: "新键", messageIndex: null },
  );
});

test("更新身份元数据时不使用空字段覆盖已有显示信息", () => {
  assert.deepEqual(
    mergeIdentityMeta(
      { chatKey: "旧键", characterName: "已有名称", recentCount: 10 },
      { chatKey: "新键", characterName: "", chatId: "新名字" },
    ),
    { chatKey: "新键", characterName: "已有名称", recentCount: 10, chatId: "新名字" },
  );
});

test("IndexedDB 身份接续在同一事务中迁移四类记录和元数据", async () => {
  const oldKey = "character:tester.png:原名字";
  const identity = makeIdentity({ chatId: "新名字", integrity: "integrity-a" });
  const { db, state } = createIdentityDatabase({
    chatMeta: [{
      chatKey: oldKey,
      chatType: "character",
      characterAvatar: "tester.png",
      chatId: "原名字",
      chatIntegrity: "integrity-a",
      recentCount: 1,
    }],
    recentMessages: [{ chatKey: oldKey, messageIndex: 2, text: "最近" }],
    pendingChanges: [{ id: `${oldKey}:2`, chatKey: oldKey, messageIndex: 2, text: "待确认" }],
    fullMessages: [{ chatKey: oldKey, messageIndex: 0, text: "完整" }],
    historicalChanges: [{ chatKey: oldKey, messageIndex: 1, text: "历史" }],
  });

  const result = await reconcileChatIdentity(db, identity);

  assert.equal(result.status, "migrate");
  assert.equal(state.mode, "readwrite");
  assert.deepEqual(new Set(state.storeNames), new Set(Object.values(STORES)));
  assert.equal(state.chatMeta.length, 1);
  assert.equal(state.chatMeta[0].chatKey, identity.chatKey);
  assert.equal(state.chatMeta[0].chatId, "新名字");
  assert.equal(state.chatMeta[0].recentCount, 1);
  for (const name of ["recentMessages", "fullMessages", "historicalChanges"]) {
    assert.equal(state[name].length, 1);
    assert.equal(state[name][0].chatKey, identity.chatKey);
  }
  assert.deepEqual(state.pendingChanges[0], {
    id: `${identity.chatKey}:2`,
    chatKey: identity.chatKey,
    messageIndex: 2,
    text: "待确认",
  });
});

function createIdentityDatabase(initial) {
  const state = {
    chatMeta: structuredClone(initial.chatMeta ?? []),
    recentMessages: structuredClone(initial.recentMessages ?? []),
    pendingChanges: structuredClone(initial.pendingChanges ?? []),
    fullMessages: structuredClone(initial.fullMessages ?? []),
    historicalChanges: structuredClone(initial.historicalChanges ?? []),
    storeNames: [],
    mode: "",
  };
  const stateNames = {
    [STORES.chatMeta]: "chatMeta",
    [STORES.recentMessages]: "recentMessages",
    [STORES.pendingChanges]: "pendingChanges",
    [STORES.fullMessages]: "fullMessages",
    [STORES.historicalChanges]: "historicalChanges",
  };

  const stores = new Map(Object.entries(stateNames).map(([storeName, stateName]) => {
    const isMeta = storeName === STORES.chatMeta;
    const isPending = storeName === STORES.pendingChanges;
    const primaryKey = (record) => isMeta
      ? record.chatKey
      : isPending
        ? record.id
        : JSON.stringify([record.chatKey, record.messageIndex]);
    const store = {
      getAll() {
        return request(structuredClone(state[stateName]));
      },
      put(value) {
        const key = primaryKey(value);
        state[stateName] = state[stateName].filter((record) => primaryKey(record) !== key);
        state[stateName].push(structuredClone(value));
        return request(value);
      },
      delete(key) {
        const normalizedKey = Array.isArray(key) ? JSON.stringify(key) : key;
        state[stateName] = state[stateName].filter((record) => primaryKey(record) !== normalizedKey);
        return request(undefined);
      },
      index() {
        return {
          getAll(chatKey) {
            return request(structuredClone(state[stateName].filter((record) => record.chatKey === chatKey)));
          },
        };
      },
    };
    return [storeName, store];
  }));

  const db = {
    transaction(storeNames, mode) {
      state.storeNames = storeNames;
      state.mode = mode;
      const transaction = {
        aborted: false,
        objectStore(name) {
          return stores.get(name);
        },
        abort() {
          this.aborted = true;
          queueMicrotask(() => this.onabort?.());
        },
      };
      setTimeout(() => {
        if (!transaction.aborted) transaction.oncomplete?.();
      }, 10);
      return transaction;
    },
  };
  return { db, state };
}

function request(result) {
  const value = { result, error: null };
  queueMicrotask(() => value.onsuccess?.());
  return value;
}
