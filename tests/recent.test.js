import test from "node:test";
import assert from "node:assert/strict";

import {
  createBackupStatus,
  normalizeRecentLimit,
  refreshRecentBackup,
  shouldPreserveRecentSnapshot,
} from "../src/backup/recent.js";

test("最近备份层数有上下限", () => {
  assert.equal(normalizeRecentLimit("abc"), 20);
  assert.equal(normalizeRecentLimit(0), 1);
  assert.equal(normalizeRecentLimit(300), 200);
  assert.equal(normalizeRecentLimit(12), 12);
});

test("配额错误不会继续显示为普通数据库故障", () => {
  const error = new Error("空间不足");
  error.name = "QuotaExceededError";
  const status = createBackupStatus("db-error", "本地备份不可用", error);
  assert.equal(status.shortText, "本地空间不足，备份未写入");
  assert.equal(status.errorName, "QuotaExceededError");
});

test("关闭备份后不读取聊天也不写库", async () => {
  const status = await refreshRecentBackup({
    contextReader: {
      readCurrentChat() {
        throw new Error("关闭时不应该读取聊天");
      },
    },
    settings: {
      enabled: false,
      recentLimit: 20,
    },
  });

  assert.equal(status.code, "disabled");
  assert.equal(status.shortText, "未启用");
  assert.equal(status.shortText.startsWith("箱装辣白菜："), false);
});

test("聊天非删除性缩短时保留可恢复的 recent 尾部", () => {
  const existingMessages = Array.from({ length: 10 }, (_, messageIndex) => ({ messageIndex }));
  const currentChat = Array.from({ length: 7 }, () => ({}));

  assert.equal(shouldPreserveRecentSnapshot({
    existingMessages,
    currentChat,
    triggers: [{ eventName: "chat_id_changed", args: [] }],
  }), true);
  assert.equal(shouldPreserveRecentSnapshot({
    existingMessages,
    currentChat,
    triggers: [{ eventName: "message_received", args: [0, "first_message"] }],
  }), true);
});

test("明确删除或完成恢复时允许 recent 更新", () => {
  const existingMessages = Array.from({ length: 10 }, (_, messageIndex) => ({ messageIndex }));
  const currentChat = Array.from({ length: 7 }, () => ({}));

  assert.equal(shouldPreserveRecentSnapshot({
    existingMessages,
    currentChat,
    triggers: [{ eventName: "message_deleted", args: [7] }],
  }), false);
  assert.equal(shouldPreserveRecentSnapshot({
    existingMessages,
    currentChat,
    reason: "restore",
  }), false);
});
