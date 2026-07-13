import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizeMessage } from "../src/backup/canonicalize.js";
import { createMessageRecord } from "../src/backup/pending.js";
import {
  applyRestorePlan,
  createFullRestorePlan,
  createHistoricalRestorePlan,
  createPendingRestorePlan,
  createRecentRestoreOptions,
  createRecentRestorePlan,
  createRestorePendingRecords,
  formatIndexRange,
  rollbackRestorePlan,
  validateRestorePlan,
} from "../src/backup/restore.js";

const chatKey = "character:1:chat-a";

test("pending 全量恢复同时生成同楼层替换和连续尾部追加", () => {
  const chat = makeChat(9);
  const pending = [3, 9, 10, 11].map((index) => makePending(index, `备份 ${index}`));
  const plan = createPendingRestorePlan({ chat, chatKey, pending });

  assert.equal(plan.blockedReason, "");
  assert.deepEqual(plan.replacements.map((item) => item.messageIndex), [3]);
  assert.deepEqual(plan.appends.map((item) => item.messageIndex), [9, 10, 11]);
  assert.equal(plan.totalCount, 4);
});

test("pending 结构变化会阻止整次恢复", () => {
  const plan = createPendingRestorePlan({
    chat: makeChat(2),
    chatKey,
    pending: [{ id: `${chatKey}:structural`, chatKey, messageIndex: null, kind: "structural_change" }],
  });

  assert.match(plan.blockedReason, /聊天结构变化/);
});

test("pending 缺少当前下一层或尾部断层时阻止恢复", () => {
  const missingStart = createPendingRestorePlan({
    chat: makeChat(3),
    chatKey,
    pending: [makePending(4, "第 4 层")],
  });
  const gap = createPendingRestorePlan({
    chat: makeChat(3),
    chatKey,
    pending: [makePending(3, "第 3 层"), makePending(5, "第 5 层")],
  });

  assert.match(missingStart.blockedReason, /缺少第 3 层/);
  assert.match(gap.blockedReason, /不连续/);
});

test("最近备份只提供从当前长度开始的连续终点", () => {
  const recent = [6, 7, 8, 9, 10, 11, 13].map((index) => makeBackup(index));
  const options = createRecentRestoreOptions({ chat: makeChat(9), recent });

  assert.equal(options.startIndex, 9);
  assert.deepEqual(options.endIndexes, [9, 10, 11]);
});

test("最近备份计划标记同编号 pending 冲突并保留其他记录", () => {
  const chat = makeChat(9);
  const recent = [8, 9, 10, 11].map((index) => makeBackup(index, `最近 ${index}`));
  const pending = [makePending(3, "旧 3"), makePending(9, "旧 9"), makePending(10, "旧 10")];
  const plan = createRecentRestorePlan({ chat, chatKey, recent, pending, endIndex: 11 });

  assert.equal(plan.blockedReason, "");
  assert.deepEqual(plan.appends.map((item) => item.messageIndex), [9, 10, 11]);
  assert.deepEqual(plan.pendingConflicts.map((record) => record.messageIndex), [9, 10]);
});

test("最近备份不能选择跳层或无效终点", () => {
  const plan = createRecentRestorePlan({
    chat: makeChat(2),
    chatKey,
    recent: [makeBackup(2), makeBackup(3)],
    pending: [],
    endIndex: 4,
  });

  assert.match(plan.blockedReason, /有效的连续恢复终点/);
});

test("历史备份只生成同编号替换并标记 pending 冲突", () => {
  const chat = makeChat(4);
  const pending = [makePending(2, "未保存第 2 层"), makePending(3, "未保存第 3 层")];
  const plan = createHistoricalRestorePlan({
    chat,
    chatKey,
    historical: [makeHistorical(2, "历史第 2 层")],
    pending,
    messageIndex: 2,
  });

  assert.equal(plan.blockedReason, "");
  assert.deepEqual(plan.replacements.map((item) => item.messageIndex), [2]);
  assert.deepEqual(plan.appends, []);
  assert.deepEqual(plan.pendingConflicts.map((record) => record.messageIndex), [2]);
  assert.equal(plan.pendingScopeIndexes[0], 2);
});

test("历史备份拒绝恢复当前聊天不存在的楼层", () => {
  const plan = createHistoricalRestorePlan({
    chat: makeChat(2),
    chatKey,
    historical: [makeHistorical(3, "历史第 3 层")],
    pending: [],
    messageIndex: 3,
  });

  assert.match(plan.blockedReason, /只支持同编号替换/);
  assert.deepEqual(plan.replacements, []);
});

test("完整聊天恢复只统计实际替换和尾部删除，并覆盖全部 pending", () => {
  const chat = makeChat(4);
  const fullMessages = [
    makeFull(0, "完整第 0 层"),
    { ...canonicalizeMessage(chat[1], 1), chatKey },
    { ...canonicalizeMessage(chat[2], 2), chatKey },
  ];
  const pending = [
    makePending(0, "未保存第 0 层"),
    { id: `${chatKey}:structural`, chatKey, messageIndex: null, kind: "structural_change" },
  ];
  const plan = createFullRestorePlan({ chat, chatKey, fullMessages, pending });

  assert.equal(plan.blockedReason, "");
  assert.deepEqual(plan.replacements.map((item) => item.messageIndex), [0]);
  assert.deepEqual(plan.appends, []);
  assert.deepEqual(plan.deletions.map((item) => item.messageIndex), [3]);
  assert.equal(plan.totalCount, 2);
  assert.equal(plan.pendingConflicts.length, 2);
});

test("完整聊天恢复支持从当前末尾连续追加", () => {
  const chat = makeChat(1);
  const plan = createFullRestorePlan({
    chat,
    chatKey,
    fullMessages: [
      { ...canonicalizeMessage(chat[0], 0), chatKey },
      makeFull(1, "完整第 1 层"),
    ],
    pending: [],
  });

  assert.deepEqual(plan.replacements, []);
  assert.deepEqual(plan.appends.map((item) => item.messageIndex), [1]);
  assert.deepEqual(plan.deletions, []);
});

test("完整聊天恢复要求从第 0 层连续且可完整回滚", () => {
  const chat = makeChat(3);
  const original = structuredClone(chat);
  const invalidPlan = createFullRestorePlan({
    chat,
    chatKey,
    fullMessages: [makeFull(1, "错误楼层")],
    pending: [],
  });
  assert.match(invalidPlan.blockedReason, /楼层不连续/);

  const plan = createFullRestorePlan({
    chat,
    chatKey,
    fullMessages: [makeFull(0, "完整第 0 层")],
    pending: [],
  });
  const snapshot = applyRestorePlan(chat, plan);
  assert.deepEqual(chat.map((message) => message.mes), ["完整第 0 层"]);
  rollbackRestorePlan(chat, snapshot);
  assert.deepEqual(chat, original);
});

test("完整聊天恢复确认会校验全部 pending 指纹", () => {
  const chat = makeChat(1);
  const pending = [makePending(0, "旧 pending")];
  const plan = createFullRestorePlan({
    chat,
    chatKey,
    fullMessages: [makeFull(0, "完整第 0 层")],
    pending,
  });

  assert.equal(validateRestorePlan({ plan, chat, chatKey, pending }).ok, true);
  assert.match(validateRestorePlan({
    plan,
    chat,
    chatKey,
    pending: [makePending(0, "新 pending")],
  }).reason, /未保存变更/);
});

test("确认时聊天或冲突 pending 变化会使预览失效", () => {
  const chat = makeChat(2);
  const recent = [makeBackup(2), makeBackup(3)];
  const pending = [makePending(2, "旧 pending")];
  const plan = createRecentRestorePlan({ chat, chatKey, recent, pending, endIndex: 3 });

  assert.equal(validateRestorePlan({ plan, chat, chatKey, pending }).ok, true);
  assert.match(validateRestorePlan({ plan, chat: [...chat, { mes: "变化" }], chatKey, pending }).reason, /聊天内容/);
  assert.match(validateRestorePlan({
    plan,
    chat,
    chatKey,
    pending: [makePending(2, "新的 pending")],
  }).reason, /未保存变更/);
});

test("应用计划使用深拷贝并可以完整回滚", () => {
  const chat = makeChat(2);
  const original = structuredClone(chat);
  const pending = [makePending(1, "替换"), makePending(2, "追加")];
  const plan = createPendingRestorePlan({ chat, chatKey, pending });
  const snapshot = applyRestorePlan(chat, plan);

  assert.equal(chat[1].mes, "替换");
  assert.equal(chat[2].mes, "追加");
  chat[2].extra.value = "已修改";
  assert.equal(plan.appends[0].raw.extra.value, "原始");

  rollbackRestorePlan(chat, snapshot);
  assert.deepEqual(chat, original);
});

test("recent 恢复后生成可供后端核对的 pending 记录", () => {
  const chat = makeChat(2);
  const plan = createRecentRestorePlan({
    chat,
    chatKey,
    recent: [makeBackup(2, "恢复 2")],
    pending: [],
    endIndex: 2,
  });
  applyRestorePlan(chat, plan);
  const records = createRestorePendingRecords({
    plan,
    chat,
    chatKey,
    now: "2026-07-11T00:00:00.000Z",
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].messageIndex, 2);
  assert.equal(records[0].kind, "restore");
  assert.equal(records[0].message.text, "恢复 2");
});

test("历史楼层恢复后生成同编号 pending 记录", () => {
  const chat = makeChat(3);
  const plan = createHistoricalRestorePlan({
    chat,
    chatKey,
    historical: [makeHistorical(1, "历史第 1 层")],
    pending: [],
    messageIndex: 1,
  });
  applyRestorePlan(chat, plan);
  const records = createRestorePendingRecords({
    plan,
    chat,
    chatKey,
    now: "2026-07-11T00:00:00.000Z",
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].messageIndex, 1);
  assert.equal(records[0].kind, "restore");
  assert.equal(records[0].message.text, "历史第 1 层");
});

test("完整聊天恢复生成一个整聊结构 pending", () => {
  const chat = [makeFull(0, "完整第 0 层").raw];
  const plan = createFullRestorePlan({
    chat: makeChat(2),
    chatKey,
    fullMessages: [makeFull(0, "完整第 0 层")],
    pending: [],
  });
  const records = createRestorePendingRecords({
    plan,
    chat,
    chatKey,
    now: "2026-07-11T00:00:00.000Z",
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].messageIndex, null);
  assert.equal(records[0].kind, "restore");
  assert.equal(records[0].chatLength, 1);
  assert.match(records[0].canonicalChatHash, /^[0-9a-f]{8}$/);
});

test("楼层范围从 0 开始格式化", () => {
  assert.equal(formatIndexRange([0]), "第 0 层");
  assert.equal(formatIndexRange([0, 1, 2]), "第 0 层到第 2 层");
});

function makeChat(length) {
  return Array.from({ length }, (_, index) => ({
    mes: `当前 ${index}`,
    swipes: [`当前 ${index}`],
    swipe_id: 0,
    extra: { value: "原始" },
  }));
}

function makeBackup(messageIndex, text = `备份 ${messageIndex}`) {
  return canonicalizeMessage({
    mes: text,
    swipes: [text, `${text} 候选`],
    swipe_id: 0,
    extra: { value: "原始" },
  }, messageIndex, "2026-07-11T00:00:00.000Z");
}

function makePending(messageIndex, text) {
  return createMessageRecord({
    chatKey,
    messageIndex,
    kind: "message_edit",
    message: makeBackup(messageIndex, text).raw,
    now: "2026-07-11T00:00:00.000Z",
  });
}

function makeHistorical(messageIndex, text) {
  return {
    chatKey,
    messageIndex,
    message: makeBackup(messageIndex, text),
  };
}

function makeFull(messageIndex, text) {
  return {
    ...makeBackup(messageIndex, text),
    chatKey,
  };
}
