import { createSqliteStorage } from "/scripts/extensions/third-party/boxed-lllllabc/src/storage/sqlite-client.js";
import { createBackupStorage, defaultBackupStorage } from "/scripts/extensions/third-party/boxed-lllllabc/src/storage/service.js";
import { canonicalizeMessage } from "/scripts/extensions/third-party/boxed-lllllabc/src/backup/canonicalize.js";
import { fingerprintBackupRecords } from "/scripts/extensions/third-party/boxed-lllllabc/src/backup/cleanup.js";
import { createMessageRecord } from "/scripts/extensions/third-party/boxed-lllllabc/src/backup/pending.js";

export async function runSqliteContract() {
  if (location.origin !== "http://127.0.0.1:18000") throw new Error("拒绝在非隔离环境执行。");
  const checks = [];
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const equal = (actual, expected) => assert(JSON.stringify(actual) === JSON.stringify(expected), "双端结果不一致。");
  const token = (await (await fetch("/csrf-token")).json()).token;
  const adapter = createSqliteStorage({ getRequestHeaders: () => ({ "X-CSRF-Token": token }) });
  assert((await adapter.status()).ok, "SQLite 不可用。");
  assert(defaultBackupStorage.getMode() === "indexeddb", "连接后端改变了默认模式。");
  checks.push("后端已连接，前端默认仍为 IndexedDB");
  const local = await createBackupStorage().open();
  const remote = await createBackupStorage({ adapter }).open();
  const chatKey = `character:boxed-p2.png:${crypto.randomUUID()}`;
  const messages = [0, 1].map((index) => ({ ...canonicalizeMessage({ mes: `虚构中文 ${index}`, name: "P2 测试", swipes: ["甲", "乙"], swipe_id: 1, send_date: new Date(0), extra: { optional: undefined, nullValue: null } }, index, "2026-10-26T00:00:00Z"), chatKey }));
  try {
    for (const session of [local, remote]) {
      await session.replaceRecentSnapshot({ meta: { chatKey, characterAvatar: "boxed-p2.png" }, messages });
      await session.replaceFullSnapshot({ chatKey, messages, meta: { chatKey, fullBackupState: "active" } });
      await session.putHistoricalChanges([{ ...messages[0], firstCapturedAt: "2026-01-01" }]);
      await session.putHistoricalChanges([{ ...messages[0], firstCapturedAt: "2026-02-01", text: "更新后的历史" }]);
      await session.putPendingChanges([createMessageRecord({ chatKey, messageIndex: 0, kind: "message_edit", message: messages[0].raw, now: "2026-10-26T00:00:00Z" })]);
    }
    for (const method of ["getRecentMessages", "getFullMessages", "getHistoricalChanges", "getPendingChanges"]) equal(await remote[method](chatKey), await local[method](chatKey));
    const [record] = await remote.getRecentMessages(chatKey);
    assert(record.raw.send_date instanceof Date && Object.hasOwn(record.raw.extra, "optional"), "HTTP 传输损失 Date/undefined。");
    checks.push("四类备份与历史更新时间经真实 HTTP/SQLite 和 IndexedDB 等价，特殊字段无损");
    const [pending] = await local.getPendingChanges(chatKey);
    for (const session of [local, remote]) {
      equal(await session.deletePendingChangesIfUnchanged([{ ...pending, canonicalHash: "outdated" }]), []);
      equal(await session.deletePendingChangesIfUnchanged([pending], { shouldDelete: () => false }), []);
      equal(await session.deletePendingChangesIfUnchanged([pending], { shouldDelete: () => true, signal: new AbortController().signal }), [pending.id]);
    }
    checks.push("pending 过期响应与取消任务保留，当前记录正常核销");
    for (const session of [local, remote]) {
      const before = await session.getFullMessages(chatKey);
      await session.updateChatMetaSummary(chatKey, { fullBackupState: "frozen", fullBackupIncident: { kind: "unexpected-shorter-chat" } });
      let rejected = false;
      try { await session.deleteBackupTypeForChat({ chatKey, type: "full", expectedFingerprint: fingerprintBackupRecords(before) }); }
      catch { rejected = true; }
      assert(rejected, "冻结记录被清理。");
      equal(await session.getFullMessages(chatKey), before);
      const result = await session.resolveFrozenFullBackup({ chatKey, action: "adopt-current", expectedFullFingerprint: fingerprintBackupRecords(before), expectedIncidentFingerprint: fingerprintBackupRecords([{ kind: "unexpected-shorter-chat" }]), messages: [messages[0]], identityMeta: { chatKey }, now: "2026-10-26T00:00:00Z" });
      assert(result.savedCount === 1, "冻结处理未完成。");
    }
    equal(await remote.getFullMessages(chatKey), await local.getFullMessages(chatKey));
    checks.push("冻结完整备份禁止清理，事务内确认处理的两端结果一致");
    for (const session of [local, remote]) {
      const records = await session.getRecentMessages(chatKey);
      await session.deleteBackupTypeForChat({ chatKey, type: "recent", expectedFingerprint: fingerprintBackupRecords(records) });
      equal(await session.getRecentMessages(chatKey), []);
    }
    checks.push("普通清理仅删除指定类型，跨端结果一致");
    assert(defaultBackupStorage.getMode() === "indexeddb", "测试后默认模式被改变。");
    return { checks, chatKey, activeDefault: defaultBackupStorage.getMode() };
  } finally { local.close(); remote.close(); }
}
