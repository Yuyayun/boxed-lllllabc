import test from "node:test";
import assert from "node:assert/strict";

import {
  createFullBackupDecision,
  shouldPrioritizeFullBackupWarning,
} from "../src/backup/full.js";
import { canonicalizeMessage } from "../src/backup/canonicalize.js";

function snapshot(messages) {
  return messages.map((message, index) => canonicalizeMessage(message, index, "2026-07-11T00:00:00.000Z"));
}

test("首次完整备份保存当前全部楼层", () => {
  const result = createFullBackupDecision({
    currentChat: [{ mes: "0" }, { mes: "1" }],
    triggers: [{ eventName: "chat_id_changed", args: [] }],
  });

  assert.equal(result.action, "create");
  assert.equal(result.messages.length, 2);
});

test("可信新消息只追加缺失尾部", () => {
  const result = createFullBackupDecision({
    existingMessages: snapshot([{ mes: "0" }]),
    currentChat: [{ mes: "0" }, { mes: "1" }],
    triggers: [{ eventName: "message_received", args: [1, "normal"] }],
  });

  assert.equal(result.action, "append");
  assert.deepEqual(result.messages.map((message) => message.messageIndex), [1]);
});

test("可信编辑只更新目标楼层", () => {
  const result = createFullBackupDecision({
    existingMessages: snapshot([{ mes: "0" }, { mes: "旧" }]),
    currentChat: [{ mes: "0" }, { mes: "新" }],
    triggers: [{ eventName: "message_edited", args: [1] }],
  });

  assert.equal(result.action, "update");
  assert.deepEqual(result.messages.map((message) => message.messageIndex), [1]);
});

test("开场白事件不会创建或推进已有完整备份", () => {
  const firstMessageTrigger = [{ eventName: "message_received", args: [1, "first_message"] }];
  const noBackup = createFullBackupDecision({
    currentChat: [{ mes: "开场白" }],
    triggers: firstMessageTrigger,
  });
  const existingBackup = createFullBackupDecision({
    existingMessages: snapshot([{ mes: "旧记录" }]),
    currentChat: [{ mes: "旧记录" }, { mes: "开场白" }],
    triggers: firstMessageTrigger,
  });

  assert.equal(noBackup.action, "skip");
  assert.equal(existingBackup.action, "noop");
});

test("没有删除事件的异常缩短会冻结", () => {
  const result = createFullBackupDecision({
    existingMessages: snapshot([{ mes: "0" }, { mes: "1" }]),
    currentChat: [{ mes: "0" }],
    triggers: [{ eventName: "chat_id_changed", args: [] }],
  });

  assert.equal(result.action, "freeze");
  assert.equal(result.incident.kind, "unexpected-shorter-chat");
});

test("明确删除按最终聊天重建完整备份", () => {
  const result = createFullBackupDecision({
    existingMessages: snapshot([{ mes: "0" }, { mes: "1" }]),
    currentChat: [{ mes: "0" }],
    triggers: [{ eventName: "message_deleted", args: [1] }],
  });

  assert.equal(result.action, "rebuild");
  assert.equal(result.messages.length, 1);
});

test("冻结期间不接受新事件，内容恢复后解除冻结", () => {
  const existingMessages = snapshot([{ mes: "0" }, { mes: "1" }]);
  const blocked = createFullBackupDecision({
    existingMessages,
    currentChat: [{ mes: "0" }],
    frozen: true,
    triggers: [{ eventName: "message_received", args: [0] }],
  });
  const restored = createFullBackupDecision({
    existingMessages,
    currentChat: [{ mes: "0" }, { mes: "1" }],
    frozen: true,
    triggers: [{ eventName: "chat_id_changed", args: [] }],
  });

  assert.equal(blocked.action, "skip-frozen");
  assert.equal(restored.action, "unfreeze");
});

test("未查看的冻结完整备份优先显示警示，暂停或查看后回归普通状态", () => {
  const meta = {
    fullBackupState: "frozen",
    fullBackupIncident: { detectedAt: "2026-07-11T00:00:00.000Z" },
  };

  assert.equal(shouldPrioritizeFullBackupWarning({
    meta,
    settings: { enabled: true, fullBackupEnabled: true },
  }), true);
  assert.equal(shouldPrioritizeFullBackupWarning({
    meta,
    settings: { enabled: true, fullBackupEnabled: false },
  }), false);
  assert.equal(shouldPrioritizeFullBackupWarning({
    meta: {
      ...meta,
      fullBackupIncident: { ...meta.fullBackupIncident, acknowledgedAt: "2026-07-11T00:01:00.000Z" },
    },
    settings: { enabled: true, fullBackupEnabled: true },
  }), false);
});
