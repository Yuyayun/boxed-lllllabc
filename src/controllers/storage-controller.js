import { buildBackupCatalog } from "../backup/catalog.js";
import { getBackupCatalogData, openBackupDatabase } from "../db/index.js";
import { describeStorageFailure } from "../storage/health.js";
import { createStorageSnapshot, estimateOriginStorage } from "../storage/quota.js";

const WARNING_SESSION_KEY = "boxed-lllllabc:storage-warning-shown";

export function createStorageController({
  renderOverview,
  showWarning,
  openCatalog,
  openDatabase = openBackupDatabase,
  readCatalogData = getBackupCatalogData,
  buildCatalog = buildBackupCatalog,
  estimateStorage = estimateOriginStorage,
  sessionStore = globalThis.sessionStorage,
}) {
  let latestSnapshot = createStorageSnapshot();

  async function refresh({ notify = false } = {}) {
    let db;
    try {
      db = await openDatabase();
      const data = await readCatalogData(db);
      const [catalog, estimate] = await Promise.all([
        Promise.resolve(buildCatalog(data)),
        estimateStorage(),
      ]);
      latestSnapshot = createStorageSnapshot({ catalog, estimate });
      renderOverview?.(latestSnapshot);
      if (notify) maybeWarn(latestSnapshot);
      return latestSnapshot;
    } catch (error) {
      latestSnapshot = createStorageSnapshot({
        failure: describeStorageFailure(error),
        estimate: await estimateStorage(),
      });
      renderOverview?.(latestSnapshot);
      if (notify) maybeWarn(latestSnapshot);
      return latestSnapshot;
    } finally {
      db?.close?.();
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
