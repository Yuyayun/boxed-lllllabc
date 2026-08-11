import { extension_settings, getContext } from "../../../extensions.js";
import { eventSource, event_types, getRequestHeaders, saveSettingsDebounced } from "../../../../script.js";

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
    refreshVisiblePanel,
    onCatalogChanged: () => storageController?.refresh(),
  });

  storageController = createStorageController({
    renderOverview: renderSettingsStorage,
    showWarning: openStorageWarningDialog,
    openCatalog: () => catalogController?.openCatalog(),
  });
}

async function runBackupNow(...args) {
  const status = await backupCoordinator.runBackupNow(...args);
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
  });
  await settingsController.load();
  settingsController.sync();
  settingsController.bind();
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
      await backupCoordinator.handleChatRenamed(trigger.args);
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
