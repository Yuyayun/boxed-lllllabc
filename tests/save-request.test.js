import test from "node:test";
import assert from "node:assert/strict";

import { createMessageRecord } from "../src/backup/pending.js";
import { createSaveRequestPlan, validateSaveRequestPlan } from "../src/backup/save-request.js";
import { createRestoreController } from "../src/controllers/restore-controller.js";
import { buildSaveRequestDialogModel } from "../src/ui/save-request-dialog.js";

const chatKey = "character:1:chat-a";

test("重新保存计划允许 pending 顺序变化但拒绝内容变化", () => {
  const chat = makeChat();
  const first = makePending(0, "第一层");
  const second = makePending(1, "第二层");
  const plan = createSaveRequestPlan({ chat, chatKey, pending: [first, second] });
  const current = { ok: true, chat, identity: { chatKey } };

  assert.equal(validateSaveRequestPlan({
    plan,
    current,
    pending: [second, first],
  }).ok, true);

  const changed = makePending(1, "第二层已变化");
  assert.match(validateSaveRequestPlan({
    plan,
    current,
    pending: [first, changed],
  }).reason, /未保存变更已经变化/);
});

test("重新保存计划拒绝确认期间发生的聊天变化", () => {
  const chat = makeChat();
  const pending = [makePending(1, "第二层")];
  const plan = createSaveRequestPlan({ chat, chatKey, pending });
  const changedChat = structuredClone(chat);
  changedChat[1].mes = "确认期间被修改";

  const validation = validateSaveRequestPlan({
    plan,
    current: { ok: true, chat: changedChat, identity: { chatKey } },
    pending,
  });

  assert.equal(validation.ok, false);
  assert.match(validation.reason, /聊天内容已经变化/);
});

test("重新请求保存只调用一次 saveChat 并等待后端核对", async () => {
  const chat = makeChat();
  const pending = [makePending(1, "第二层")];
  const plan = createSaveRequestPlan({ chat, chatKey, pending });
  const calls = [];
  const controller = createController({
    chat,
    pending,
    async saveChat() {
      calls.push(["save"]);
    },
    setStatus(status) {
      calls.push(["status", status.code]);
    },
    scheduleBackendVerification(...args) {
      calls.push(["verify", ...args]);
    },
    async refreshVisiblePanel() {
      calls.push(["panel"]);
    },
  });

  const result = await controller.requestSave(plan);

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ["save"],
    ["status", "checking"],
    ["verify", chatKey, 2500, 0],
    ["panel"],
  ]);
});

test("重新请求保存抛错时保留 pending 且不安排成功核对", async () => {
  const chat = makeChat();
  const pending = [makePending(1, "第二层")];
  const plan = createSaveRequestPlan({ chat, chatKey, pending });
  const calls = [];
  const controller = createController({
    chat,
    pending,
    async saveChat() {
      calls.push(["save"]);
      throw new Error("文件被锁定");
    },
    setStatus(status) {
      calls.push(["status", status.code, status.pending]);
    },
    scheduleBackendVerification(...args) {
      calls.push(["verify", ...args]);
    },
    async refreshVisiblePanel() {
      calls.push(["panel"]);
    },
  });

  const result = await controller.requestSave(plan);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "文件被锁定");
  assert.deepEqual(calls, [
    ["save"],
    ["status", "unconfirmed", pending],
    ["panel"],
  ]);
});

test("重新请求保存确认模型使用中文说明 pending 范围", () => {
  const pending = [makePending(1, "第二层"), makePending(2, "第三层")];
  const model = buildSaveRequestDialogModel({
    chatName: "专用测试聊天",
    pending,
  });

  assert.equal(model.title, "重新请求保存");
  assert.equal(model.chatName, "专用测试聊天");
  assert.equal(model.pendingCount, 2);
  assert.equal(model.pendingRange, "已备份第 1 层到第 2 层");
});

test("没有 pending 时仍提供请求保存并安排整聊后端核对", async () => {
  const chat = makeChat();
  const plan = createSaveRequestPlan({ chat, chatKey, pending: [] });
  const calls = [];
  const controller = createController({
    chat,
    pending: [],
    async saveChat() { calls.push(["save"]); },
    setStatus(status) { calls.push(["status", status.code]); },
    scheduleBackendVerification: () => { throw new Error("不应使用 pending 核对"); },
    scheduleBackendSnapshotVerification(...args) { calls.push(["snapshot", ...args]); },
    async refreshVisiblePanel() { calls.push(["panel"]); },
  });

  const result = await controller.requestSave(plan);

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ["save"],
    ["status", "checking"],
    ["snapshot", chatKey, plan.chatHash, 2500, 0],
    ["panel"],
  ]);
});

test("没有 pending 时保存确认模型明确说明整聊核对", () => {
  const model = buildSaveRequestDialogModel({ chatName: "测试聊天", pending: [] });

  assert.equal(model.title, "请求保存当前聊天");
  assert.equal(model.pendingCount, 0);
  assert.equal(model.pendingRange, "当前没有待确认变更");
  assert.equal(model.hasPending, false);
  assert.match(model.explanation, /整聊内容核对后端/);
});

test("恢复界面状态在正常已保存时仍暴露保存和恢复入口", () => {
  const chat = makeChat();
  const controller = createController({
    chat,
    pending: [],
    saveChat: async () => {},
    setStatus: () => {},
    scheduleBackendVerification: () => {},
    scheduleBackendSnapshotVerification: () => {},
    refreshVisiblePanel: async () => {},
  });
  const state = controller.createRestoreUiState({
    current: { ok: true, chat, identity: { chatKey } },
    messages: [],
    fullMessages: [],
    historicalChanges: [],
    pending: [],
    meta: { chatDisplayName: "测试聊天" },
  });

  assert.equal(typeof state.onRequestSave, "function");
  assert.equal(typeof state.onOpenRecovery, "function");
  assert.match(state.pendingPlan.blockedReason, /没有可恢复/);
});

function createController({
  chat,
  pending,
  saveChat,
  setStatus,
  scheduleBackendVerification,
  scheduleBackendSnapshotVerification,
  refreshVisiblePanel,
}) {
  return createRestoreController({
    getContextReader: () => ({
      readCurrentChat: () => ({
        ok: true,
        chat,
        identity: { chatKey },
        context: { saveChat },
      }),
    }),
    getSettings: () => ({ enabled: true, backendVerifyDelayMs: 2500 }),
    eventTypes: {},
    readCurrentPending: async () => pending,
    setStatus,
    createDisplayStatus: (code, text, detail, records) => ({
      code,
      text,
      detail,
      pending: records,
    }),
    scheduleBackendVerification,
    scheduleBackendSnapshotVerification,
    refreshVisiblePanel,
    refreshFullBackup: async () => {},
    refreshHistoricalBackup: async () => {},
  });
}

function makeChat() {
  return [
    { mes: "第一层", swipes: ["第一层"], swipe_id: 0 },
    { mes: "第二层", swipes: ["第二层"], swipe_id: 0 },
  ];
}

function makePending(messageIndex, text) {
  return createMessageRecord({
    chatKey,
    messageIndex,
    kind: "message_edit",
    message: { mes: text, swipes: [text], swipe_id: 0 },
    now: "2026-07-11T00:00:00.000Z",
  });
}
