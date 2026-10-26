import test from "node:test";
import assert from "node:assert/strict";

import { createBackupStorage, defaultBackupStorage } from "../src/storage/service.js";
import { createIndexedDbStorage } from "../src/storage/indexeddb-adapter.js";
import { refreshRecentBackup } from "../src/backup/recent.js";
import { createBackupCoordinator } from "../src/controllers/backup-coordinator.js";
import { createRestoreController } from "../src/controllers/restore-controller.js";
import { createRecentRestorePlan } from "../src/backup/restore.js";
import { canonicalizeMessage } from "../src/backup/canonicalize.js";

test("默认存储保持 IndexedDB，创建服务不会打开数据库", async () => {
  let opens = 0;
  const adapter = createIndexedDbStorage({
    openDatabase: async () => { opens += 1; return { close() {} }; },
  });
  const storage = createBackupStorage({ adapter });
  assert.equal(defaultBackupStorage.getMode(), "indexeddb");
  assert.equal(storage.getMode(), "indexeddb");
  assert.equal(opens, 0);
  const session = await storage.open();
  assert.equal(opens, 1);
  assert.equal(session.transaction, undefined);
  session.close();
});

test("活动端打开失败时传播原错误，不尝试其他存储端", async () => {
  const failure = new Error("活动端不可用");
  let opens = 0;
  const storage = createBackupStorage({
    adapter: { mode: "test-backend", open: async () => { opens += 1; throw failure; } },
  });
  await assert.rejects(storage.open(), (error) => error === failure);
  assert.equal(opens, 1);
  assert.equal(storage.getMode(), "test-backend");
});

test("最近备份只经注入存储读写，保留完整消息及楼层并关闭会话", async () => {
  const calls = [];
  const chat = [0, 1, 2].map((index) => ({ mes: `楼层 ${index}`, swipes: ["甲", "乙"], swipe_id: 1, extra: { index } }));
  let snapshot;
  const status = await refreshRecentBackup({
    storage: { open: async () => ({
      getRecentMessages: async (key) => { calls.push(["read", key]); return []; },
      replaceRecentSnapshot: async (value) => { snapshot = value; calls.push(["write"]); },
      close: () => calls.push(["close"]),
    }) },
    contextReader: { readCurrentChat: () => ({ ok: true, chat, identity: { chatKey: "injected", meta: {} } }) },
    settings: { enabled: true, recentBackupEnabled: true, recentLimit: 2 },
  });
  assert.equal(status.code, "ok");
  assert.deepEqual(snapshot.messages.map((message) => message.messageIndex), [1, 2]);
  assert.deepEqual(snapshot.messages[0].raw, chat[1]);
  assert.deepEqual(calls, [["read", "injected"], ["write"], ["close"]]);
});

test("保留较长最近备份的提前返回也会关闭会话且不写入", async () => {
  let closed = 0;
  const status = await refreshRecentBackup({
    storage: { open: async () => ({
      getRecentMessages: async () => [{ messageIndex: 0 }, { messageIndex: 1 }],
      replaceRecentSnapshot: async () => { throw new Error("不应写入"); },
      close: () => { closed += 1; },
    }) },
    contextReader: { readCurrentChat: () => ({ ok: true, chat: [{ mes: "第 0 层" }], identity: { chatKey: "injected", meta: {} } }) },
    settings: { enabled: true, recentBackupEnabled: true, recentLimit: 2 },
    triggers: [{ eventName: "chat_id_changed" }],
  });
  assert.equal(status.code, "recent-preserved");
  assert.equal(closed, 1);
});

test("协调器通过注入存储读取 pending，不依赖全局 IndexedDB", async () => {
  let closed = 0;
  const records = [{ id: "injected:0" }];
  const coordinator = createBackupCoordinator({
    storage: { open: async () => ({
      getPendingChanges: async (key) => { assert.equal(key, "injected"); return records; },
      close: () => { closed += 1; },
    }) },
  });
  assert.equal(await coordinator.readCurrentPending("injected"), records);
  assert.equal(closed, 1);
});

test("恢复保护写入失败时关闭注入会话，回滚聊天且不提交酒馆保存", async () => {
  const chat = [{ mes: "当前内容" }];
  const identity = { chatKey: "restore-injected" };
  let closed = 0;
  let saved = 0;
  const plan = createRecentRestorePlan({
    chat,
    chatKey: identity.chatKey,
    recent: [canonicalizeMessage({ mes: "尾部恢复" }, 1)],
    pending: [],
    endIndex: 1,
  });
  const controller = createRestoreController({
    storage: { open: async () => ({
      putPendingChanges: async () => { throw new Error("注入端写入失败"); },
      close: () => { closed += 1; },
    }) },
    getContextReader: () => ({ readCurrentChat: () => ({ ok: true, chat, identity, context: { saveChat: () => { saved += 1; } } }) }),
    readCurrentPending: async () => [],
  });
  const result = await controller.confirmRestore(plan);
  assert.equal(result.ok, false);
  assert.equal(result.stage, "pending");
  assert.equal(closed, 1);
  assert.equal(saved, 0);
  assert.deepEqual(chat, [{ mes: "当前内容" }]);
});
