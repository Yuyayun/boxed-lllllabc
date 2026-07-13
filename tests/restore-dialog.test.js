import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizeMessage } from "../src/backup/canonicalize.js";
import { createMessageRecord } from "../src/backup/pending.js";
import { createFullRestorePlan, createHistoricalRestorePlan, createRecentRestorePlan } from "../src/backup/restore.js";
import { buildRestoreDialogModel } from "../src/ui/restore-dialog.js";

test("恢复预览模型明确标注会覆盖的 pending 楼层", () => {
  const chatKey = "character:1:chat-a";
  const chat = [{ mes: "第 0 层", swipes: ["第 0 层"], swipe_id: 0 }];
  const recent = [backup(1, "最近 1"), backup(2, "最近 2")];
  const pending = [createMessageRecord({
    chatKey,
    messageIndex: 1,
    kind: "message_edit",
    message: backup(1, "未保存 1").raw,
    now: "2026-07-11T00:00:00.000Z",
  })];
  const plan = createRecentRestorePlan({ chat, chatKey, recent, pending, endIndex: 2 });
  const model = buildRestoreDialogModel({ plan, chatName: "测试聊天", currentChat: chat });

  assert.equal(model.hasConflicts, true);
  assert.equal(model.conflictRange, "第 1 层");
  assert.equal(model.items[0].conflictPreview, "未保存 1");
  assert.equal(model.items[0].backupPreview, "最近 1");
  assert.equal(model.items[1].conflictPreview, "");
});

test("没有重叠 pending 时不显示冲突状态", () => {
  const chatKey = "character:1:chat-a";
  const chat = [{ mes: "第 0 层", swipes: ["第 0 层"], swipe_id: 0 }];
  const plan = createRecentRestorePlan({
    chat,
    chatKey,
    recent: [backup(1, "最近 1")],
    pending: [],
    endIndex: 1,
  });
  const model = buildRestoreDialogModel({ plan, chatName: "测试聊天", currentChat: chat });

  assert.equal(model.hasConflicts, false);
  assert.equal(model.conflictRange, "");
  assert.equal(model.appendRange, "第 1 层");
});

test("历史楼层恢复预览显示同编号替换来源", () => {
  const chatKey = "character:1:chat-a";
  const chat = [{ mes: "当前第 0 层", swipes: ["当前第 0 层"], swipe_id: 0 }];
  const plan = createHistoricalRestorePlan({
    chat,
    chatKey,
    historical: [{
      chatKey,
      messageIndex: 0,
      message: backup(0, "历史第 0 层"),
    }],
    pending: [],
    messageIndex: 0,
  });
  const model = buildRestoreDialogModel({ plan, chatName: "测试聊天", currentChat: chat });

  assert.equal(model.sourceLabel, "历史楼层改动备份");
  assert.equal(model.replacementRange, "第 0 层");
  assert.equal(model.items[0].action, "替换");
  assert.equal(model.items[0].currentPreview, "当前第 0 层");
  assert.equal(model.items[0].backupPreview, "历史第 0 层");
});

test("完整聊天恢复预览显示替换、删除和全部 pending 覆盖", () => {
  const chatKey = "character:1:chat-a";
  const chat = [
    { mes: "当前第 0 层", swipes: ["当前第 0 层"], swipe_id: 0 },
    { mes: "将删除第 1 层", swipes: ["将删除第 1 层"], swipe_id: 0 },
  ];
  const pending = [createMessageRecord({
    chatKey,
    messageIndex: 0,
    kind: "message_edit",
    message: chat[0],
  })];
  const plan = createFullRestorePlan({
    chat,
    chatKey,
    fullMessages: [{ ...backup(0, "完整第 0 层"), chatKey }],
    pending,
  });
  const model = buildRestoreDialogModel({ plan, chatName: "测试聊天", currentChat: chat });

  assert.equal(model.sourceLabel, "完整聊天备份（整份覆盖）");
  assert.equal(model.replacementRange, "第 0 层");
  assert.equal(model.deletionRange, "第 1 层");
  assert.equal(model.replacesAllPending, true);
  assert.equal(model.conflictCount, 1);
  assert.deepEqual(model.items.map((item) => item.action), ["替换", "删除"]);
  assert.equal(model.items[1].backupPreview, "该楼层不存在");
});

function backup(messageIndex, text) {
  return canonicalizeMessage({ mes: text, swipes: [text], swipe_id: 0 }, messageIndex);
}
