import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizeMessage } from "../src/backup/canonicalize.js";
import { buildRecoveryCenterModel } from "../src/ui/recovery-center-dialog.js";

test("恢复中心在正常聊天中仍列出全部四类来源和不可用原因", () => {
  const recent = [backup(4, "最近第 4 层")];
  const full = [backup(0, "完整第 0 层")];
  const model = buildRecoveryCenterModel({
    chatName: "测试聊天",
    pendingPlan: { totalCount: 0, blockedReason: "没有可恢复的未保存变更。" },
    pendingCount: 0,
    recentOptions: { startIndex: 5, endIndexes: [], lastIndex: null },
    recentMessages: recent,
    fullPlan: { totalCount: 0, blockedReason: "当前聊天已经与完整聊天备份一致。" },
    fullMessages: full,
    historicalChanges: [],
  });

  assert.equal(model.chatName, "测试聊天");
  assert.equal(model.pending.available, false);
  assert.match(model.pending.reason, /没有可恢复/);
  assert.equal(model.recent.available, false);
  assert.match(model.recent.reason, /第 5 层/);
  assert.equal(model.full.available, false);
  assert.match(model.full.reason, /已经与完整聊天备份一致/);
  assert.deepEqual(model.historical, []);
});

test("恢复中心标记可执行的 pending、recent、full 和历史恢复", () => {
  const model = buildRecoveryCenterModel({
    pendingPlan: { totalCount: 2, blockedReason: "" },
    pendingCount: 2,
    recentOptions: { startIndex: 3, endIndexes: [3, 4], lastIndex: 4 },
    recentMessages: [backup(3, "最近第 3 层"), backup(4, "最近第 4 层")],
    fullPlan: { totalCount: 1, blockedReason: "" },
    fullMessages: [backup(0, "完整第 0 层")],
    historicalChanges: [{ messageIndex: 1, message: backup(1, "历史第 1 层") }],
  });

  assert.equal(model.pending.available, true);
  assert.equal(model.recent.available, true);
  assert.deepEqual(model.recent.endIndexes, [3, 4]);
  assert.equal(model.full.available, true);
  assert.equal(model.historical[0].available, true);
  assert.equal(model.historical[0].preview, "历史第 1 层");
});

test("备份关闭时恢复中心仍可查看但所有恢复动作解释为需先启用", () => {
  const reason = "请先启用本地备份，再执行恢复或请求保存。";
  const model = buildRecoveryCenterModel({
    pendingPlan: { totalCount: 1, blockedReason: "" },
    pendingCount: 1,
    recentOptions: { startIndex: 1, endIndexes: [1], lastIndex: 1 },
    recentMessages: [backup(1, "最近第 1 层")],
    fullPlan: { totalCount: 1, blockedReason: "" },
    fullMessages: [backup(0, "完整第 0 层")],
    historicalChanges: [{ messageIndex: 0, message: backup(0, "历史第 0 层") }],
    disabledReason: reason,
  });

  assert.equal(model.pending.available, false);
  assert.equal(model.recent.available, false);
  assert.equal(model.full.available, false);
  assert.equal(model.historical[0].available, false);
  assert.equal(model.full.reason, reason);
});

function backup(messageIndex, text) {
  return canonicalizeMessage({ mes: text, swipes: [text], swipe_id: 0 }, messageIndex);
}
