import test from "node:test";
import assert from "node:assert/strict";

import { describeStorageFailure, inspectBackupCatalogData } from "../src/storage/health.js";
import {
  classifyStoragePressure,
  createStorageSnapshot,
  estimateOriginStorage,
} from "../src/storage/quota.js";
import { createStorageController } from "../src/controllers/storage-controller.js";
import { createCurrentChatStorageText } from "../src/ui/storage-status.js";

test("浏览器存储估算返回来源总使用量与可用量", async () => {
  const estimate = await estimateOriginStorage({
    estimate: async () => ({ usage: 100, quota: 1000 }),
  });
  assert.deepEqual(estimate, {
    supported: true,
    usage: 100,
    quota: 1000,
    remaining: 900,
    usageRatio: 0.1,
  });
});

test("存储压力同时参考剩余比例、绝对空间和扩展占用", () => {
  const gib = 1024 ** 3;
  assert.equal(classifyStoragePressure({
    estimate: { supported: true, remaining: 10 * gib, usageRatio: 0.1 },
    extensionBytes: 20,
  }), "normal");
  assert.equal(classifyStoragePressure({
    estimate: { supported: true, remaining: 400 * 1024 ** 2, usageRatio: 0.2 },
  }), "warning");
  assert.equal(classifyStoragePressure({
    estimate: { supported: true, remaining: 100 * 1024 ** 2, usageRatio: 0.2 },
  }), "critical");
  assert.equal(classifyStoragePressure({
    estimate: { supported: false },
    extensionBytes: 600 * 1024 ** 2,
  }), "warning");
});

test("异常备份记录被隔离但不会从原数据中删除", () => {
  const original = {
    chatMeta: [{ chatKey: "chat-a" }, { chatKey: "" }],
    recentMessages: [
      { chatKey: "chat-a", messageIndex: 0 },
      { chatKey: "chat-a", messageIndex: -1 },
    ],
    pendingChanges: [{ id: "chat-a:0", chatKey: "chat-a", messageIndex: 0 }],
  };
  const inspected = inspectBackupCatalogData(original);
  assert.equal(inspected.chatMeta.length, 1);
  assert.equal(inspected.recentMessages.length, 1);
  assert.equal(inspected.healthIssues.reduce((sum, issue) => sum + issue.invalidCount, 0), 2);
  assert.equal(original.chatMeta.length, 2);
  assert.equal(original.recentMessages.length, 2);
});

test("配额写入失败使用明确中文说明", () => {
  const error = new Error("quota reached");
  error.name = "QuotaExceededError";
  assert.deepEqual(describeStorageFailure(error), {
    type: "quota",
    shortText: "本地空间不足，备份未写入",
    detail: "浏览器报告本地存储空间不足。本次备份没有写入成功，已有备份没有被自动删除。",
  });
});

test("存储控制器读取扩展占用并在高风险时每会话只提醒一次", async () => {
  const states = [];
  const warnings = [];
  const session = new Map();
  const controller = createStorageController({
    openDatabase: async () => ({ close() { states.push("close"); } }),
    readCatalogData: async () => ({ chatMeta: [] }),
    buildCatalog: () => ({ storageBytes: 42, invalidRecordCount: 0 }),
    estimateStorage: async () => ({
      supported: true,
      usage: 900,
      quota: 1000,
      remaining: 100,
      usageRatio: 0.9,
    }),
    renderOverview: (snapshot) => states.push(snapshot),
    showWarning: (value) => warnings.push(value),
    openCatalog: () => {},
    sessionStore: {
      getItem: (key) => session.get(key) ?? null,
      setItem: (key, value) => session.set(key, value),
    },
  });

  await controller.refresh({ notify: true });
  await controller.refresh({ notify: true });
  assert.equal(warnings.length, 1);
  assert.equal(controller.getSnapshot().extensionBytes, 42);
  assert.equal(controller.getSnapshot().pressure, "critical");
  assert.equal(states.filter((value) => value === "close").length, 2);
});

test("存储快照保留异常记录数量", () => {
  const snapshot = createStorageSnapshot({
    catalog: { storageBytes: 20, invalidRecordCount: 3 },
    estimate: { supported: false },
  });
  assert.equal(snapshot.invalidRecordCount, 3);
  assert.equal(snapshot.pressure, "unavailable");
});

test("当前聊天空间摘要使用用户可读的剩余空间说明", () => {
  assert.equal(
    createCurrentChatStorageText(
      { estimate: { supported: true, remaining: 2 * 1024 } },
      1024,
    ),
    "当前聊天约 1.00 KB · 预计还可使用 2.00 KB",
  );
});
