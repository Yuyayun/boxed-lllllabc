import { createBackupStorage } from "/scripts/extensions/third-party/boxed-lllllabc/src/storage/service.js";
import { DB_NAME, DB_VERSION, STORES } from "/scripts/extensions/third-party/boxed-lllllabc/src/db/schema.js";
import { canonicalizeMessage } from "/scripts/extensions/third-party/boxed-lllllabc/src/backup/canonicalize.js";
import { createMessageRecord } from "/scripts/extensions/third-party/boxed-lllllabc/src/backup/pending.js";
import { fingerprintBackupRecords } from "/scripts/extensions/third-party/boxed-lllllabc/src/backup/cleanup.js";
import { buildChatRenameIdentity } from "/scripts/extensions/third-party/boxed-lllllabc/src/identity.js";
import { createBackupCoordinator } from "/scripts/extensions/third-party/boxed-lllllabc/src/controllers/backup-coordinator.js";
import { createBackendVerifier } from "/scripts/extensions/third-party/boxed-lllllabc/src/controllers/backend-verifier.js";

const storage = createBackupStorage();
const legacyKey = "character:boxed-p1.png:legacy";
const checks = [];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (actual, expected, message) => assert(JSON.stringify(actual) === JSON.stringify(expected), message);
const use = async (callback) => {
  const session = await storage.open();
  try { return await callback(session); } finally { session.close(); }
};
const rejects = async (callback, pattern) => {
  try { await callback(); } catch (error) {
    assert(pattern.test(`${error.name}: ${error.message}`), `非预期失败：${error}`);
    return;
  }
  throw new Error("操作本应被拒绝。");
};
const run = async (name, callback) => { await callback(); checks.push(name); };
const guard = () => assert(location.origin === "http://127.0.0.1:18000", "拒绝在非独立测试 origin 运行。");
const message = (text = "中文 <>&，候选乙") => ({
  name: "虚构角色", mes: text, is_user: false, swipes: ["候选甲", text], swipe_id: 1,
  send_date: new Date("2026-10-26T08:00:00.000Z"),
  extra: { nested: { nullable: null, optional: undefined, list: [1, "中文", null] } },
});
const identity = (marker) => ({
  ok: true, chatKey: `character:boxed-p1.png:${marker}`,
  meta: { chatType: "character", characterAvatar: "boxed-p1.png", chatId: marker, chatFile: marker, chatIntegrity: "shared-legacy-uuid" },
});

export async function seedAndTest() {
  guard();
  assert(!(await indexedDB.databases()).some((db) => db.name === DB_NAME), "要求全新浏览器资料，拒绝覆盖已有库。");
  await run("真实 v3 旧库升级至 v5，原元数据、recent 和 pending 保留", async () => {
    const request = indexedDB.open(DB_NAME, 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(STORES.chatMeta, { keyPath: "chatKey" });
      db.createObjectStore(STORES.recentMessages, { keyPath: ["chatKey", "messageIndex"] }).createIndex("by_chat", "chatKey");
      db.createObjectStore(STORES.pendingChanges, { keyPath: "id" }).createIndex("by_chat", "chatKey");
    };
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction([STORES.chatMeta, STORES.recentMessages, STORES.pendingChanges], "readwrite");
    transaction.objectStore(STORES.chatMeta).put({ ...identity("legacy").meta, chatKey: legacyKey, sentinel: "旧数据保留" });
    transaction.objectStore(STORES.recentMessages).put({ ...canonicalizeMessage(message(), 0), chatKey: legacyKey });
    transaction.objectStore(STORES.pendingChanges).put(createMessageRecord({ chatKey: legacyKey, messageIndex: 0, message: message(), kind: "message_edit" }));
    await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error); });
    db.close();
    await use(async (session) => {
      assert((await session.getChatMeta(legacyKey)).sentinel === "旧数据保留", "旧元数据丢失");
      assert((await session.getRecentMessages(legacyKey)).length === 1, "旧 recent 丢失");
      assert((await session.getPendingChanges(legacyKey)).length === 1, "旧 pending 丢失");
      equal(await session.getFullMessages(legacyKey), [], "新 full 仓库未建立");
      equal(await session.getHistoricalChanges(legacyKey), [], "新 historical 仓库未建立");
    });
    const versionRequest = indexedDB.open(DB_NAME);
    await new Promise((resolve, reject) => {
      versionRequest.onsuccess = () => { assert(versionRequest.result.version === DB_VERSION, "schema 版本错误"); versionRequest.result.close(); resolve(); };
      versionRequest.onerror = () => reject(versionRequest.error);
    });
  });
  const key = identity("roundtrip").chatKey;
  const records = [0, 1].map((index) => ({ ...canonicalizeMessage(message(`中文 ${index}`), index), chatKey: key }));
  await run("四类备份真实写入读回，保留 Date、swipe、null、undefined 与嵌套字段", () => use(async (session) => {
    await session.replaceRecentSnapshot({ meta: { chatKey: key }, messages: records });
    await session.replaceFullSnapshot({ chatKey: key, messages: records, meta: { chatKey: key, fullBackupState: "active" } });
    await session.putHistoricalChanges([{ ...records[0], firstCapturedAt: "2026-01-01T00:00:00Z" }]);
    await session.putPendingChanges([createMessageRecord({ chatKey: key, messageIndex: 1, message: message(), kind: "message_edit" })]);
    for (const actual of [await session.getRecentMessages(key), await session.getFullMessages(key)]) {
      equal(actual, records, "完整消息读回不一致");
      assert(actual[0].raw.send_date instanceof Date, "Date 未保留");
      assert("optional" in actual[0].raw.extra.nested, "undefined 字段被丢弃");
    }
    assert((await session.getHistoricalChanges(key)).length === 1, "历史记录丢失");
    assert((await session.getPendingChanges(key)).length === 1, "pending 丢失");
  }));
  await run("写入途中 DataCloneError 会回滚整笔事务，旧内容与元数据不变", () => use(async (session) => {
    const before = await session.getFullMessages(key);
    const meta = await session.getChatMeta(key);
    await rejects(() => session.putFullMessages({ chatKey: key, messages: [{ ...records[0], text: "不应提交" }, { ...records[1], bad: () => {} }], meta: { chatKey: key, changed: true } }), /DataCloneError/);
    equal(await session.getFullMessages(key), before, "事务中途失败后残留部分写入");
    equal(await session.getChatMeta(key), meta, "失败后元数据改变");
  }));
  await run("历史改动更新保留首次捕获时间", () => use(async (session) => {
    await session.putHistoricalChanges([{ ...records[0], text: "新的历史内容", firstCapturedAt: "2026-10-26T00:00:00Z" }]);
    const [record] = await session.getHistoricalChanges(key);
    assert(record.firstCapturedAt === "2026-01-01T00:00:00Z" && record.text === "新的历史内容", "历史更新语义变化");
  }));
  await run("pending 条件删除保留已改变内容及被取消任务的记录", () => use(async (session) => {
    const [old] = await session.getPendingChanges(key);
    const changed = { ...old, canonicalHash: "changed" };
    await session.putPendingChanges([changed]);
    equal(await session.deletePendingChangesIfUnchanged([old]), [], "旧响应删除了更新记录");
    equal(await session.deletePendingChangesIfUnchanged([changed], { shouldDelete: () => false }), [], "取消后仍删除");
    assert((await session.getPendingChanges(key)).length === 1, "受保护 pending 丢失");
    equal(await session.deletePendingChangesIfUnchanged([changed]), [changed.id], "当前响应不能正常核销");
  }));
  await run("清理拒绝过期预览、pending、冻结与等待确认完整备份", () => use(async (session) => {
    const previous = fingerprintBackupRecords(await session.getRecentMessages(key));
    await session.replaceRecentSnapshot({ meta: { chatKey: key }, messages: [...records, { ...records[1], messageIndex: 2 }] });
    await rejects(() => session.deleteBackupTypeForChat({ chatKey: key, type: "recent", expectedFingerprint: previous }), /变化/);
    assert((await session.getRecentMessages(key)).length === 3, "过期计划仍删除");
    await rejects(() => session.deleteBackupTypeForChat({ chatKey: key, type: "pending", expectedFingerprint: previous }), /无法识别/);
    const fullFingerprint = fingerprintBackupRecords(await session.getFullMessages(key));
    for (const state of ["frozen", "awaiting-confirmation"]) {
      await session.updateChatMetaSummary(key, { fullBackupState: state });
      await rejects(() => session.deleteBackupTypeForChat({ chatKey: key, type: "full", expectedFingerprint: fullFingerprint }), /冻结|等待后端确认/);
      assert((await session.getFullMessages(key)).length === 2, "受保护完整备份丢失");
    }
  }));
  await run("共享 UUID 的 Branch 保持新身份，显式 Rename 迁移四类记录", () => use(async (session) => {
    const branch = identity("legacy - Branch #1");
    assert((await session.reconcileChatIdentity(branch)).status === "new", "Branch 错误接续父聊天");
    equal(await session.getRecentMessages(branch.chatKey), [], "Branch 继承父备份");
    await session.putFullMessages({ chatKey: legacyKey, messages: [{ ...records[0], chatKey: legacyKey }], meta: { ...identity("legacy").meta, chatKey: legacyKey, sentinel: "旧数据保留" } });
    await session.putHistoricalChanges([{ ...records[0], chatKey: legacyKey }]);
    const rename = buildChatRenameIdentity({ avatarId: "boxed-p1.png", oldFileName: "legacy.jsonl", newFileName: "renamed.jsonl" });
    assert((await session.migrateRenamedChatIdentity(rename)).status === "migrate", "显式 Rename 未迁移");
    for (const method of ["getRecentMessages", "getFullMessages", "getHistoricalChanges", "getPendingChanges"]) {
      assert((await session[method](rename.identity.chatKey)).length === 1, `${method} Rename 丢失`);
      equal(await session[method](legacyKey), [], `${method} 留下旧键`);
    }
  }));
  const current = { ok: true, chat: [message("第零层"), message("第一层"), message("第二层")], identity: identity("coordinator") };
  const settings = { enabled: true, recentBackupEnabled: true, fullBackupEnabled: true, historicalBackupEnabled: true, recentLimit: 1, backendVerifyDelayMs: 2000 };
  let status = { code: "idle" };
  const coordinator = createBackupCoordinator({
    storage, getContextReader: () => ({ readCurrentChat: () => current }), getSettings: () => settings,
    getLatestStatus: () => status, setStatus: (value) => { status = value; },
    refreshVisiblePanel: async () => {}, clearScheduledVerification: () => {},
    scheduleBackendVerification: () => {}, scheduleBackendSnapshotVerification: () => {},
    readChatCatalog: async () => ({ ok: true, entries: [{ marker: "coordinator" }] }),
  });
  await run("协调器一次触发经统一存储写入四类备份", async () => {
    await coordinator.runBackupNow({ eventName: "message_edited", args: [0] });
    await use(async (session) => {
      const chatKey = current.identity.chatKey;
      assert((await session.getRecentMessages(chatKey)).length === 1, "recent 层数变化");
      assert((await session.getFullMessages(chatKey)).length === 3, "full 未写入");
      assert((await session.getHistoricalChanges(chatKey)).length === 1, "historical 未写入");
      assert((await session.getPendingChanges(chatKey)).length === 1, "pending 未写入");
    });
  });
  await run("保存核对成功通过活动存储核销 pending", async () => {
    const verifier = createBackendVerifier({
      storage, getContextReader: () => ({ readCurrentChat: () => current }), getSettings: () => settings,
      getLatestStatus: () => status, setStatus: (value) => { status = value; }, refreshVisiblePanel: async () => {},
      readCurrentPending: coordinator.readCurrentPending, updateBackendMeta: coordinator.updateBackendMeta,
      createDisplayStatus: coordinator.createDisplayStatus, prioritizeFullBackupStatus: coordinator.prioritizeFullBackupStatus,
      readBackend: async () => ({ ok: true, chat: current.chat }),
    });
    assert((await verifier.verifyBackendNow({ chatKey: current.identity.chatKey, retryIndex: verifier.retryLimit })).code === "saved", "保存核对状态错误");
    equal(await coordinator.readCurrentPending(current.identity.chatKey), [], "核对后 pending 未核销");
  });
  await run("异常缩短仍冻结完整备份且保留原三层", async () => {
    current.chat.splice(1);
    const result = await coordinator.refreshFullBackup({ current, settings, triggers: [{ eventName: "chat_id_changed", args: [] }], reason: "chat_id_changed" });
    assert(result.code === "full-frozen", "未进入冻结保护");
    await use(async (session) => {
      assert((await session.getFullMessages(current.identity.chatKey)).length === 3, "冻结内容被缩短覆盖");
      assert((await session.getChatMeta(current.identity.chatKey)).fullBackupState === "frozen", "冻结状态未持久化");
    });
  });
  return { checks, mode: storage.getMode(), version: DB_VERSION };
}

export async function verifyPersistence() {
  guard();
  return use(async (session) => {
    const renamedKey = identity("renamed").chatKey;
    assert((await session.getChatMeta(renamedKey)).sentinel === "旧数据保留", "重开浏览器后旧元数据丢失");
    const [record] = await session.getRecentMessages(renamedKey);
    assert(record.raw.send_date instanceof Date, "重开后 Date 丢失");
    assert((await session.getFullMessages(identity("coordinator").chatKey)).length === 3, "重开后完整备份丢失");
    assert((await session.getChatMeta(identity("coordinator").chatKey)).fullBackupState === "frozen", "重开后冻结状态丢失");
    return { passed: true, checks: ["关闭浏览器进程后重开，备份、Date 与冻结状态仍可读取"] };
  });
}
