import test from "node:test";
import assert from "node:assert/strict";

import { buildBackupCatalog } from "../src/backup/catalog.js";
import {
  buildCleanupMetaPatch,
  createBackupCleanupPlan,
  createBackupCleanupPlans,
  fingerprintBackupRecords,
  validateBackupCleanupPlan,
} from "../src/backup/cleanup.js";
import { createCatalogController } from "../src/controllers/catalog-controller.js";
import { deleteBackupTypeForChat } from "../src/db/index.js";
import { INDEXES, STORES } from "../src/db/schema.js";

const chatKey = "character:1:cleanup-chat";

test("单聊天清理只开放最近、历史和未冻结完整备份", () => {
  const chat = buildChat();
  const plans = Object.fromEntries(createBackupCleanupPlans(chat).map((plan) => [plan.type, plan]));

  assert.equal(plans.recent.canConfirm, true);
  assert.equal(plans.full.canConfirm, true);
  assert.equal(plans.historical.canConfirm, true);
  assert.equal(plans.pending.canConfirm, false);
  assert.match(plans.pending.blockedReason, /禁止.*直接清理/);
  assert.match(plans.recent.notice, /不会删除或修改 SillyTavern 聊天文件/);
});

test("冻结完整备份和空备份类型明确禁止清理", () => {
  const frozen = buildChat({ frozen: true });
  const fullPlan = createBackupCleanupPlan({ chat: frozen, type: "full" });
  const emptyHistorical = createBackupCleanupPlan({
    chat: {
      ...frozen,
      historical: emptySummary(),
    },
    type: "historical",
  });

  assert.equal(fullPlan.canConfirm, false);
  assert.match(fullPlan.blockedReason, /冻结保护/);
  assert.equal(emptyHistorical.canConfirm, false);
  assert.match(emptyHistorical.blockedReason, /当前没有历史楼层改动备份/);
});

test("等待后端确认的完整备份暂时禁止清理", () => {
  const awaiting = buildChat({ awaiting: true });
  const plan = createBackupCleanupPlan({ chat: awaiting, type: "full" });

  assert.equal(awaiting.isAwaitingConfirmation, true);
  assert.equal(plan.canConfirm, false);
  assert.match(plan.blockedReason, /等待后端确认/);
});

test("清理预览后目标记录变化会拒绝旧计划", () => {
  const chat = buildChat();
  const plan = createBackupCleanupPlan({ chat, type: "recent" });
  const changed = buildBackupCatalog(makeData({ extraRecent: true })).chats[0];

  assert.equal(validateBackupCleanupPlan({ plan, chat }).ok, true);
  const validation = validateBackupCleanupPlan({ plan, chat: changed });
  assert.equal(validation.ok, false);
  assert.match(validation.reason, /预览后发生了变化/);
});

test("清理元数据补丁不会残留完整备份冻结状态", () => {
  assert.deepEqual(buildCleanupMetaPatch("recent"), {
    lastBackupAt: null,
    recentCount: 0,
    recentFirstIndex: null,
    recentLastIndex: null,
    lastReason: "catalog-cleanup",
  });
  assert.equal(buildCleanupMetaPatch("full").fullBackupState, "empty");
  assert.equal(buildCleanupMetaPatch("full").fullBackupIncident, null);
  assert.equal(buildCleanupMetaPatch("full").fullBackupPendingMessageCount, null);
  assert.deepEqual(buildCleanupMetaPatch("historical"), { historicalUpdatedAt: null });
});

test("IndexedDB 清理在同一事务中复核指纹、删除记录并更新元数据", async () => {
  const records = [record(4), record(5)];
  const { db, state } = createCleanupDatabase({ records });
  const result = await deleteBackupTypeForChat(db, {
    chatKey,
    type: "recent",
    expectedFingerprint: fingerprintBackupRecords(records),
  });

  assert.equal(result.deletedCount, 2);
  assert.deepEqual(state.deletedKeys, [[chatKey, 4], [chatKey, 5]]);
  assert.equal(state.meta.lastBackupAt, null);
  assert.equal(state.meta.recentCount, 0);
  assert.equal(state.transactionMode, "readwrite");
  assert.deepEqual(state.storeNames, [STORES.chatMeta, STORES.recentMessages]);
});

test("IndexedDB 清理发现指纹过期时不删除任何记录", async () => {
  const records = [record(4), record(5)];
  const { db, state } = createCleanupDatabase({ records });

  await assert.rejects(
    deleteBackupTypeForChat(db, {
      chatKey,
      type: "recent",
      expectedFingerprint: fingerprintBackupRecords([record(4)]),
    }),
    /预览后发生了变化/,
  );
  assert.deepEqual(state.deletedKeys, []);
});

test("完整备份在确认前进入冻结状态时数据库事务拒绝删除", async () => {
  const records = [record(0), record(1)];
  const { db, state } = createCleanupDatabase({
    records,
    type: "full",
    meta: { chatKey, fullBackupState: "frozen" },
  });

  await assert.rejects(
    deleteBackupTypeForChat(db, {
      chatKey,
      type: "full",
      expectedFingerprint: fingerprintBackupRecords(records),
    }),
    /冻结保护状态/,
  );
  assert.deepEqual(state.deletedKeys, []);
});

test("完整备份等待后端确认时数据库事务拒绝删除", async () => {
  const records = [record(0), record(1)];
  const { db, state } = createCleanupDatabase({
    records,
    type: "full",
    meta: { chatKey, fullBackupState: "awaiting-confirmation" },
  });

  await assert.rejects(
    deleteBackupTypeForChat(db, {
      chatKey,
      type: "full",
      expectedFingerprint: fingerprintBackupRecords(records),
    }),
    /等待后端确认/,
  );
  assert.deepEqual(state.deletedKeys, []);
});

test("全局控制器清理成功后关闭数据库并刷新索引与当前面板", async () => {
  const data = makeData();
  const calls = [];
  let closeCount = 0;
  const controller = createCatalogController({
    openDatabase: async () => ({ close: () => { closeCount += 1; } }),
    readCatalogData: async () => data,
    deleteBackupType: async (_db, options) => {
      calls.push(["delete", options]);
      return { deletedCount: 2 };
    },
    openDialog: () => {},
    renderDialog: (state) => calls.push(["render", state]),
    openCleanupDialog: () => {},
    refreshVisiblePanel: async () => calls.push(["panel"]),
  });
  const chat = buildBackupCatalog(data).chats[0];
  const plan = createBackupCleanupPlan({ chat, type: "recent" });

  const result = await controller.executeCleanup(plan);

  assert.equal(result.ok, true);
  assert.equal(result.deletedCount, 2);
  assert.equal(closeCount, 2);
  assert.equal(calls[0][0], "delete");
  assert.equal(calls[0][1].expectedFingerprint, plan.expectedFingerprint);
  assert.equal(calls.at(-1)[0], "panel");
});

function buildChat({ frozen = false, awaiting = false } = {}) {
  return buildBackupCatalog(makeData({ frozen, awaiting })).chats[0];
}

function makeData({ frozen = false, awaiting = false, extraRecent = false } = {}) {
  return {
    chatMeta: [{
      chatKey,
      chatDisplayName: "清理测试聊天",
      characterName: "测试角色",
      fullBackupState: frozen ? "frozen" : awaiting ? "awaiting-confirmation" : "active",
      lastBackupAt: "2026-07-12T00:00:00.000Z",
    }],
    recentMessages: [record(4), record(5), ...(extraRecent ? [record(6)] : [])],
    fullMessages: [record(0), record(1)],
    historicalChanges: [{
      chatKey,
      messageIndex: 2,
      message: { text: "历史 2" },
      updatedAt: "2026-07-12T00:01:00.000Z",
    }],
    pendingChanges: [{
      id: `${chatKey}:5`,
      chatKey,
      messageIndex: 5,
      updatedAt: "2026-07-12T00:02:00.000Z",
    }],
  };
}

function record(messageIndex) {
  return {
    chatKey,
    messageIndex,
    text: `第 ${messageIndex} 层`,
    backedUpAt: "2026-07-12T00:00:00.000Z",
  };
}

function emptySummary() {
  return {
    count: 0,
    firstIndex: null,
    lastIndex: null,
    storageBytes: 0,
    fingerprint: fingerprintBackupRecords([]),
  };
}

function createCleanupDatabase({ records, type = "recent", meta = null }) {
  const state = {
    deletedKeys: [],
    meta: meta ?? {
      chatKey,
      lastBackupAt: "2026-07-12T00:00:00.000Z",
      recentCount: records.length,
    },
    storeNames: [],
    transactionMode: "",
  };
  const recordStore = {
    index(name) {
      assert.equal(name, type === "full" ? INDEXES.fullByChat : INDEXES.recentByChat);
      return {
        getAll(key) {
          assert.equal(key, chatKey);
          return request(records);
        },
        getAllKeys(key) {
          assert.equal(key, chatKey);
          return request(records.map((item) => [item.chatKey, item.messageIndex]));
        },
      };
    },
    delete(key) {
      state.deletedKeys.push(key);
      return request(undefined);
    },
  };
  const metaStore = {
    get(key) {
      assert.equal(key, chatKey);
      return request(state.meta);
    },
    put(value) {
      state.meta = value;
      return request(value);
    },
  };
  const stores = new Map([
    [STORES.chatMeta, metaStore],
    [type === "full" ? STORES.fullMessages : STORES.recentMessages, recordStore],
  ]);
  const db = {
    transaction(storeNames, mode) {
      state.storeNames = storeNames;
      state.transactionMode = mode;
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
