import { buildBackupCatalog } from "../backup/catalog.js";
import { createBackupCleanupPlans, validateBackupCleanupPlan } from "../backup/cleanup.js";
import { deleteBackupTypeForChat, getBackupCatalogData, openBackupDatabase } from "../db/index.js";
import {
  openBackupCatalogDialog,
  renderBackupCatalogDialog,
} from "../ui/backup-catalog-dialog.js";
import { openBackupCleanupDialog } from "../ui/backup-cleanup-dialog.js";

export function createCatalogController({
  openDatabase = openBackupDatabase,
  readCatalogData = getBackupCatalogData,
  buildCatalog = buildBackupCatalog,
  deleteBackupType = deleteBackupTypeForChat,
  openDialog = openBackupCatalogDialog,
  renderDialog = renderBackupCatalogDialog,
  openCleanupDialog = openBackupCleanupDialog,
  refreshVisiblePanel = async () => {},
  onCatalogChanged = async () => {},
  waitForDialogPaint = waitForNextPaint,
} = {}) {
  async function refreshCatalog() {
    renderDialog({ loading: true });
    let db;
    try {
      db = await openDatabase();
      const data = await readCatalogData(db);
      const catalog = buildCatalog(data);
      renderDialog({ catalog });
      return { ok: true, catalog };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      renderDialog({ error: reason });
      return { ok: false, reason };
    } finally {
      db?.close?.();
    }
  }

  async function openCatalog() {
    openDialog({ onRefresh: refreshCatalog, onOpenCleanup: openCleanup });
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
    let db;
    try {
      db = await openDatabase();
      const data = await readCatalogData(db);
      const catalog = buildCatalog(data);
      const currentChat = catalog.chats.find((chat) => chat.chatKey === plan?.chatKey);
      const validation = validateBackupCleanupPlan({ plan, chat: currentChat });
      if (!validation.ok) {
        return validation;
      }
      const result = await deleteBackupType(db, {
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
      db?.close?.();
    }
  }

  async function finishCleanup(plan) {
    const result = await executeCleanup(plan);
    if (!result.ok) return result;
    await refreshCatalog();
    await refreshVisiblePanel();
    await onCatalogChanged();
    return result;
  }

  return {
    executeCleanup: finishCleanup,
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
