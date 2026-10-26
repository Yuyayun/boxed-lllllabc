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
      const mode = storage.getMode?.() ?? "indexeddb";
      if (latestSnapshot.mode !== mode) {
        latestSnapshot = { mode, loading: true, pressure: "unavailable" };
        renderOverview?.(latestSnapshot);
      }
      if (storage.getMode?.() === "sqlite") {
        const status = await storage.status();
        if (!status?.ok) throw new Error(status?.reason || "SQLite 状态不可用。");
        const database = status.database ?? {};
        const contentBytes = Array.isArray(database.counts) && database.counts.every(row => Number.isFinite(row.bytes) && row.bytes >= 0)
          ? database.counts.reduce((sum, row) => sum + row.bytes, 0) : null;
        latestSnapshot = { ...createStorageSnapshot(), mode: "sqlite", extensionBytes: contentBytes,
          databaseBytes: database.bytes, availableBytes: database.availableBytes,
          readable: database.readable, writable: database.writable };
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
      latestSnapshot.mode = "indexeddb";
      renderOverview?.(latestSnapshot);
      if (notify) maybeWarn(latestSnapshot);
      return latestSnapshot;
    } catch (error) {
      const sqlite = storage.getMode?.() === "sqlite";
      latestSnapshot = createStorageSnapshot({
        failure: sqlite ? { type: "database", shortText: "SQLite 存储不可用", detail: error.message || "请检查可选服务器插件的连接与权限；没有回退到 IndexedDB。" } : describeStorageFailure(error),
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
    const failure = storage.getMode?.() === "sqlite"
      ? { type: "database", shortText: "SQLite 存储操作失败", detail: status.detail || "本次 SQLite 操作失败，请检查服务器连接与权限。" }
      : describeStorageFailure(status);
    latestSnapshot = { ...latestSnapshot, mode: storage.getMode?.(), failure, pressure: "error", checkedAt: new Date().toISOString() };
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
