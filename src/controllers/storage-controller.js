import { buildBackupCatalog } from "../backup/catalog.js";
import { defaultBackupStorage } from "../storage/service.js";
import { describeStorageFailure } from "../storage/health.js";
import { createStorageSnapshot, estimateOriginStorage } from "../storage/quota.js";

const WARNING_SESSION_KEY = "boxed-lllllabc:storage-warning-shown";

export function createStorageController({
  storage = defaultBackupStorage,
  renderOverview,
  showWarning,
  openCatalog,
  buildCatalog = buildBackupCatalog,
  estimateStorage = estimateOriginStorage,
  sessionStore = globalThis.sessionStorage,
}) {
  let latestSnapshot = createStorageSnapshot();

  async function refresh({ notify = false } = {}) {
    let session;
    try {
      await storage.refresh?.();
      if (storage.getMode?.() === "sqlite") {
        const status = await storage.status();
        if (!status?.ok) throw new Error(status?.reason || "SQLite 状态不可用。");
        latestSnapshot = { ...createStorageSnapshot({ catalog: { storageBytes: status.database.counts.reduce((sum, row) => sum + row.bytes, 0) } }), mode: "sqlite", databaseBytes: status.database.bytes };
        renderOverview?.(latestSnapshot);
        return latestSnapshot;
      }
      session = await storage.open();
      const data = await session.getBackupCatalogData();
      let snapshotBytes = 0, after = "";
      if (session.listSnapshots) do {
        const page = await session.listSnapshots({ after });
        snapshotBytes += page.items.reduce((sum, item) => sum + (Number(item.contentBytes) || 0), 0);
        after = page.after;
      } while (after);
      const [catalog, estimate] = await Promise.all([
        Promise.resolve(buildCatalog(data)),
        estimateStorage(),
      ]);
      latestSnapshot = createStorageSnapshot({ catalog: { ...catalog, storageBytes: (catalog.storageBytes || 0) + snapshotBytes }, estimate });
      renderOverview?.(latestSnapshot);
      if (notify) maybeWarn(latestSnapshot);
      return latestSnapshot;
    } catch (error) {
      latestSnapshot = createStorageSnapshot({
        failure: describeStorageFailure(error),
        estimate: storage.getMode?.() === "sqlite" ? {} : await estimateStorage(),
      });
      latestSnapshot.mode = storage.getMode?.();
      renderOverview?.(latestSnapshot);
      if (notify) maybeWarn(latestSnapshot);
      return latestSnapshot;
    } finally {
      session?.close?.();
    }
  }

  function handleBackupStatus(status) {
    if (status?.code !== "db-error") return;
    const failure = describeStorageFailure(status);
    latestSnapshot = { ...latestSnapshot, failure, pressure: "error", checkedAt: new Date().toISOString() };
    renderOverview?.(latestSnapshot);
    maybeWarn(latestSnapshot, true);
  }

  function maybeWarn(snapshot, force = false) {
    if (!force && !["warning", "critical", "error"].includes(snapshot?.pressure)) return;
    try {
      if (sessionStore?.getItem?.(WARNING_SESSION_KEY)) return;
      sessionStore?.setItem?.(WARNING_SESSION_KEY, "true");
    } catch {
      // 缓存不可用时仍显示一次当前警告。
    }
    showWarning?.({ snapshot, onManage: () => openCatalog?.() });
  }

  return {
    getSnapshot: () => latestSnapshot,
    handleBackupStatus,
    refresh,
  };
}
