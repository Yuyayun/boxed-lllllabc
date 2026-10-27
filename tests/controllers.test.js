import test from "node:test";
import assert from "node:assert/strict";

import { hashCanonicalChat } from "../src/backup/canonicalize.js";
import { createMessageRecord } from "../src/backup/pending.js";
import { createBackendVerifier } from "../src/controllers/backend-verifier.js";
import { createBackupCoordinator } from "../src/controllers/backup-coordinator.js";
import { buildCurrentCleanupChat, createPanelController } from "../src/controllers/panel-controller.js";
import { renderRestoredMessages } from "../src/controllers/restore-controller.js";

test("备份协调器在总开关关闭时不读取聊天并取消核对", async () => {
  const calls = [];
  const coordinator = createBackupCoordinator({
    getContextReader() {
      throw new Error("关闭时不应读取聊天");
    },
    getSettings: () => ({ enabled: false }),
    getLatestStatus: () => null,
    setStatus: (status) => calls.push(["status", status.code]),
    refreshVisiblePanel: async () => calls.push(["panel"]),
    clearScheduledVerification: () => calls.push(["clear"]),
    verifyBackendNow: async () => {},
    scheduleBackendVerification: () => {},
    verificationRetryLimit: 3,
  });

  const status = await coordinator.runBackupNow();

  assert.equal(status.code, "disabled");
  assert.deepEqual(calls, [
    ["clear"],
    ["status", "disabled"],
    ["panel"],
  ]);
});

test("备份协调器在聊天身份不足时停止写入", async () => {
  const calls = [];
  const coordinator = createBackupCoordinator({
    getContextReader: () => ({
      readCurrentChat: () => ({ ok: false, reason: "身份不足" }),
    }),
    getSettings: () => ({ enabled: true }),
    getLatestStatus: () => null,
    setStatus: (status) => calls.push(status),
    refreshVisiblePanel: async () => calls.push("panel"),
    clearScheduledVerification: () => {},
    verifyBackendNow: async () => {},
    scheduleBackendVerification: () => {},
    verificationRetryLimit: 3,
  });

  const status = await coordinator.runBackupNow();

  assert.equal(status.code, "identity-missing");
  assert.equal(status.detail, "身份不足");
  assert.equal(calls.at(-1), "panel");
});

test("备份协调器能从正式 CHAT_RENAMED 事件读取当前身份并执行定向迁移", async () => {
  let receivedRename;
  let closed = 0;
  const coordinator = createBackupCoordinator({
    getContextReader: () => ({
      readCurrentChat: () => ({
        ok: true,
        identity: {
          ok: true,
          chatKey: "character:tester.png:chat-b",
          meta: {
            chatType: "character",
            characterAvatar: "tester.png",
            chatId: "chat-b",
          },
        },
      }),
    }),
    storage: {
      open: async () => ({
        close() { closed += 1; },
        async migrateRenamedChatIdentity(rename) {
          receivedRename = rename;
          return { status: "migrate" };
        },
      }),
    },
  });

  const result = await coordinator.handleChatRenamed([{
    avatarId: "tester.png",
    oldFileName: "chat-a.jsonl",
    newFileName: "chat-b.jsonl",
  }]);

  assert.equal(result.status, "migrate");
  assert.equal(receivedRename.source.sourceKey, "character:tester.png:chat-a");
  assert.equal(receivedRename.identity.chatKey, "character:tester.png:chat-b");
  assert.equal(closed, 1);
});

test("后端核对没有 pending 时仍核对整聊并接续完整备份", async () => {
  const chat = [{ mes: "当前聊天" }];
  const calls = [];
  const verifier = createBackendVerifier({
    getContextReader: () => ({
      readCurrentChat: () => ({ ok: true, chat, identity: { chatKey: "chat-a" } }),
    }),
    getSettings: () => ({ enabled: true }),
    getLatestStatus: () => null,
    setStatus: (status) => calls.push(["status", status.code]),
    refreshVisiblePanel: async () => calls.push(["panel"]),
    prioritizeFullBackupStatus: async (_chatKey, status) => status,
    readCurrentPending: async () => [],
    updateBackendMeta: async (...args) => calls.push(["meta", ...args]),
    createDisplayStatus: (code) => ({ code }),
    confirmFullBackup: async ({ current }) => calls.push(["full", current.chat.length]),
    needsFullBackupConfirmation: async () => true,
    readBackend: async () => ({ ok: true, chat: [{ chat_metadata: {} }, ...structuredClone(chat)] }),
  });

  const status = await verifier.verifyBackendNow({ chatKey: "chat-a" });

  assert.equal(status.code, "saved");
  assert.deepEqual(calls, [
    ["status", "checking"],
    ["full", 1],
    ["status", "saved"],
    ["meta", "chat-a", "saved", []],
    ["panel"],
  ]);
});

test("普通无 pending 状态不会额外执行整聊读取", async () => {
  const calls = [];
  const verifier = createBackendVerifier({
    getContextReader: () => ({
      readCurrentChat: () => ({ ok: true, chat: [{ mes: "当前聊天" }], identity: { chatKey: "chat-a" } }),
    }),
    getSettings: () => ({ enabled: true }),
    getLatestStatus: () => null,
    setStatus: (status) => calls.push(["status", status.code]),
    refreshVisiblePanel: async () => calls.push(["panel"]),
    prioritizeFullBackupStatus: async (_chatKey, status) => status,
    readCurrentPending: async () => [],
    updateBackendMeta: async (...args) => calls.push(["meta", ...args]),
    createDisplayStatus: (code) => ({ code }),
    needsFullBackupConfirmation: async () => false,
    readBackend: async () => { throw new Error("普通状态不应读取整聊"); },
  });

  const status = await verifier.verifyBackendNow({ chatKey: "chat-a" });

  assert.equal(status.code, "saved");
  assert.deepEqual(calls, [
    ["status", "saved"],
    ["meta", "chat-a", "saved", []],
    ["panel"],
  ]);
});

test("无 pending 的请求保存使用整聊哈希读取后端核对", async () => {
  const chat = [{ mes: "当前聊天", swipes: ["当前聊天"], swipe_id: 0 }];
  const calls = [];
  const verifier = createBackendVerifier({
    getContextReader: () => ({
      readCurrentChat: () => ({ ok: true, chat, identity: { chatKey: "chat-a" } }),
    }),
    getSettings: () => ({ enabled: true }),
    getLatestStatus: () => null,
    setStatus: (status) => calls.push(["status", status.code]),
    refreshVisiblePanel: async () => calls.push(["panel"]),
    prioritizeFullBackupStatus: async (_chatKey, status) => status,
    readCurrentPending: async () => [],
    updateBackendMeta: async (...args) => calls.push(["meta", ...args]),
    createDisplayStatus: (code) => ({ code }),
    readBackend: async () => ({
      ok: true,
      chat: [{ chat_metadata: {} }, ...structuredClone(chat)],
    }),
  });

  const status = await verifier.verifyBackendSnapshotNow({
    chatKey: "chat-a",
    expectedChatHash: hashCanonicalChat(chat),
  });

  assert.equal(status.code, "saved");
  assert.deepEqual(calls, [
    ["status", "checking"],
    ["status", "saved"],
    ["meta", "chat-a", "saved", []],
    ["panel"],
  ]);
});

test("后端整聊尚未一致时不会接续完整备份", async () => {
  const chat = [{ mes: "前端内容" }];
  let confirmations = 0;
  const verifier = createBackendVerifier({
    getContextReader: () => ({
      readCurrentChat: () => ({ ok: true, chat, identity: { chatKey: "chat-a" } }),
    }),
    getSettings: () => ({ enabled: true }),
    getLatestStatus: () => null,
    setStatus: () => {},
    refreshVisiblePanel: async () => {},
    prioritizeFullBackupStatus: async (_chatKey, status) => status,
    readCurrentPending: async () => [],
    updateBackendMeta: async () => {},
    createDisplayStatus: (code) => ({ code }),
    confirmFullBackup: async () => { confirmations += 1; },
    readBackend: async () => ({ ok: true, chat: [{ mes: "后端旧内容" }] }),
    retryDelays: [],
  });

  const status = await verifier.verifyBackendSnapshotNow({
    chatKey: "chat-a",
    expectedChatHash: hashCanonicalChat(chat),
  });

  assert.equal(status.code, "unconfirmed");
  assert.equal(confirmations, 0);
});

test("后端读取期间聊天继续变化时拒绝用旧响应确认完整备份", async () => {
  const chat = [{ mes: "请求开始时的内容" }];
  const expectedChatHash = hashCanonicalChat(chat);
  let confirmations = 0;
  const verifier = createBackendVerifier({
    getContextReader: () => ({
      readCurrentChat: () => ({ ok: true, chat, identity: { chatKey: "chat-a" } }),
    }),
    getSettings: () => ({ enabled: true }),
    getLatestStatus: () => null,
    setStatus: () => {},
    refreshVisiblePanel: async () => {},
    prioritizeFullBackupStatus: async (_chatKey, status) => status,
    readCurrentPending: async () => [],
    updateBackendMeta: async () => {},
    createDisplayStatus: (code) => ({ code }),
    confirmFullBackup: async () => { confirmations += 1; },
    readBackend: async () => {
      chat.push({ mes: "请求期间新增的内容" });
      return { ok: true, chat: [{ mes: "请求开始时的内容" }] };
    },
  });

  const status = await verifier.verifyBackendSnapshotNow({
    chatKey: "chat-a",
    expectedChatHash,
  });

  assert.equal(status.code, "unconfirmed");
  assert.equal(confirmations, 0);
});

test("取消后端核对定时器后不会执行旧任务", async () => {
  let contextReads = 0;
  const verifier = createBackendVerifier({
    getContextReader: () => ({
      readCurrentChat() {
        contextReads += 1;
        return { ok: false };
      },
    }),
    getSettings: () => ({ enabled: true }),
    getLatestStatus: () => null,
    setStatus: () => {},
    refreshVisiblePanel: async () => {},
    prioritizeFullBackupStatus: async (_chatKey, status) => status,
    readCurrentPending: async () => [],
    updateBackendMeta: async () => {},
    createDisplayStatus: () => ({ code: "saved" }),
  });

  verifier.scheduleBackendVerification("chat-a", 5, 0);
  verifier.clearScheduledVerification();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(contextReads, 0);
});

test("新的后端核对会取消旧请求且旧响应不能再删 pending 或回写状态", async () => {
  const currentChat = [{ mes: "当前内容" }];
  const pending = [createMessageRecord({
    chatKey: "chat-a",
    messageIndex: 0,
    kind: "message_edit",
    message: currentChat[0],
  })];
  const firstBackend = deferred();
  const secondBackend = deferred();
  const started = [deferred(), deferred()];
  const signals = [];
  const deleted = [];
  const metaWrites = [];
  const statuses = [];
  let latestStatus = { code: "idle" };
  let readCount = 0;
  const verifier = createBackendVerifier({
    getContextReader: () => ({
      readCurrentChat: () => ({
        ok: true,
        chat: currentChat,
        identity: { chatKey: "chat-a" },
      }),
    }),
    getSettings: () => ({ enabled: true }),
    getLatestStatus: () => latestStatus,
    setStatus(status) {
      latestStatus = status;
      statuses.push(status.code);
    },
    refreshVisiblePanel: async () => {},
    prioritizeFullBackupStatus: async (_chatKey, status) => status,
    readCurrentPending: async () => pending,
    updateBackendMeta: async (_chatKey, outcome) => metaWrites.push(outcome),
    createDisplayStatus: (code) => ({ code }),
    needsFullBackupConfirmation: async () => false,
    deleteConfirmedPending: async (records) => deleted.push(...records),
    retryDelays: [],
    readBackend: ({ signal }) => {
      const index = readCount;
      readCount += 1;
      signals.push(signal);
      started[index].resolve();
      return index === 0 ? firstBackend.promise : secondBackend.promise;
    },
  });

  const oldRun = verifier.verifyBackendNow({ chatKey: "chat-a" });
  await started[0].promise;
  const newRun = verifier.verifyBackendNow({ chatKey: "chat-a" });
  await started[1].promise;
  assert.equal(signals[0].aborted, true);

  secondBackend.resolve({ ok: true, chat: [{ mes: "后端旧内容" }] });
  const newStatus = await newRun;
  firstBackend.resolve({ ok: true, chat: [{ mes: "当前内容" }] });
  const oldStatus = await oldRun;

  assert.equal(newStatus.code, "unconfirmed");
  assert.equal(oldStatus.code, "unconfirmed");
  assert.deepEqual(deleted, []);
  assert.deepEqual(metaWrites, ["unconfirmed"]);
  assert.equal(statuses.at(-1), "unconfirmed");
});

test("检查保存状态从重试上限开始，因此弱网失败也只读取一次", async () => {
  const pending = [createMessageRecord({
    chatKey: "chat-a",
    messageIndex: 0,
    kind: "message_edit",
    message: { mes: "当前内容" },
  })];
  let reads = 0;
  const verifier = createBackendVerifier({
    getContextReader: () => ({
      readCurrentChat: () => ({
        ok: true,
        chat: [{ mes: "当前内容" }],
        identity: { chatKey: "chat-a" },
      }),
    }),
    getSettings: () => ({ enabled: true }),
    getLatestStatus: () => null,
    setStatus: () => {},
    refreshVisiblePanel: async () => {},
    prioritizeFullBackupStatus: async (_chatKey, status) => status,
    readCurrentPending: async () => pending,
    updateBackendMeta: async () => {},
    createDisplayStatus: (code) => ({ code }),
    readBackend: async () => {
      reads += 1;
      return { ok: false, reason: "弱网" };
    },
    retryDelays: [1, 1, 1],
  });

  const status = await verifier.verifyBackendNow({
    chatKey: "chat-a",
    retryIndex: verifier.retryLimit,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(status.code, "verify-unavailable");
  assert.equal(reads, 1);
});

test("恢复渲染按替换、追加、刷新候选回复的顺序执行", async () => {
  const calls = [];
  const chat = [
    { mes: "替换内容" },
    { mes: "追加内容" },
  ];

  await renderRestoredMessages({
    current: {
      chat,
      context: {
        updateMessageBlock(index, message) {
          calls.push(["replace", index, message.mes]);
        },
        addOneMessage(message, options) {
          calls.push(["append", options.forceId, message.mes, options.scroll, options.showSwipes]);
        },
        swipe: {
          refresh(...args) {
            calls.push(["swipe", ...args]);
          },
        },
      },
    },
    plan: {
      replacements: [{ messageIndex: 0 }],
      appends: [{ messageIndex: 1 }],
    },
  });

  assert.deepEqual(calls, [
    ["replace", 0, "替换内容"],
    ["append", 1, "追加内容", false, false],
    ["swipe", true, false],
  ]);
});

test("恢复渲染缺少酒馆公开接口时拒绝继续", async () => {
  await assert.rejects(
    renderRestoredMessages({
      current: { chat: [{ mes: "内容" }], context: {} },
      plan: { replacements: [{ messageIndex: 0 }], appends: [] },
    }),
    /无法重新渲染已有楼层/,
  );
});

test("完整聊天恢复通过酒馆公开接口清空并完整重绘", async () => {
  const calls = [];
  await renderRestoredMessages({
    current: {
      chat: [{ mes: "完整第 0 层" }],
      context: {
        async clearChat() { calls.push("clear"); },
        async printMessages() { calls.push("print"); },
      },
    },
    plan: { source: "full", replacements: [], appends: [], deletions: [{ messageIndex: 1 }] },
  });

  assert.deepEqual(calls, ["clear", "print"]);
});

test("面板控制器切换设置面板并同步按钮文字", () => {
  const originalDocument = globalThis.document;
  const label = { textContent: "查看当前聊天备份" };
  const button = {
    querySelector(selector) {
      return selector === "[data-boxed-lllllabc-button-label]" ? label : null;
    },
  };
  const panelBody = {
    removed: [],
    removeAttribute(name) {
      this.removed.push(name);
    },
  };
  const panel = { hidden: true };
  const elements = new Map([
    ["#boxed-lllllabc-settings-panel", panel],
    ["#boxed-lllllabc-settings-panel-body", panelBody],
    ["#boxed-lllllabc-toggle-panel", button],
  ]);
  globalThis.document = {
    querySelector(selector) {
      return elements.get(selector) ?? null;
    },
  };

  try {
    const controller = createPanelController({
      getContextReader: () => null,
      getSettings: () => ({}),
      getLatestStatus: () => ({ code: "idle" }),
      setStatus: () => {},
      readCurrentPending: async () => [],
      createDisplayStatus: () => ({}),
      createRestoreUiState: () => ({}),
      verifyBackendNow: async () => {},
      verifyBackendSnapshotNow: async () => {},
      verificationRetryLimit: 3,
    });

    controller.setPanelOpenState("settings", true);
    assert.equal(panel.hidden, false);
    assert.equal(label.textContent, "收起");

    controller.setPanelOpenState("settings", false);
    assert.equal(panel.hidden, true);
    assert.equal(label.textContent, "查看当前聊天备份");
    assert.deepEqual(panelBody.removed, ["data-recent-expanded"]);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("当前聊天面板复用全局索引模型生成安全清理目标", () => {
  const chatKey = "character:tester.png:chat-a";
  const cleanupChat = buildCurrentCleanupChat({
    meta: {
      chatKey,
      chatType: "character",
      characterName: "测试角色",
      characterAvatar: "tester.png",
      chatId: "测试聊天",
    },
    messages: [{ chatKey, messageIndex: 3, backedUpAt: "2026-07-12T00:00:00.000Z" }],
    pending: [{ id: `${chatKey}:3`, chatKey, messageIndex: 3, updatedAt: "2026-07-12T00:01:00.000Z" }],
  });

  assert.equal(cleanupChat.displayName, "测试聊天");
  assert.equal(cleanupChat.recordCount, 2);
  assert.equal(cleanupChat.recent.count, 1);
  assert.equal(cleanupChat.pending.count, 1);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
