import { extension_settings, getContext } from "../../../extensions.js";
import { eventSource, event_types, getRequestHeaders, saveSettingsDebounced } from "../../../../script.js";
import * as Tavern from "../../../../script.js";

import { createBackendVerifier } from "./src/controllers/backend-verifier.js";
import { createBackupCoordinator } from "./src/controllers/backup-coordinator.js";
import { createCatalogController } from "./src/controllers/catalog-controller.js";
import { createPanelController } from "./src/controllers/panel-controller.js";
import { createRestoreController } from "./src/controllers/restore-controller.js";
import { createSettingsController } from "./src/controllers/settings-controller.js";
import { createStorageController } from "./src/controllers/storage-controller.js";
import { createUpdateController } from "./src/controllers/update-controller.js";
import { createContextReader } from "./src/context.js";
import { registerBackupEvents } from "./src/events.js";
import { registerPageLifecycle } from "./src/lifecycle.js";
import { createPageReloadScheduler } from "./src/reload.js";
import { createBackupStatus } from "./src/backup/recent.js";
import { createSettingsAccessor } from "./src/settings.js";
import { createIndexedDbStorage } from "./src/storage/indexeddb-adapter.js";
import { createSqliteStorage } from "./src/storage/sqlite-client.js";
import { createStorageControl } from "./src/storage/control.js";
import { createManagedStorage, createOperationGate } from "./src/storage/managed.js";
import { createTransferCoordinator } from "./src/storage/transfer.js";
import { sha256 } from "./src/storage/transfer-format.js";
import { createStorageSwitchUi } from "./src/ui/storage-switch.js";
import { createSnapshotController } from "./src/controllers/snapshot-controller.js";
import { createSnapshotUi } from "./src/ui/snapshots.js";
import { ensureStatusLine, updateStatusLine } from "./src/ui/status-line.js";
import {
  bindUpdateAction,
  confirmExtensionUpdate,
  loadAndRenderExtensionInfo,
  renderUpdateState,
} from "./src/ui/extension-info.js";
import { openStorageWarningDialog, renderSettingsStorage } from "./src/ui/storage-status.js";

const extensionName = "boxed-lllllabc";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

const storageControl = createStorageControl();
const adapters = { indexeddb: createIndexedDbStorage(), sqlite: createSqliteStorage({ getRequestHeaders }) };
const backupStorage = createManagedStorage({ control: storageControl, adapters });
const operationGate = createOperationGate();
let switchUi;
let snapshotController;
let snapshotUi;
let migrationContext;
function isGenerating() {
  if (typeof Tavern.isGenerating === "function") return Tavern.isGenerating();
  const stop = document.querySelector("#mes_stop");
  return Boolean(Tavern.is_send_press || stop && getComputedStyle(stop).display !== "none");
}
async function contextFingerprint() {
  const context = getContext();
  return sha256(JSON.stringify([context.characterId, context.groupId, context.chatId, context.chatMetadata, context.chat]));
}
const transferCoordinator = createTransferCoordinator({
  control: storageControl, adapters,
  pause: async () => {
    if (isGenerating()) throw new Error("请先停止生成，再切换或清空存储。");
    switchUi?.block();
    backendVerifier?.clearScheduledVerification();
    await backupEvents?.pause();
    backendVerifier?.clearScheduledVerification();
    await operationGate.pause();
    backendVerifier?.clearScheduledVerification();
    await backendVerifier?.whenIdle();
    if (isGenerating()) throw new Error("检测到生成已开始，未执行切换。");
    migrationContext = await contextFingerprint();
  },
  validate: async () => {
    if (isGenerating() || migrationContext !== await contextFingerprint()) throw new Error("当前聊天或生成状态发生变化，已停止提交并保留两端原数据。");
  },
  resume: async () => {
    await backupStorage.refresh();
    operationGate.resume(); backupEvents?.resume(); switchUi?.close();
  },
  progress: (message) => switchUi?.progress(message),
});
const verifyRetryDelays = [2000, 5000, 10000];
const getSettings = createSettingsAccessor({ extensionSettings: extension_settings, extensionName });

let contextReader;
let backupCoordinator;
let backendVerifier;
let catalogController;
let restoreController;
let panelController;
let backupEvents = null;
let pageLifecycle = null;
let settingsController = null;
let storageController = null;
let updateController = null;
let updateCheckTimer = null;
let latestStatus = createBackupStatus("idle", "未初始化");
const pageReloadScheduler = createPageReloadScheduler({
  beforeReload: async () => {
    backendVerifier?.clearScheduledVerification();
    await backupEvents?.flush?.();
  },
});

function setStatus(status) {
  latestStatus = status;
  $("#boxed-lllllabc-settings-state").text(status.shortText);
  updateStatusLine(status);
}

function initializeControllers() {
  const getContextReader = () => contextReader;
  const getLatestStatus = () => latestStatus;
  const refreshVisiblePanel = async () => {
    await panelController?.refreshVisiblePanel();
  };

  backupCoordinator = createBackupCoordinator({
    storage: backupStorage,
    getContextReader,
    getSettings,
    getLatestStatus,
    setStatus,
    refreshVisiblePanel,
    clearScheduledVerification: () => backendVerifier?.clearScheduledVerification(),
    verifyBackendNow: (options) => backendVerifier.verifyBackendNow(options),
    verifyBackendSnapshotNow: (options) => backendVerifier.verifyBackendSnapshotNow(options),
    scheduleBackendVerification: (...args) => backendVerifier.scheduleBackendVerification(...args),
    scheduleBackendSnapshotVerification: (...args) => backendVerifier.scheduleBackendSnapshotVerification(...args),
    verificationRetryLimit: verifyRetryDelays.length,
    eventTypes: event_types,
  });

  backendVerifier = createBackendVerifier({
    storage: backupStorage,
    getContextReader,
    getSettings,
    getLatestStatus,
    setStatus,
    refreshVisiblePanel,
    prioritizeFullBackupStatus: (...args) => backupCoordinator.prioritizeFullBackupStatus(...args),
    readCurrentPending: (...args) => backupCoordinator.readCurrentPending(...args),
    updateBackendMeta: (...args) => backupCoordinator.updateBackendMeta(...args),
    createDisplayStatus: (...args) => backupCoordinator.createDisplayStatus(...args),
    confirmFullBackup: (...args) => backupCoordinator.confirmFullBackupAfterBackendVerification(...args),
    needsFullBackupConfirmation: (...args) => backupCoordinator.needsFullBackupConfirmation(...args),
    retryDelays: verifyRetryDelays,
  });

  restoreController = createRestoreController({
    runGuard: operationGate.run,
    storage: backupStorage,
    getContextReader,
    getSettings,
    eventTypes: event_types,
    readCurrentPending: (...args) => backupCoordinator.readCurrentPending(...args),
    setStatus,
    createDisplayStatus: (...args) => backupCoordinator.createDisplayStatus(...args),
    scheduleBackendVerification: (...args) => backendVerifier.scheduleBackendVerification(...args),
    scheduleBackendSnapshotVerification: (...args) => backendVerifier.scheduleBackendSnapshotVerification(...args),
    refreshVisiblePanel,
    refreshFullBackup: (...args) => backupCoordinator.refreshFullBackup(...args),
    refreshHistoricalBackup: (...args) => backupCoordinator.refreshHistoricalBackup(...args),
  });

  panelController = createPanelController({
    onCreateSnapshot: () => snapshotUi?.create(),
    runGuard: operationGate.run,
    storage: backupStorage,
    getContextReader,
    getSettings,
    getLatestStatus,
    setStatus,
    readCurrentPending: (...args) => backupCoordinator.readCurrentPending(...args),
    createDisplayStatus: (...args) => backupCoordinator.createDisplayStatus(...args),
    createRestoreUiState: (...args) => restoreController.createRestoreUiState(...args),
    verifyBackendNow: (...args) => backendVerifier.verifyBackendNow(...args),
    verifyBackendSnapshotNow: (...args) => backendVerifier.verifyBackendSnapshotNow(...args),
    verificationRetryLimit: backendVerifier.retryLimit,
    openBackupCleanup: (chat) => catalogController?.openCleanup(chat),
    getStorageSnapshot: () => storageController?.getSnapshot() ?? {},
    onBackupsChanged: () => storageController?.refresh(),
  });

  catalogController = createCatalogController({
    runGuard: operationGate.run,
    storage: backupStorage,
    refreshVisiblePanel,
    onCatalogChanged: () => storageController?.refresh(),
  });

  snapshotController = createSnapshotController({
    storage: backupStorage, getContextReader, runGuard: operationGate.run, isGenerating,
    beforeRestore: async () => {
      await backupEvents?.pause(); backendVerifier?.clearScheduledVerification(); await backendVerifier?.whenIdle();
    },
    afterRestore: async () => {
      backupEvents?.resume();
      await runBackupNow({ eventName: "snapshot-restored", args: [], verifyNow: true });
    },
  });

  storageController = createStorageController({
    storage: backupStorage,
    renderOverview: renderSettingsStorage,
    showWarning: openStorageWarningDialog,
    openCatalog: () => catalogController?.openCatalog(),
  });
}

async function runBackupNow(...args) {
  if (operationGate.isPaused()) return latestStatus;
  const status = await operationGate.run(() => backupCoordinator.runBackupNow(...args));
  storageController?.handleBackupStatus(status);
  return status;
}

function exposeDebugApi() {
  globalThis.boxedLllllabcDebug = {
    getStatus() {
      return latestStatus;
    },
    getContextSummary() {
      if (!contextReader) {
        return {
          ok: false,
          reason: "扩展尚未初始化。",
        };
      }

      const current = contextReader.readCurrentChat();
      if (!current.ok) {
        return {
          ok: false,
          reason: current.reason,
          chatLength: Array.isArray(current.context?.chat) ? current.context.chat.length : 0,
          characterId: current.context?.characterId,
          groupId: current.context?.groupId,
          chatId: current.context?.chatId,
        };
      }

      return {
        ok: true,
        chatLength: current.chat.length,
        chatKey: current.identity.chatKey,
        meta: current.identity.meta,
      };
    },
    refreshNow: () => runBackupNow({
      eventName: "debug-refresh",
      args: [],
      verifyNow: true,
    }),
  };
}

function ensureMagicWandEntry() {
  const entryId = "boxed-lllllabc-wand-entry";
  const addEntry = () => {
    const menu = document.querySelector("#extensionsMenu");
    if (!menu) {
      return false;
    }

    if (document.getElementById(entryId)) {
      return true;
    }

    const container = document.createElement("div");
    container.id = "boxed-lllllabc-wand-container";
    container.className = "extension_container";

    const button = document.createElement("div");
    button.id = entryId;
    button.className = "list-group-item flex-container flexGap5 interactable";
    button.setAttribute("role", "listitem");
    button.tabIndex = 0;

    const icon = document.createElement("div");
    icon.className = "fa-fw fa-solid fa-box-archive extensionsMenuExtensionButton";

    const label = document.createElement("span");
    label.textContent = "箱装辣白菜";

    button.append(icon, label);
    button.addEventListener("click", async () => {
      $("#extensionsMenu").hide();
      await panelController.openCurrentChatPanel();
    });

    container.append(button);
    menu.append(container);
    $("#extensionsMenuButton").css("display", "flex");
    return true;
  };

  if (!addEntry()) {
    setTimeout(addEntry, 1000);
  }
}

jQuery(async () => {
  contextReader = createContextReader({ getContext });
  initializeControllers();
  exposeDebugApi();

  settingsController = createSettingsController({
    extensionFolderPath,
    getSettings,
    saveSettings: saveSettingsDebounced,
    runBackupNow,
    getPanelController: () => panelController,
    getCatalogController: () => catalogController,
    refreshStorageOverview: () => storageController?.refresh(),
  });
  await settingsController.load();
  settingsController.sync();
  settingsController.bind();
  snapshotUi = createSnapshotUi({ controller: snapshotController, onChanged: async () => { await panelController?.refreshVisiblePanel(); await storageController?.refresh(); } });
  snapshotUi.bind();
  await loadAndRenderExtensionInfo({ manifestUrl: `${extensionFolderPath}/manifest.json` });
  updateController = createUpdateController({
    extensionName,
    getRequestHeaders,
    renderUpdateState,
    confirmUpdate: confirmExtensionUpdate,
    scheduleReload: () => pageReloadScheduler.schedule("extension-update"),
  });
  bindUpdateAction(() => updateController.requestUpdate());
  updateCheckTimer = setTimeout(() => updateController.checkOnce(), 3000);
  ensureStatusLine({
    onOpenPanel: () => panelController.toggleCurrentChatPanel(),
    getDisplayMode: () => getSettings().statusDisplayMode,
    getMessageCentered: () => getSettings().statusMessageCentered,
  });
  ensureMagicWandEntry();

  backupEvents = registerBackupEvents({
    eventSource,
    eventTypes: event_types,
    onChatRenamed: async (trigger) => {
      await operationGate.run(() => backupCoordinator.handleChatRenamed(trigger.args));
    },
    onBackupNeeded: async (trigger) => {
      await runBackupNow(trigger);
      await panelController.refreshVisiblePanel();
    },
  });
  pageLifecycle = registerPageLifecycle({
    flushBackupEvents: () => backupEvents?.flush(),
    onResume: async () => {
      backendVerifier?.clearScheduledVerification();
      await runBackupNow({
        eventName: "lifecycle-resume",
        args: [],
      });
    },
  });

  switchUi = createStorageSwitchUi({
    control: storageControl, sqlite: adapters.sqlite, coordinator: transferCoordinator, isGenerating,
    afterChange: async () => { await backupStorage.refresh(); await panelController.refreshVisiblePanel(); await storageController.refresh(); },
  });
  switchUi.bind();
  try {
    await backupStorage.refresh();
    await transferCoordinator.recover();
    await switchUi.refresh();
  } catch (error) {
    await operationGate.pause();
    await switchUi.failure(error);
    setStatus(createBackupStatus("db-error", "存储操作待恢复"));
    return;
  }
  setStatus(await runBackupNow({ eventName: "extension-loaded", args: [] }));
  await storageController.refresh({ notify: true });
});

export function disable() {
  if (updateCheckTimer) clearTimeout(updateCheckTimer);
  pageReloadScheduler.cancel();
  pageLifecycle?.unregister();
  backupEvents?.unregister();
  backendVerifier?.clearScheduledVerification();
}

export function onExtensionInstall() {
  pageReloadScheduler.schedule("extension-install");
}

export function onExtensionUpdate() {
  pageReloadScheduler.schedule("extension-update-hook");
}
