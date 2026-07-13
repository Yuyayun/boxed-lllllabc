import test from "node:test";
import assert from "node:assert/strict";

import {
  createFullBackupAwaitingMeta,
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

test("记忆插件改写旧楼层并新增消息时等待后端确认而不误报缩短", () => {
  const existingMessages = snapshot(Array.from({ length: 36 }, (_, index) => ({
    mes: String(index),
    extra: {},
  })));
  const currentChat = Array.from({ length: 37 }, (_, index) => ({
    mes: String(index),
    extra: index === 35 ? { memory_leaf: { summary: "摘要" } } : {},
  }));

  const result = createFullBackupDecision({
    existingMessages,
    currentChat,
    triggers: [{ eventName: "message_received", args: [36] }],
  });

  assert.equal(result.action, "await-confirmation");
  assert.equal(result.incident.kind, "unexpected-message-change");
  assert.equal(result.incident.differingIndex, 35);
  assert.deepEqual(result.eventInfo.targetIndexes, [36]);
});

test("后端确认整聊一致后接续记忆插件改写和新增楼层", () => {
  const existingMessages = snapshot([{ mes: "0" }, { mes: "旧的第 1 层" }]);
  const currentChat = [
    { mes: "0" },
    { mes: "旧的第 1 层", extra: { any_memory_plugin: { text: "摘要" } } },
    { mes: "第 2 层" },
  ];

  const result = createFullBackupDecision({
    existingMessages,
    currentChat,
    triggers: [{ eventName: "backend-confirmed", args: [] }],
    backendConfirmed: true,
  });

  assert.equal(result.action, "reconcile");
  assert.equal(result.currentMessages.length, 3);
  assert.deepEqual(result.currentMessages[1].raw.extra, {
    any_memory_plugin: { text: "摘要" },
  });
});

test("等待确认期间内容恢复原样时后端确认仍会清除等待状态", () => {
  const existingMessages = snapshot([{ mes: "0" }, { mes: "1" }]);
  const result = createFullBackupDecision({
    existingMessages,
    currentChat: [{ mes: "0" }, { mes: "1" }],
    triggers: [{ eventName: "backend-confirmed", args: [] }],
    awaitingConfirmation: true,
    backendConfirmed: true,
  });

  assert.equal(result.action, "reconcile");
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

test("冻结后原备份前缀恢复且已有新楼层时也能解除冻结", () => {
  const existingMessages = snapshot([{ mes: "0" }, { mes: "1" }]);
  const result = createFullBackupDecision({
    existingMessages,
    currentChat: [{ mes: "0" }, { mes: "1" }, { mes: "2" }],
    frozen: true,
    frozenIncident: { kind: "unexpected-shorter-chat" },
    triggers: [{ eventName: "message_received", args: [2] }],
  });

  assert.equal(result.action, "unfreeze");
  assert.equal(result.currentMessages.length, 3);
});

test("异常缩短即使后端确认也不会自动覆盖较长完整备份", () => {
  const result = createFullBackupDecision({
    existingMessages: snapshot([{ mes: "0" }, { mes: "1" }]),
    currentChat: [{ mes: "0" }],
    backendConfirmed: true,
    triggers: [{ eventName: "backend-confirmed", args: [] }],
  });

  assert.equal(result.action, "freeze");
  assert.equal(result.incident.kind, "unexpected-shorter-chat");
});

test("等待确认元数据保留已有完整备份时间和范围", () => {
  const meta = createFullBackupAwaitingMeta({
    identity: { chatKey: "chat-a", meta: { chatId: "测试聊天" } },
    currentMessages: snapshot([{ mes: "0" }, { mes: "1" }]),
    previousMeta: {
      chatKey: "chat-a",
      fullBackupAt: "2026-07-12T00:00:00.000Z",
      fullBackupFirstIndex: 0,
      fullBackupLastIndex: 0,
    },
    reason: "message_received",
    incident: { kind: "unexpected-message-change" },
  });

  assert.equal(meta.fullBackupState, "awaiting-confirmation");
  assert.equal(meta.fullBackupAt, "2026-07-12T00:00:00.000Z");
  assert.equal(meta.fullBackupLastIndex, 0);
  assert.equal(meta.fullBackupPendingMessageCount, 2);
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
