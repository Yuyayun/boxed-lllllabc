import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { canonicalizeMessage } from "../src/backup/canonicalize.js";
import { fingerprintBackupRecords } from "../src/backup/cleanup.js";
import {
  createFrozenFullBackupResolutionPlan,
  FROZEN_FULL_BACKUP_ACTIONS,
  validateFrozenFullBackupResolution,
} from "../src/backup/frozen-resolution.js";
import { resolveFrozenFullBackup } from "../src/db/index.js";
import { INDEXES, STORES } from "../src/db/schema.js";
import { buildFrozenBackupDialogModel } from "../src/ui/frozen-backup-dialog.js";

const chatKey = "character:tester.png:frozen-chat";
const incident = {
  kind: "unexpected-shorter-chat",
  detectedAt: "2026-07-25T08:00:00.000Z",
  backupMessageCount: 3,
  observedMessageCount: 2,
  acknowledgedAt: "2026-07-25T08:01:00.000Z",
};

test("冻结处理计划显示旧备份与当前聊天差异", () => {
  const current = makeCurrent();
  const fullMessages = makeBackups(["第 0 层", "第 1 层", "误串入的第 2 层"]);
  const result = createFrozenFullBackupResolutionPlan({
    current,
    meta: makeMeta(),
    fullMessages,
  });

  assert.equal(result.ok, true);
  assert.equal(result.plan.chatName, "冻结测试聊天");
  assert.equal(result.plan.backupRange, "第 0－2 层");
  assert.equal(result.plan.backupCount, 3);
  assert.equal(result.plan.currentRange, "第 0－1 层");
  assert.equal(result.plan.currentCount, 2);
  assert.match(result.plan.incidentText, /没有明确删除事件.*更短/);
});

test("冻结处理确认期间聊天、备份或冻结原因变化都会拒绝旧计划", () => {
  const current = makeCurrent();
  const fullMessages = makeBackups(["第 0 层", "第 1 层", "误串入的第 2 层"]);
  const meta = makeMeta();
  const plan = createFrozenFullBackupResolutionPlan({ current, meta, fullMessages }).plan;

  assert.equal(validateFrozenFullBackupResolution({
    plan,
    action: FROZEN_FULL_BACKUP_ACTIONS.adoptCurrent,
    current,
    meta,
    fullMessages,
  }).ok, true);

  const changedChat = makeCurrent();
  changedChat.chat[1].mes = "确认期间发生变化";
  assert.match(validateFrozenFullBackupResolution({
    plan,
    action: FROZEN_FULL_BACKUP_ACTIONS.adoptCurrent,
    current: changedChat,
    meta,
    fullMessages,
  }).reason, /聊天内容在确认期间发生了变化/);

  assert.match(validateFrozenFullBackupResolution({
    plan,
    action: FROZEN_FULL_BACKUP_ACTIONS.deleteFrozen,
    current,
    meta,
    fullMessages: [...fullMessages, backup(3, "新增")],
  }).reason, /冻结的完整备份.*发生了变化/);

  assert.match(validateFrozenFullBackupResolution({
    plan,
    action: FROZEN_FULL_BACKUP_ACTIONS.deleteFrozen,
    current,
    meta: { ...meta, fullBackupIncident: { ...incident, detectedAt: "2026-07-25T09:00:00.000Z" } },
    fullMessages,
  }).reason, /冻结原因.*发生了变化/);
});

test("采用当前聊天会在同一事务中替换冻结完整备份并解除保护", async () => {
  const oldRecords = makeBackups(["第 0 层", "第 1 层", "误串入的第 2 层"]);
  const meta = makeMeta();
  const replacement = makeBackups(["正确第 0 层", "正确第 1 层"]);
  const { db, state } = createFrozenDatabase({ records: oldRecords, meta });

  const result = await resolveFrozenFullBackup(db, {
    chatKey,
    action: FROZEN_FULL_BACKUP_ACTIONS.adoptCurrent,
    expectedFullFingerprint: fingerprintBackupRecords(oldRecords),
    expectedIncidentFingerprint: fingerprintBackupRecords([incident]),
    messages: replacement,
    identityMeta: { chatKey, chatDisplayName: "冻结测试聊天" },
    now: "2026-07-25T08:10:00.000Z",
  });

  assert.equal(result.deletedCount, 3);
  assert.equal(result.savedCount, 2);
  assert.deepEqual(state.storeNames, [STORES.chatMeta, STORES.fullMessages]);
  assert.equal(state.mode, "readwrite");
  assert.deepEqual(state.records.map((item) => item.text), ["正确第 0 层", "正确第 1 层"]);
  assert.equal(state.meta.fullBackupState, "active");
  assert.equal(state.meta.fullBackupIncident, null);
  assert.equal(state.meta.fullBackupMessageCount, 2);
  assert.equal(state.meta.fullBackupLastReason, "user-confirmed-current-chat");
});

test("删除冻结完整备份只清空 full 仓库并保留其他备份职责边界", async () => {
  const oldRecords = makeBackups(["第 0 层", "第 1 层", "误串入的第 2 层"]);
  const { db, state } = createFrozenDatabase({ records: oldRecords, meta: makeMeta() });

  const result = await resolveFrozenFullBackup(db, {
    chatKey,
    action: FROZEN_FULL_BACKUP_ACTIONS.deleteFrozen,
    expectedFullFingerprint: fingerprintBackupRecords(oldRecords),
    expectedIncidentFingerprint: fingerprintBackupRecords([incident]),
  });

  assert.equal(result.deletedCount, 3);
  assert.equal(result.savedCount, 0);
  assert.deepEqual(state.storeNames, [STORES.chatMeta, STORES.fullMessages]);
  assert.deepEqual(state.records, []);
  assert.equal(state.meta.fullBackupState, "empty");
  assert.equal(state.meta.fullBackupIncident, null);
  assert.equal(state.meta.fullBackupLastReason, "user-confirmed-frozen-delete");
});

test("事务发现冻结事件过期时不会删除或覆盖任何完整备份", async () => {
  const oldRecords = makeBackups(["第 0 层", "第 1 层", "误串入的第 2 层"]);
  const changedIncident = { ...incident, detectedAt: "2026-07-25T09:00:00.000Z" };
  const { db, state } = createFrozenDatabase({
    records: oldRecords,
    meta: makeMeta({ fullBackupIncident: changedIncident }),
  });

  await assert.rejects(resolveFrozenFullBackup(db, {
    chatKey,
    action: FROZEN_FULL_BACKUP_ACTIONS.deleteFrozen,
    expectedFullFingerprint: fingerprintBackupRecords(oldRecords),
    expectedIncidentFingerprint: fingerprintBackupRecords([incident]),
  }), /冻结原因.*发生了变化/);

  assert.equal(state.records.length, 3);
  assert.equal(state.meta.fullBackupState, "frozen");
});

test("冻结处理弹窗使用两步确认、明确动作和手机触控尺寸", async () => {
  const plan = createFrozenFullBackupResolutionPlan({
    current: makeCurrent(),
    meta: makeMeta(),
    fullMessages: makeBackups(["第 0 层", "第 1 层", "误串入的第 2 层"]),
  }).plan;
  const model = buildFrozenBackupDialogModel({ plan, fullBackupEnabled: true });
  const projectRoot = new URL("../", import.meta.url);
  const [source, panelSource, controllerSource, style] = await Promise.all([
    readFile(new URL("src/ui/frozen-backup-dialog.js", projectRoot), "utf8"),
    readFile(new URL("src/ui/current-chat-panel.js", projectRoot), "utf8"),
    readFile(new URL("src/controllers/panel-controller.js", projectRoot), "utf8"),
    readFile(new URL("style.css", projectRoot), "utf8"),
  ]);

  assert.equal(model.title, "处理冻结的完整备份");
  assert.match(model.adoptDetail, /替换冻结副本.*继续自动更新/);
  assert.match(model.deleteDetail, /不影响最近楼层、历史改动、未保存变更或酒馆聊天/);
  assert.match(source, /我已检查，继续确认/);
  assert.match(source, /我已检查当前聊天，确认现在显示的内容是正确的/);
  assert.match(source, /采用当前聊天并恢复更新/);
  assert.match(source, /删除冻结完整备份/);
  assert.match(source, /当前备份位置中的完整备份，不会修改酒馆聊天文件/);
  assert.match(panelSource, /确认当前聊天无误/);
  assert.match(panelSource, /meta\.fullBackupState === "frozen"/);
  assert.match(controllerSource, /createFrozenFullBackupResolutionPlan/);
  assert.match(controllerSource, /executeFrozenResolution/);
  assert.match(style, /\.boxed-lllllabc-frozen-choice \.boxed-lllllabc-action-button\s*\{[\s\S]*?min-height: 44px/);
});

function makeCurrent() {
  return {
    ok: true,
    chat: [
      { mes: "正确第 0 层", swipes: ["正确第 0 层"], swipe_id: 0 },
      { mes: "正确第 1 层", swipes: ["正确第 1 层"], swipe_id: 0 },
    ],
    identity: {
      chatKey,
      meta: {
        chatKey,
        chatDisplayName: "冻结测试聊天",
      },
    },
  };
}

function makeMeta(overrides = {}) {
  return {
    chatKey,
    chatDisplayName: "冻结测试聊天.jsonl",
    fullBackupState: "frozen",
    fullBackupIncident: incident,
    fullBackupMessageCount: 3,
    ...overrides,
  };
}

function makeBackups(texts) {
  return texts.map((text, index) => backup(index, text));
}

function backup(messageIndex, text) {
  return {
    ...canonicalizeMessage({ mes: text, swipes: [text], swipe_id: 0 }, messageIndex, "2026-07-25T07:00:00.000Z"),
    chatKey,
  };
}

function createFrozenDatabase({ records, meta }) {
  const state = {
    records: structuredClone(records),
    meta: structuredClone(meta),
    storeNames: [],
    mode: "",
  };
  const fullStore = {
    index(name) {
      assert.equal(name, INDEXES.fullByChat);
      return {
        getAll(key) {
          assert.equal(key, chatKey);
          return request(structuredClone(state.records));
        },
        getAllKeys(key) {
          assert.equal(key, chatKey);
          return request(state.records.map((item) => [item.chatKey, item.messageIndex]));
        },
      };
    },
    delete(key) {
      state.records = state.records.filter((item) => {
        return item.chatKey !== key[0] || item.messageIndex !== key[1];
      });
      return request(undefined);
    },
    put(value) {
      state.records = state.records.filter((item) => item.messageIndex !== value.messageIndex);
      state.records.push(structuredClone(value));
      state.records.sort((a, b) => a.messageIndex - b.messageIndex);
      return request(value);
    },
  };
  const metaStore = {
    get(key) {
      assert.equal(key, chatKey);
      return request(structuredClone(state.meta));
    },
    put(value) {
      state.meta = structuredClone(value);
      return request(value);
    },
  };
  const stores = new Map([
    [STORES.chatMeta, metaStore],
    [STORES.fullMessages, fullStore],
  ]);
  const db = {
    transaction(storeNames, mode) {
      state.storeNames = storeNames;
      state.mode = mode;
      const transaction = {
        aborted: false,
        objectStore(name) {
          return stores.get(name);
        },
        abort() {
          this.aborted = true;
          queueMicrotask(() => this.onabort?.());
        },
      };
      setTimeout(() => {
        if (!transaction.aborted) transaction.oncomplete?.();
      }, 5);
      return transaction;
    },
  };
  return { db, state };
}

function request(result) {
  const value = { result, error: null };
  queueMicrotask(() => value.onsuccess?.());
  return value;
}
