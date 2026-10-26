import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBackupCatalog,
  estimateSerializedBytes,
  formatStorageSize,
  groupCatalogChats,
} from "../src/backup/catalog.js";
import { createCatalogController } from "../src/controllers/catalog-controller.js";

test("全局备份索引按聊天汇总四类记录、范围和占用", () => {
  const chatKey = "character:1:test-chat";
  const data = {
    chatMeta: [{
      chatKey,
      chatType: "character",
      chatDisplayName: "测试聊天.jsonl",
      characterName: "测试角色",
      lastBackendCheckedAt: "2026-07-11T10:00:00.000Z",
    }],
    recentMessages: [8, 9].map((messageIndex) => ({
      chatKey,
      messageIndex,
      text: `最近 ${messageIndex}`,
      backedUpAt: "2026-07-11T10:01:00.000Z",
    })),
    fullMessages: [0, 1, 2].map((messageIndex) => ({
      chatKey,
      messageIndex,
      text: `完整 ${messageIndex}`,
      backedUpAt: "2026-07-11T09:00:00.000Z",
    })),
    historicalChanges: [{
      chatKey,
      messageIndex: 2,
      updatedAt: "2026-07-11T09:30:00.000Z",
    }],
    pendingChanges: [
      { id: `${chatKey}:9`, chatKey, messageIndex: 9, updatedAt: "2026-07-11T10:02:00.000Z" },
      { id: `${chatKey}:structural`, chatKey, messageIndex: null, updatedAt: "2026-07-11T10:02:00.000Z" },
    ],
  };

  const catalog = buildBackupCatalog(data);
  const entry = catalog.chats[0];
  assert.equal(catalog.chatCount, 1);
  assert.equal(catalog.recordCount, 8);
  assert.equal(catalog.pendingChatCount, 1);
  assert.equal(entry.displayName, "测试聊天");
  assert.equal(entry.ownerName, "测试角色");
  assert.equal(entry.recent.firstIndex, 8);
  assert.equal(entry.recent.lastIndex, 9);
  assert.equal(entry.full.count, 3);
  assert.equal(entry.historical.count, 1);
  assert.equal(entry.pending.hasStructural, true);
  assert.equal(entry.lastUpdatedAt, "2026-07-11T10:02:00.000Z");
  assert.ok(entry.storageBytes > 0);
  assert.equal(catalog.storageBytes, entry.storageBytes);
});

test("全局备份索引识别冻结状态并按最近更新时间排序", () => {
  const catalog = buildBackupCatalog({
    chatMeta: [
      {
        chatKey: "character:1:old",
        chatDisplayName: "较早聊天",
        lastBackupAt: "2026-07-10T00:00:00.000Z",
      },
      {
        chatKey: "group:2:new",
        chatType: "group",
        chatDisplayName: "较新群聊",
        groupName: "测试群组",
        fullBackupState: "frozen",
        fullBackupAt: "2026-07-11T00:00:00.000Z",
      },
    ],
    recentMessages: [
      {
        chatKey: "character:1:old",
        messageIndex: 0,
        backedUpAt: "2026-07-10T00:00:00.000Z",
      },
      {
        chatKey: "group:2:new",
        messageIndex: 0,
        backedUpAt: "2026-07-11T00:00:00.000Z",
      },
    ],
  });

  assert.deepEqual(catalog.chats.map((entry) => entry.displayName), ["较新群聊", "较早聊天"]);
  assert.equal(catalog.chats[0].typeLabel, "群聊");
  assert.equal(catalog.chats[0].ownerName, "测试群组");
  assert.equal(catalog.chats[0].isFrozen, true);
  assert.equal(catalog.frozenChatCount, 1);
});

test("没有任何备份记录的纯元数据聊天不进入列表和统计", () => {
  const catalog = buildBackupCatalog({
    chatMeta: [{
      chatKey: "character:tester.png:empty",
      chatType: "character",
      characterName: "测试角色",
      characterAvatar: "tester.png",
      chatId: "空聊天",
      lastSeenAt: "2026-07-12T00:00:00.000Z",
    }],
  });

  assert.deepEqual(catalog.chats, []);
  assert.deepEqual(catalog.groups, []);
  assert.equal(catalog.chatCount, 0);
  assert.equal(catalog.recordCount, 0);
  assert.equal(catalog.storageBytes, 0);
});

test("全部聊天按角色头像分组并汇总组内统计", () => {
  const catalog = buildBackupCatalog({
    chatMeta: [
      {
        chatKey: "character:tester.png:chat-a",
        chatType: "character",
        characterName: "测试角色",
        characterAvatar: "tester.png",
        chatId: "聊天 A",
      },
      {
        chatKey: "character:tester.png:chat-b",
        chatType: "character",
        characterName: "测试角色",
        characterAvatar: "tester.png",
        chatId: "聊天 B",
      },
      {
        chatKey: "character:other.png:chat-c",
        chatType: "character",
        characterName: "另一角色",
        characterAvatar: "other.png",
        chatId: "聊天 C",
      },
    ],
    recentMessages: [
      { chatKey: "character:tester.png:chat-a", messageIndex: 0, backedUpAt: "2026-07-12T03:00:00.000Z" },
      { chatKey: "character:tester.png:chat-b", messageIndex: 0, backedUpAt: "2026-07-12T02:00:00.000Z" },
      { chatKey: "character:other.png:chat-c", messageIndex: 0, backedUpAt: "2026-07-12T01:00:00.000Z" },
    ],
    pendingChanges: [{
      id: "character:tester.png:chat-b:0",
      chatKey: "character:tester.png:chat-b",
      messageIndex: 0,
      updatedAt: "2026-07-12T02:30:00.000Z",
    }],
  });

  assert.equal(catalog.groups.length, 2);
  assert.equal(catalog.groups[0].ownerName, "测试角色");
  assert.equal(catalog.groups[0].chatCount, 2);
  assert.equal(catalog.groups[0].recordCount, 3);
  assert.equal(catalog.groups[0].pendingChatCount, 1);
  assert.deepEqual(catalog.groups[0].chats.map((chat) => chat.displayName), ["聊天 A", "聊天 B"]);
  assert.equal(catalog.groups[1].ownerName, "另一角色");
  assert.deepEqual(groupCatalogChats(catalog.chats), catalog.groups);
});

test("只有孤立备份记录时不暴露内部聊天键", () => {
  const catalog = buildBackupCatalog({
    fullMessages: [{
      chatKey: "character:internal-secret:raw-file-id",
      messageIndex: 0,
      backedUpAt: "2026-07-11T00:00:00.000Z",
      text: "内容",
    }],
  });

  assert.equal(catalog.chats[0].displayName, "未命名聊天");
  assert.equal(catalog.chats[0].ownerName, "");
  assert.doesNotMatch(catalog.chats[0].displayName, /internal-secret|raw-file-id/);
});

test("占用估算按 UTF-8 字节并使用可读单位", () => {
  assert.equal(estimateSerializedBytes("中"), 5);
  assert.equal(formatStorageSize(0), "0 B");
  assert.equal(formatStorageSize(1024), "1.00 KB");
  assert.equal(formatStorageSize(1024 * 1024), "1.00 MB");
});

test("全局索引保留被隔离的异常记录数量", () => {
  const catalog = buildBackupCatalog({
    recentMessages: [{ chatKey: "chat-a", messageIndex: 0 }],
    healthIssues: [
      { storeName: "recentMessages", invalidCount: 2 },
      { storeName: "pendingChanges", invalidCount: 1 },
    ],
  });
  assert.equal(catalog.invalidRecordCount, 3);
});

test("全局备份控制器读取完成后关闭数据库并渲染索引", async () => {
  const calls = [];
  const session = {
    close: () => calls.push("close"),
    async getBackupCatalogData() {
      calls.push(["read", this === session]);
      return { chatMeta: [] };
    },
  };
  const catalog = { chatCount: 1, chats: [] };
  let refreshHandler;
  const controller = createCatalogController({
    storage: { open: async () => session },
    buildCatalog: (data) => {
      calls.push(["build", data.chatMeta.length]);
      return catalog;
    },
    openDialog: ({ onRefresh }) => { refreshHandler = onRefresh; },
    renderDialog: (state) => calls.push(["render", state]),
  });

  const result = await controller.openCatalog();
  assert.equal(typeof refreshHandler, "function");
  assert.equal(result.ok, true);
  assert.equal(result.catalog, catalog);
  assert.equal(calls[0][0], "render");
  assert.equal(calls[0][1].loading, true);
  assert.deepEqual(calls.slice(1), [
    ["read", true],
    ["build", 0],
    ["render", { catalog }],
    "close",
  ]);
});

test("全局备份控制器读取失败时显示中文错误并关闭数据库", async () => {
  const states = [];
  let closed = 0;
  const controller = createCatalogController({
    storage: {
      open: async () => ({
        close: () => { closed += 1; },
        getBackupCatalogData: async () => { throw new Error("数据库读取失败"); },
      }),
    },
    openDialog: () => {},
    renderDialog: (state) => states.push(state),
  });

  const result = await controller.openCatalog();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "数据库读取失败");
  assert.deepEqual(states.at(-1), { error: "数据库读取失败" });
  assert.equal(closed, 1);
});

test("打开全部聊天备份时先让弹层完成一帧显示再读取索引", async () => {
  const calls = [];
  const controller = createCatalogController({
    openDialog: () => calls.push("open"),
    waitForDialogPaint: async () => calls.push("paint"),
    storage: {
      open: async () => {
        calls.push("database");
        return {
          close: () => calls.push("close"),
          getBackupCatalogData: async () => ({ chatMeta: [] }),
        };
      },
    },
    buildCatalog: () => ({ chatCount: 0, chats: [] }),
    renderDialog: (state) => calls.push(state.loading ? "loading" : "catalog"),
  });

  const result = await controller.openCatalog();

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["open", "paint", "loading", "database", "catalog", "close"]);
});
