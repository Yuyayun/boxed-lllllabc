import test from "node:test";
import assert from "node:assert/strict";

import {
  createHistoricalRecord,
  mergeHistoricalRecord,
} from "../src/backup/historical.js";

function buildChat(length) {
  return Array.from({ length }, (_, index) => ({
    mes: `消息 ${index}`,
    swipes: [`候选 ${index}-0`, `候选 ${index}-1`],
    swipe_id: 1,
  }));
}

test("可信旧楼层编辑保存完整消息和全部候选回复", () => {
  const record = createHistoricalRecord({
    chat: buildChat(10),
    chatKey: "character:test:chat-a",
    eventName: "message_edited",
    args: [3],
    recentLimit: 5,
    now: "2026-07-11T10:00:00.000Z",
  });

  assert.equal(record.messageIndex, 3);
  assert.equal(record.lastKind, "message_edit");
  assert.equal(record.message.swipes.length, 2);
  assert.equal(record.message.swipeIndex, 1);
  assert.equal(record.firstCapturedAt, "2026-07-11T10:00:00.000Z");
});

test("最近范围内的楼层和开场白事件不会写入历史记录", () => {
  const chat = buildChat(10);
  assert.equal(createHistoricalRecord({
    chat,
    chatKey: "character:test:chat-a",
    eventName: "message_edited",
    args: [5],
    recentLimit: 5,
  }), null);
  assert.equal(createHistoricalRecord({
    chat,
    chatKey: "character:test:chat-a",
    eventName: "message_received",
    args: [3, "first_message"],
    recentLimit: 5,
  }), null);
});

test("关闭最近楼层备份后仍按配置层数判断历史范围", () => {
  const record = createHistoricalRecord({
    chat: buildChat(10),
    chatKey: "character:test:chat-a",
    eventName: "message_updated",
    args: [3],
    recentLimit: 5,
    settings: {
      enabled: true,
      recentBackupEnabled: false,
      historicalBackupEnabled: true,
    },
  });

  assert.equal(record.messageIndex, 3);
});

test("删除或关闭历史开关时不猜测历史楼层记录", () => {
  const chat = buildChat(10);
  assert.equal(createHistoricalRecord({
    chat,
    chatKey: "character:test:chat-a",
    eventName: "message_deleted",
    args: [3],
    recentLimit: 5,
  }), null);
  assert.equal(createHistoricalRecord({
    chat,
    chatKey: "character:test:chat-a",
    eventName: "message_edited",
    args: [3],
    recentLimit: 5,
    settings: { enabled: true, historicalBackupEnabled: false },
  }), null);
});

test("同一旧楼层再次修改保留首次捕获时间并更新最新内容", () => {
  const previous = {
    chatKey: "character:test:chat-a",
    messageIndex: 3,
    firstCapturedAt: "2026-07-11T10:00:00.000Z",
    updatedAt: "2026-07-11T10:00:00.000Z",
    message: { text: "旧内容" },
  };
  const next = {
    chatKey: "character:test:chat-a",
    messageIndex: 3,
    firstCapturedAt: "2026-07-11T11:00:00.000Z",
    updatedAt: "2026-07-11T11:00:00.000Z",
    message: { text: "新内容" },
  };

  assert.deepEqual(mergeHistoricalRecord(previous, next), {
    ...next,
    firstCapturedAt: "2026-07-11T10:00:00.000Z",
  });
});
