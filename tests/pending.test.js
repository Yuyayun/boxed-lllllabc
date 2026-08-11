import test from "node:test";
import assert from "node:assert/strict";

import {
  createPendingRecords,
  formatPendingRange,
  summarizePendingChanges,
} from "../src/backup/pending.js";

test("pending 记录包含全部 swipe", () => {
  const records = createPendingRecords({
    chatKey: "character:1:chat-a",
    eventName: "message_swiped",
    args: [1],
    now: "2026-07-09T00:00:00.000Z",
    chat: [
      { mes: "0" },
      {
        mes: "第二个",
        swipe_id: 1,
        swipes: ["第一个", "第二个"],
      },
    ],
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].messageIndex, 1);
  assert.equal(records[0].kind, "swipe_change");
  assert.equal(records[0].message.swipes.length, 2);
  assert.equal(records[0].message.swipeIndex, 1);
});

test("pending 楼层范围使用用户可读楼层号", () => {
  assert.equal(formatPendingRange(0), "已备份第 0 层");
  assert.equal(formatPendingRange(107, 108), "已备份第 107 层到第 108 层");
});

test("pending 摘要能汇总首尾楼层", () => {
  const summary = summarizePendingChanges([
    { id: "a", messageIndex: 108 },
    { id: "b", messageIndex: 107 },
  ]);

  assert.equal(summary.count, 2);
  assert.equal(summary.firstIndex, 107);
  assert.equal(summary.lastIndex, 108);
  assert.equal(summary.rangeText, "已备份第 107 层到第 108 层");
});

test("结构变化使用简短易懂的备份说明", () => {
  const summary = summarizePendingChanges([{ id: "structural", messageIndex: null }]);

  assert.equal(summary.rangeText, "已备份这次改动");
});

test("新增 swipe 的空槽过渡状态不创建 pending", () => {
  const records = createPendingRecords({
    chatKey: "character:1:chat-a",
    eventName: "message_swiped",
    args: [0],
    chat: [{
      mes: "...",
      swipe_id: 2,
      swipes: ["第一个", "第二个"],
    }],
  });

  assert.deepEqual(records, []);
});

test("删除消息记录完整聊天结构哈希", () => {
  const records = createPendingRecords({
    chatKey: "character:1:chat-a",
    eventName: "message_deleted",
    args: [1],
    chat: [{ mes: "保留的消息" }],
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].messageIndex, null);
  assert.equal(records[0].chatLength, 1);
  assert.match(records[0].canonicalChatHash, /^[0-9a-f]{8}$/);
});

test("聊天切换事件不创建 pending", () => {
  const records = createPendingRecords({
    chatKey: "character:1:chat-a",
    eventName: "chat_id_changed",
    chat: [{ mes: "hello" }],
  });

  assert.deepEqual(records, []);
});

test("加载已有首消息不创建 pending", () => {
  const records = createPendingRecords({
    chatKey: "character:1:chat-a",
    eventName: "message_received",
    args: [0, "first_message"],
    chat: [{ mes: "开场消息" }],
  });

  assert.deepEqual(records, []);
});

test("页面恢复刷新不会被误记为聊天结构变化", () => {
  const records = createPendingRecords({
    chat: [{ mes: "已有消息", swipes: ["已有消息"], swipe_id: 0 }],
    chatKey: "character:tester.png:chat-a",
    eventName: "lifecycle-resume",
  });

  assert.deepEqual(records, []);
});
