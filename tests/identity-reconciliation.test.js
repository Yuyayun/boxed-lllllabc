import test from "node:test";
import assert from "node:assert/strict";

import {
  mergeIdentityMeta,
  rekeyBackupRecord,
  selectExplicitRenameSource,
  selectIdentityReconciliationSource,
} from "../src/db/identity-reconciliation.js";
import { migrateRenamedChatIdentity, reconcileChatIdentity } from "../src/db/index.js";
import { buildChatRenameIdentity } from "../src/identity.js";
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
    reason: "legacy-key",
  });
});

test("父聊天创建 Branch 时相同 integrity 仍建立新身份", () => {
  const identity = makeIdentity({ chatId: "chat-a - Branch #1", integrity: "integrity-a" });
  const result = selectIdentityReconciliationSource({
    identity,
    metas: [{
      chatKey: "character:tester.png:chat-a",
      identityVersion: 2,
      chatType: "character",
      characterAvatar: "tester.png",
      chatId: "chat-a",
      chatIntegrity: "integrity-a",
    }],
  });

  assert.deepEqual(result, { status: "new" });
});

test("多份相同 integrity 也不会参与普通身份迁移", () => {
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

  assert.deepEqual(result, { status: "new" });
});

test("群聊 Branch 也不会凭相同 integrity 接续父聊天", () => {
  const identity = {
    chatKey: "group:group-1:branch-chat",
    legacyChatKeys: [],
    meta: {
      chatType: "group",
      groupId: "group-1",
      chatId: "branch-chat",
      chatIntegrity: "same-integrity",
    },
  };
  assert.deepEqual(selectIdentityReconciliationSource({
    identity,
    metas: [{
      chatKey: "group:group-1:parent-chat",
      chatType: "group",
      groupId: "group-1",
      chatId: "parent-chat",
      chatIntegrity: "same-integrity",
    }],
  }), { status: "new" });
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

test("明确 CHAT_RENAMED 路径在同一事务中迁移四类记录和元数据", async () => {
  const oldKey = "character:tester.png:原名字";
  const rename = buildChatRenameIdentity({
    avatarId: "tester.png",
    oldFileName: "原名字.jsonl",
    newFileName: "新名字.jsonl",
  });
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

  const result = await migrateRenamedChatIdentity(db, rename);

  assert.equal(result.status, "migrate");
  assert.equal(result.reason, "explicit-rename");
  assert.equal(state.mode, "readwrite");
  assert.deepEqual(new Set(state.storeNames), new Set(Object.values(STORES)));
  assert.equal(state.chatMeta.length, 1);
  assert.equal(state.chatMeta[0].chatKey, rename.identity.chatKey);
  assert.equal(state.chatMeta[0].chatId, "新名字");
  assert.equal(state.chatMeta[0].recentCount, 1);
  for (const name of ["recentMessages", "fullMessages", "historicalChanges"]) {
    assert.equal(state[name].length, 1);
    assert.equal(state[name][0].chatKey, rename.identity.chatKey);
  }
  assert.deepEqual(state.pendingChanges[0], {
    id: `${rename.identity.chatKey}:2`,
    chatKey: rename.identity.chatKey,
    messageIndex: 2,
    text: "待确认",
  });
});

test("旧版 characterId 键仍在同一事务中迁移四类记录和元数据", async () => {
  const oldKey = "character:7:原名字";
  const identity = makeIdentity({ chatId: "原名字", integrity: "integrity-a" });
  const { db, state } = createIdentityDatabase({
    chatMeta: [{
      chatKey: oldKey,
      chatType: "character",
      characterId: "7",
      characterAvatar: "tester.png",
      chatId: "原名字",
      recentCount: 1,
    }],
    recentMessages: [{ chatKey: oldKey, messageIndex: 2, text: "最近" }],
    pendingChanges: [{ id: `${oldKey}:2`, chatKey: oldKey, messageIndex: 2, text: "待确认" }],
    fullMessages: [{ chatKey: oldKey, messageIndex: 0, text: "完整" }],
    historicalChanges: [{ chatKey: oldKey, messageIndex: 1, text: "历史" }],
  });

  const result = await reconcileChatIdentity(db, identity);

  assert.equal(result.status, "migrate");
  assert.equal(result.reason, "legacy-key");
  assert.equal(state.chatMeta.length, 1);
  assert.equal(state.chatMeta[0].chatKey, identity.chatKey);
  assert.equal(state.chatMeta[0].recentCount, 1);
  for (const name of ["recentMessages", "pendingChanges", "fullMessages", "historicalChanges"]) {
    assert.equal(state[name].length, 1);
    assert.equal(state[name][0].chatKey, identity.chatKey);
  }
  assert.equal(state.pendingChanges[0].id, `${identity.chatKey}:2`);
});

test("父聊天与两层 Branch 的 metadata 和四类备份始终相互隔离", async () => {
  const parentKey = "character:tester.png:chat-a";
  const branchOne = makeIdentity({ chatId: "chat-a - Branch #1", integrity: "integrity-a" });
  const branchTwo = makeIdentity({ chatId: "chat-a - Branch #2", integrity: "integrity-a" });
  const { db, state } = createIdentityDatabase({
    chatMeta: [{
      chatKey: parentKey,
      chatType: "character",
      characterAvatar: "tester.png",
      chatId: "chat-a",
      chatIntegrity: "integrity-a",
    }],
    recentMessages: [{ chatKey: parentKey, messageIndex: 3, text: "父最近" }],
    pendingChanges: [{ id: `${parentKey}:3`, chatKey: parentKey, messageIndex: 3, text: "父待确认" }],
    fullMessages: [{ chatKey: parentKey, messageIndex: 0, text: "父完整" }],
    historicalChanges: [{ chatKey: parentKey, messageIndex: 1, text: "父历史" }],
  });

  assert.equal((await reconcileChatIdentity(db, branchOne)).status, "new");
  state.recentMessages.push({ chatKey: branchOne.chatKey, messageIndex: 3, text: "一层最近" });
  state.pendingChanges.push({ id: `${branchOne.chatKey}:3`, chatKey: branchOne.chatKey, messageIndex: 3, text: "一层待确认" });
  state.fullMessages.push({ chatKey: branchOne.chatKey, messageIndex: 0, text: "一层完整" });
  state.historicalChanges.push({ chatKey: branchOne.chatKey, messageIndex: 1, text: "一层历史" });
  assert.equal((await reconcileChatIdentity(db, branchTwo)).status, "new");
  state.recentMessages.push({ chatKey: branchTwo.chatKey, messageIndex: 3, text: "二层最近" });
  state.pendingChanges.push({ id: `${branchTwo.chatKey}:3`, chatKey: branchTwo.chatKey, messageIndex: 3, text: "二层待确认" });
  state.fullMessages.push({ chatKey: branchTwo.chatKey, messageIndex: 0, text: "二层完整" });
  state.historicalChanges.push({ chatKey: branchTwo.chatKey, messageIndex: 1, text: "二层历史" });

  assert.deepEqual(new Set(state.chatMeta.map((meta) => meta.chatKey)), new Set([
    parentKey,
    branchOne.chatKey,
    branchTwo.chatKey,
  ]));
  for (const name of ["recentMessages", "pendingChanges", "fullMessages", "historicalChanges"]) {
    assert.deepEqual(new Set(state[name].map((record) => record.chatKey)), new Set([
      parentKey,
      branchOne.chatKey,
      branchTwo.chatKey,
    ]));
  }
});

test("明确改名目标已有备份时拒绝覆盖", () => {
  const rename = buildChatRenameIdentity({
    avatarId: "tester.png",
    oldFileName: "chat-a.jsonl",
    newFileName: "renamed-chat.jsonl",
  });
  const result = selectExplicitRenameSource({
    rename,
    metas: [
      { chatKey: "character:tester.png:chat-a", chatType: "character", characterAvatar: "tester.png", chatId: "chat-a" },
      { chatKey: "character:tester.png:renamed-chat", chatType: "character", characterAvatar: "tester.png", chatId: "renamed-chat" },
    ],
  });

  assert.deepEqual(result, {
    status: "conflict",
    sourceKey: "character:tester.png:chat-a",
    targetKey: "character:tester.png:renamed-chat",
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
