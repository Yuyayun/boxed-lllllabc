import test from "node:test";
import assert from "node:assert/strict";

import { registerBackupEvents } from "../src/events.js";

test("短时间多个事件会合并但保留每个触发来源", async () => {
  const handlers = new Map();
  const eventSource = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    off(name) {
      handlers.delete(name);
    },
  };

  let received;
  const controller = registerBackupEvents({
    eventSource,
    eventTypes: {
      MESSAGE_SENT: "message_sent",
      MESSAGE_RECEIVED: "message_received",
    },
    debounceMs: 1,
    onBackupNeeded(trigger) {
      received = trigger;
    },
  });

  handlers.get("message_sent")(0);
  handlers.get("message_received")(1);

  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.unregister();

  assert.equal(received.eventName, "batched");
  assert.equal(received.triggers.length, 2);
  assert.deepEqual(received.triggers.map((trigger) => trigger.eventName), [
    "message_sent",
    "message_received",
  ]);
});

test("前一批尚未完成时，后一批等待其结束后再处理", async () => {
  const handlers = new Map();
  const eventSource = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    off(name) {
      handlers.delete(name);
    },
  };
  const runs = [];
  let resolveFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });
  const firstMayFinish = new Promise((resolve) => {
    resolveFirst = resolve;
  });

  const controller = registerBackupEvents({
    eventSource,
    eventTypes: {
      MESSAGE_SENT: "message_sent",
      MESSAGE_RECEIVED: "message_received",
    },
    debounceMs: 1,
    async onBackupNeeded(trigger) {
      runs.push(trigger.triggers.map((item) => item.eventName));
      if (runs.length === 1) {
        markFirstStarted();
        await firstMayFinish;
      }
    },
  });

  handlers.get("message_sent")(0);
  await firstStarted;
  handlers.get("message_received")(1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(runs, [["message_sent"]]);

  resolveFirst();
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.unregister();

  assert.deepEqual(runs, [["message_sent"], ["message_received"]]);
});

test("切到后台前可以立即冲刷尚在防抖中的事件", async () => {
  const handlers = new Map();
  const received = [];
  const controller = registerBackupEvents({
    eventSource: {
      on(name, handler) { handlers.set(name, handler); },
      off(name) { handlers.delete(name); },
    },
    eventTypes: { MESSAGE_UPDATED: "message_updated" },
    debounceMs: 1000,
    async onBackupNeeded(trigger) {
      received.push(trigger.triggers.map((item) => item.eventName));
    },
  });

  handlers.get("message_updated")(3);
  await controller.flush();
  await controller.whenIdle();

  assert.deepEqual(received, [["message_updated"]]);
  controller.unregister();
});

test("CHAT_RENAMED 会先定向迁移再为新身份执行备份", async () => {
  const handlers = new Map();
  const calls = [];
  const controller = registerBackupEvents({
    eventSource: {
      on(name, handler) { handlers.set(name, handler); },
      off(name) { handlers.delete(name); },
    },
    eventTypes: {
      CHAT_CHANGED: "chat_id_changed",
      CHAT_RENAMED: "chat_renamed",
    },
    debounceMs: 1000,
    async onChatRenamed(trigger) {
      calls.push(["rename", trigger.args[0].oldFileName, trigger.args[0].newFileName]);
    },
    async onBackupNeeded(trigger) {
      calls.push(["backup", ...trigger.triggers.map((item) => item.eventName)]);
    },
  });

  handlers.get("chat_id_changed")("renamed-chat");
  handlers.get("chat_renamed")({
    avatarId: "tester.png",
    oldFileName: "chat-a.jsonl",
    newFileName: "renamed-chat.jsonl",
  });
  await controller.whenIdle();

  assert.deepEqual(calls, [
    ["rename", "chat-a.jsonl", "renamed-chat.jsonl"],
    ["backup", "chat_id_changed", "chat_renamed"],
  ]);
  controller.unregister();
});

test("普通聊天切换和创建事件不会触发改名迁移", async () => {
  const handlers = new Map();
  const backupBatches = [];
  let renameCount = 0;
  const controller = registerBackupEvents({
    eventSource: {
      on(name, handler) { handlers.set(name, handler); },
      off(name) { handlers.delete(name); },
    },
    eventTypes: {
      CHAT_CHANGED: "chat_id_changed",
      CHAT_CREATED: "chat_created",
      CHAT_RENAMED: "chat_renamed",
    },
    async onChatRenamed() {
      renameCount += 1;
    },
    async onBackupNeeded(trigger) {
      backupBatches.push(trigger.triggers.map((item) => item.eventName));
    },
  });

  handlers.get("chat_id_changed")("chat-b");
  handlers.get("chat_created")("chat-c");
  await controller.flush();
  await controller.whenIdle();

  assert.equal(renameCount, 0);
  assert.deepEqual(backupBatches, [["chat_id_changed", "chat_created"]]);
  controller.unregister();
});
