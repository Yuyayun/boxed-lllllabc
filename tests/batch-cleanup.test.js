import test from "node:test";
import assert from "node:assert/strict";
import { batchData } from "./browser/batch-fixture.js";
import { buildBackupCatalog } from "../src/backup/catalog.js";
import { createBatchCleanupPlan, validateBatchCleanupPlan } from "../src/backup/batch-cleanup.js";
import { createCatalogController } from "../src/controllers/catalog-controller.js";
import { createOperationGate } from "../src/storage/managed.js";

const data = batchData(), catalog = buildBackupCatalog(data);
const key = data.chatMeta[0].chatKey;
const compile = (selection = { range: "all" }, source = catalog) => createBatchCleanupPlan({ catalog: source, selection, mode: "indexeddb" });
test("批量四范围只产生既有清理规则允许的普通操作，统计保护跳过", () => {
  const all = compile();
  assert.equal(all.chatCount, 3); assert.equal(all.recordCount, 10); assert.equal(all.actions.length, 7);
  assert.equal(all.skipped.length, 5); assert.equal(all.protectedRecords, 5); assert.ok(all.storageBytes > 0);
  assert.equal(all.actions.some(item => item.type === "pending"), false);
  assert.equal(all.skipped.filter(item => item.type === "full").length, 2);
  assert.equal(compile({ range: "owner", ownerKey: "character:a.png" }).chatCount, 2);
  const owner = compile({ range: "owner-selected", ownerKey: "character:a.png", chatKeys: [key, key] });
  assert.equal(owner.chatCount, 1); assert.equal(owner.recordCount, 4);
  const cross = compile({ range: "cross-selected", chatKeys: [key, data.chatMeta[2].chatKey], types: ["recent"] });
  assert.equal(cross.recordCount, 4); assert.equal(cross.skipped.length, 2);
  assert.deepEqual(cross.actions.map(item => item.type), ["recent", "recent"]);
});
test("缺少范围、角色、勾选、非法类型和所属角色不匹配均拒绝", () => {
  for (const selection of [{}, { range: "all", types: [] }, { range: "all", types: ["snapshots"] },
    { range: "owner" }, { range: "cross-selected" }, { range: "cross-selected", chatKeys: ["absent"] },
    { range: "owner-selected", ownerKey: "group:7", chatKeys: [key] }]) assert.throws(() => compile(selection));
  assert.equal(compile({ range: "all", types: ["pending"] }).canConfirm, false);
  assert.equal(compile({ range: "all" }, { ...catalog, chats: [] }).canConfirm, false);
  assert.match(compile({ range: "all" }, { ...catalog, invalidRecordCount: 1 }).blockedReason, /异常/);
});
test("仅快照的聊天不会进入普通清理范围，异常记录阻止确认", () => {
  const onlySnapshot = buildBackupCatalog({ chatMeta: [{ chatKey: "snapshot-only" }] });
  assert.equal(compile(undefined, onlySnapshot).chatCount, 0);
});
for (const mutation of ["records", "pending", "frozen", "awaiting", "metadata", "owner", "added", "removed", "unfrozen"]) {
  test(`预览后 ${mutation} 变化拒绝全部旧计划`, () => {
    const changed = structuredClone(data), plan = compile();
    if (mutation === "records") changed.recentMessages[0].raw.mes = "changed";
    if (mutation === "pending") changed.pendingChanges[0].canonicalHash = "changed";
    if (mutation === "frozen") changed.chatMeta[0].fullBackupState = "frozen";
    if (mutation === "awaiting") changed.chatMeta[0].fullBackupState = "awaiting-confirmation";
    if (mutation === "metadata") changed.chatMeta[0].chatDisplayName = "重命名";
    if (mutation === "owner") changed.chatMeta[0].characterAvatar = "another.png";
    if (mutation === "added") changed.recentMessages.push({ ...changed.recentMessages[0], chatKey: "new-chat" });
    if (mutation === "removed") for (const type of ["recentMessages", "fullMessages", "historicalChanges", "pendingChanges"]) changed[type] = changed[type].filter(row => row.chatKey !== key);
    if (mutation === "unfrozen") changed.chatMeta[1].fullBackupState = "active";
    assert.throws(() => validateBatchCleanupPlan({ plan, catalog: buildBackupCatalog(changed), mode: "indexeddb" }), { code: "stale-cleanup-plan" });
  });
}
test("显式多选不因无关新聊天失效；模式变化、操作篡改和移走选中聊天则拒绝", () => {
  const plan = compile({ range: "cross-selected", chatKeys: [key] });
  const changed = structuredClone(data); changed.recentMessages.push({ ...changed.recentMessages[0], chatKey: "new-chat" });
  assert.equal(validateBatchCleanupPlan({ plan, catalog: buildBackupCatalog(changed), mode: "indexeddb" }).recordCount, 4);
  assert.throws(() => validateBatchCleanupPlan({ plan, catalog, mode: "sqlite" }), { code: "stale-cleanup-plan" });
  assert.throws(() => validateBatchCleanupPlan({ plan: { ...plan, actions: [] }, catalog, mode: "indexeddb" }), { code: "stale-cleanup-plan" });
});

function controllerFixture({ fail, mode = "indexeddb", refreshFail = false } = {}) {
  let currentMode = mode, closes = 0, calls = 0;
  const controller = createCatalogController({ storage: { getMode: () => currentMode, open: async () => ({ close: () => { closes++; },
    getBackupCatalogData: async () => data, deleteBackupBatch: async options => { calls++; if (fail) throw fail; assert.equal(options.confirmed, true);
      return { ok: true, committed: true, succeeded: 7, skipped: 5, failed: 0, deletedRecords: 10 }; } }) },
    renderDialog: () => {}, refreshVisiblePanel: () => { if (refreshFail) throw new Error("refresh failed"); } });
  return { controller, setMode: value => { currentMode = value; }, counts: () => ({ closes, calls }) };
}
test("控制器从活动端新读预览，未确认或模式改变不调用删除", async () => {
  const f = controllerFixture(), plan = await f.controller.previewBatch({ range: "all" });
  assert.equal(plan.recordCount, 10); assert.equal((await f.controller.executeBatch(plan)).ok, false);
  f.setMode("sqlite"); assert.equal((await f.controller.executeBatch(plan, { confirmed: true })).stale, true);
  assert.equal(f.counts().calls, 0); assert.equal(f.counts().closes, 2);
});
test("事务失败、过期计划与网络结果未知不会误报成功", async () => {
  for (const [fail, mode, unknown] of [[new Error("IDB quota"), "indexeddb", false],
    [Object.assign(new Error("stale"), { code: "stale-cleanup-plan" }), "sqlite", false],
    [new TypeError("Failed to fetch"), "sqlite", true], [Object.assign(new Error("timeout"), { code: "outcome-unknown" }), "sqlite", true]]) {
    const { controller } = controllerFixture({ fail, mode }); const plan = await controller.previewBatch({ range: "all" });
    const result = await controller.executeBatch(plan, { confirmed: true });
    assert.equal(result.ok, false); assert.equal(result.unknown, unknown); assert.equal(result.succeeded, unknown ? null : 0);
  }
});
test("已提交后的刷新异常保持删除结果；迁移暂停门不允许执行批量清理", async () => {
  const f = controllerFixture({ refreshFail: true }), plan = await f.controller.previewBatch({ range: "all" });
  const result = await f.controller.executeBatch(plan, { confirmed: true }); assert.equal(result.ok, true); assert.match(result.refreshWarning, /刷新失败/);
  const gate = createOperationGate(); await gate.pause();
  const locked = createCatalogController({ runGuard: gate.run, storage: { open: () => { throw new Error("不应打开"); } } });
  assert.equal((await locked.executeBatch(plan, { confirmed: true })).ok, false); await assert.rejects(locked.previewBatch({ range: "all" }), /锁定/);
});
