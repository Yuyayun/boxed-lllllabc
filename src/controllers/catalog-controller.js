import { buildBackupCatalog } from "../backup/catalog.js";
import { createBackupCleanupPlans, validateBackupCleanupPlan } from "../backup/cleanup.js";
import { createBatchCleanupPlan } from "../backup/batch-cleanup.js";
import { defaultBackupStorage } from "../storage/service.js";
import {
  openBackupCatalogDialog,
  renderBackupCatalogDialog,
} from "../ui/backup-catalog-dialog.js";
import { openBackupCleanupDialog } from "../ui/backup-cleanup-dialog.js";

export function createCatalogController({
  storage = defaultBackupStorage,
  runGuard = (operation) => operation(),
  buildCatalog = buildBackupCatalog,
  openDialog = openBackupCatalogDialog,
  renderDialog = renderBackupCatalogDialog,
  openCleanupDialog = openBackupCleanupDialog,
  refreshVisiblePanel = async () => {},
  onCatalogChanged = async () => {},
  waitForDialogPaint = waitForNextPaint,
} = {}) {
  async function refreshCatalog() {
    renderDialog({ loading: true });
    let session;
    try {
      session = await storage.open();
      const data = await session.getBackupCatalogData();
      const catalog = buildCatalog(data);
      renderDialog({ catalog });
      return { ok: true, catalog };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      renderDialog({ error: reason });
      return { ok: false, reason };
    } finally {
      session?.close?.();
    }
  }

  async function openCatalog() {
    openDialog({ onRefresh: refreshCatalog, onOpenCleanup: openCleanup,
      onPreviewBatch: previewBatch, onExecuteBatch: executeBatch });
    await waitForDialogPaint();
    return refreshCatalog();
  }

  function openCleanup(chat) {
    const plans = createBackupCleanupPlans(chat);
    openCleanupDialog({
      chat,
      plans,
      onConfirm: finishCleanup,
    });
    return plans;
  }

  async function executeCleanup(plan) {
    let session;
    try {
      session = await storage.open();
      const data = await session.getBackupCatalogData();
      const catalog = buildCatalog(data);
      const currentChat = catalog.chats.find((chat) => chat.chatKey === plan?.chatKey);
      const validation = validateBackupCleanupPlan({ plan, chat: currentChat });
      if (!validation.ok) {
        return validation;
      }
      const result = await session.deleteBackupTypeForChat({
        chatKey: plan.chatKey,
        type: plan.type,
        expectedFingerprint: plan.expectedFingerprint,
      });
      return { ok: true, reason: "", ...result };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      session?.close?.();
    }
  }

  const finishCleanup = (plan) => runGuard(() => finishCleanupImpl(plan)).catch((error) => ({ ok: false, reason: error.message }));
  async function finishCleanupImpl(plan) {
    const result = await executeCleanup(plan);
    if (!result.ok) return result;
    await refreshCatalog();
    await refreshVisiblePanel();
    await onCatalogChanged();
    return result;
  }

  async function previewBatch(selection) {
    return runGuard(async () => {
      let session;
      try {
        session = await storage.open();
        return createBatchCleanupPlan({ catalog: buildCatalog(await session.getBackupCatalogData()),
          selection, mode: storage.getMode() });
      } finally { session?.close?.(); }
    });
  }

  async function executeBatch(plan, { confirmed = false } = {}) {
    let submitted = false, mode;
    try {
      const result = await runGuard(async () => {
        let session;
        try {
          if (confirmed !== true) throw new Error("批量清理必须先预览并明确确认。");
          session = await storage.open();
          mode = storage.getMode();
          if (mode !== plan?.mode) throw Object.assign(new Error("活动存储已变化，请重新预览。"), { code: "stale-cleanup-plan" });
          submitted = true;
          // The port rechecks the whole scope inside the deletion transaction.
          return await session.deleteBackupBatch({ plan, confirmed: true });
        } finally { session?.close?.(); }
      });
      // A committed deletion remains successful even if a subsequent UI refresh fails.
      const refreshes = await Promise.allSettled([refreshCatalog, refreshVisiblePanel, onCatalogChanged]
        .map(refresh => Promise.resolve().then(refresh)));
      return { ...result, refreshWarning: refreshes.some(item => item.status === "rejected"
        || item.value?.ok === false) ? "删除已提交，但部分显示刷新失败，请手动刷新。" : "" };
    } catch (error) {
      const unknown = submitted && mode === "sqlite" && (!error.code || error.code === "outcome-unknown");
      return { ok: false, committed: unknown ? null : false, unknown, stale: error.code === "stale-cleanup-plan",
        succeeded: unknown ? null : 0, skipped: 0, failed: unknown ? null : plan?.actions?.length ?? 0,
        reason: unknown ? "服务器执行结果未确认。请刷新并核对备份后重新预览，不要直接重试旧计划。"
          : error instanceof Error ? error.message : String(error), items: [] };
    }
  }

  return {
    executeCleanup: finishCleanup,
    previewBatch,
    executeBatch,
    openCatalog,
    openCleanup,
    refreshCatalog,
  };
}

export function waitForNextPaint() {
  if (typeof globalThis.requestAnimationFrame !== "function") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    globalThis.requestAnimationFrame(() => globalThis.setTimeout(resolve, 0));
  });
}
