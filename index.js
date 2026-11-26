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
import { saveNativeChatSnapshot } from './src/backup/native-save.js';
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
import { createStorageSwitchUi,legacyRecoveryProgressText } from "./src/ui/storage-switch.js";
import { createRuntimeLogUi } from "./src/ui/runtime-log.js";
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
import {createRecoveryLogRecorder} from './src/storage/recovery-log.js';
import { createLocalRecovery } from './src/storage/local-recovery.js';
import { createLocalRecoveryUi } from './src/ui/local-recovery.js';

const extensionName = "boxed-lllllabc";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

const storageControl = createStorageControl();
let runtimeLogUi;
let localRecoveryUi;
const adapters = { indexeddb: createIndexedDbStorage({onLegacyProgress:r=>switchUi?.progress(legacyRecoveryProgressText(r)), onFailure: ({error,critical}) => {
  localRecoveryUi?.showFault(error);
  if (critical) { backendVerifier?.clearScheduledVerification(); setStatus(createBackupStatus('db-error', '本地备份暂时暂停', error)); }
}}), sqlite: createSqliteStorage({ getRequestHeaders,onStatus:health=>runtimeLogUi?.connection(health),onLogStatus:health=>runtimeLogUi?.logStatus(health),onProgress:state=>switchUi?.monitor(state) }) };
const backupStorage = createManagedStorage({ control: storageControl, adapters });
const recoveryLog=createRecoveryLogRecorder({send:event=>adapters.sqlite.recordRecoveryEvent(event),getStorageMode:()=>backupStorage.getMode()});
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
  pause: async (operation) => {
    if (isGenerating()) throw new Error("请先停止生成，再切换或清空存储。");
    switchUi?.block(undefined,operation);
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
    backupCoordinator?.resetObservation();
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
let storageRecoveryPending = false;
let backupEvents = null;
let pageLifecycle = null;
let settingsController = null;
let storageController = null;
let updateController = null;
let updateCheckTimer = null;
let latestStatus = createBackupStatus("idle", "未初始化");
let restoreRunning=false;
async function runRestoreGuard(operation) {
  if(restoreRunning||operationGate.isPaused())throw new Error('另一项恢复或存储操作正在进行，请稍后再试。');
  if(isGenerating())throw new Error('请先停止生成，再执行恢复。');
  restoreRunning=true;
  let lease,paused=false,result;
  try {
    lease=await backupStorage.open();
    if(operationGate.isPaused())throw new Error('备份位置正在切换，请稍后再恢复。');
    await backupEvents?.pause();
    await operationGate.pause();paused=true;
    backendVerifier?.clearScheduledVerification();await backendVerifier?.whenIdle();
    if(isGenerating())throw new Error('检测到生成已开始，恢复尚未执行。');
    result=await operation();return result;
  } finally {
    if(paused)operationGate.resume();
    backupEvents?.resume();lease?.close();restoreRunning=false;
    if(result?.changed)try{await runBackupNow({eventName:'restore-complete',args:[],verifyNow:true});}catch(error){console.warn('[boxed-lllllabc] 恢复后的保存核对待重试',error);}
  }
}
const pageReloadScheduler = createPageReloadScheduler({
  beforeReload: async () => {
    backendVerifier?.clearScheduledVerification();
    await backupEvents?.flush?.();
  },
});

function setStatus(status) {
  if (status?.code === 'backup-read-failed') return;
  if (status?.code === 'saved' && backupStorage.getMode() === 'indexeddb' && adapters.indexeddb.getRecoveryState().writePaused) {
    const fault = adapters.indexeddb.getRecoveryState();
    status = createBackupStatus('db-error', fault.unknownWrites.length ? '备份结果待核对' : '本地备份暂时暂停', fault.error);
  }
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
    onStorageFailure: error => { if (!adapters.indexeddb.getRecoveryState().writePaused) adapters.indexeddb.markRecoveryFailure(error); },
    prepareBackup: async () => { backendVerifier?.clearScheduledVerification(); await backendVerifier?.whenIdle(); },
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
    isGenerating,
    preparePendingVerification: (...args) => backupCoordinator.preparePendingVerification(...args),
    recordRecovery:recoveryLog.record,
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
    ensurePendingBackups: (...args) => backupCoordinator.ensurePendingBackups(...args),
    onPendingBackupsConfirmed: (...args) => backupCoordinator.onPendingBackupsConfirmed(...args),
    hasBackupProblem: (...args) => backupCoordinator.hasBackupProblem(...args),
    needsFullBackupConfirmation: (...args) => backupCoordinator.needsFullBackupConfirmation(...args),
    retryDelays: verifyRetryDelays,
  });

  restoreController = createRestoreController({
    recordRecovery:recoveryLog.record,
    runGuard: runRestoreGuard,
    saveChatSnapshot:saveNativeChatSnapshot,
    getSourceEpoch:()=>backupCoordinator.getSourceEpoch(),
    onRestored:()=>backupCoordinator.resetObservation(),
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
    recordRecovery:recoveryLog.record,
    getSettings,
    restoreGuard:runRestoreGuard,
    saveChatSnapshot:saveNativeChatSnapshot,
    onApplied:()=>backupCoordinator.resetObservation(),
    storage: backupStorage, getContextReader, runGuard: operationGate.run, isGenerating,
    beforeRestore: async () => {
      await backupEvents?.pause(); backendVerifier?.clearScheduledVerification(); await backendVerifier?.whenIdle();
    },
    afterRestore: async () => {
      backupCoordinator.resetObservation();
    },
  });

  storageController = createStorageController({
    storage: backupStorage,
    renderOverview: renderSettingsStorage,
    showWarning: openStorageWarningDialog,
    openCatalog: () => catalogController?.openCatalog(),
    onLocalFailure: error => localRecoveryUi?.showFault(error),
  });
}

async function runBackupNow(...args) {
  if (operationGate.isPaused()) return latestStatus;
  if (backupStorage.getMode() === 'indexeddb' && adapters.indexeddb.getRecoveryState().writePaused) {
    const state = adapters.indexeddb.getRecoveryState();
    localRecoveryUi?.showFault(state.error);
    const status = createBackupStatus('db-error', state.unknownWrites.length ? '备份结果待核对' : '本地备份暂时暂停', state.error);
    setStatus(status); return status;
  }
  let status;
  try { status = await operationGate.run(() => backupCoordinator.runBackupNow(...args)); }
  catch (error) {
    if (backupStorage.getMode() !== 'indexeddb') throw error;
    if (!adapters.indexeddb.getRecoveryState().writePaused) adapters.indexeddb.markRecoveryFailure(error);
    localRecoveryUi?.showFault(error);
    status = createBackupStatus('db-error', '本地备份暂不可用', error); setStatus(status);
  }
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
    onOpenPanel: () => storageRecoveryPending?switchUi?.showRecovery():panelController.toggleCurrentChatPanel(),
    getDisplayMode: () => getSettings().statusDisplayMode,
    getMessageCentered: () => getSettings().statusMessageCentered,
  });
  ensureMagicWandEntry();

  backupEvents = registerBackupEvents({
    onObserved: () => {backupCoordinator.noteSourceChange();backendVerifier?.clearScheduledVerification();},
    captureTrigger: trigger=>backupCoordinator.captureTrigger(trigger),
    eventSource,
    eventTypes: event_types,
    onChatRenamed: async (trigger) => {
      await backupCoordinator.persistCapturedTriggers(trigger.precedingTriggers??[]);
      await operationGate.run(() => backupCoordinator.handleChatRenamed(trigger.args));
    },
    onBackupNeeded: async (trigger) => {
      await runBackupNow(trigger);
      await panelController.refreshVisiblePanel();
    },
  });
  backupCoordinator.resetObservation();
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

  runtimeLogUi=createRuntimeLogUi({storage:adapters.sqlite});
  switchUi = createStorageSwitchUi({
    onRecoveryPending:async(pending,error)=>{
      if(pending){
        storageRecoveryPending=true;backendVerifier?.clearScheduledVerification();
        await backupEvents?.pause();await operationGate.pause();
        setStatus(createBackupStatus('db-error','备份存储待恢复（备份暂停）',error));
      }else if(storageRecoveryPending&&!(await backupStorage.refresh()).journal){
        storageRecoveryPending=false;operationGate.resume();backupCoordinator.resetObservation();backupEvents?.resume();
      }
    },
    canReadLogs:()=>runtimeLogUi.available(),onLogs:()=>runtimeLogUi.open(),
    control: storageControl, sqlite: adapters.sqlite, coordinator: transferCoordinator, isGenerating,
    afterChange: async () => {
      const state=await backupStorage.refresh();if(state.journal)return;
      if (storageRecoveryPending) {
        operationGate.resume();backupCoordinator.resetObservation();backupEvents?.resume();
        setStatus(await runBackupNow({ eventName: "storage-recovery-complete", args: [] }));
        storageRecoveryPending = false;
      }
      await panelController.refreshVisiblePanel(); await storageController.refresh();
    },
  });
  switchUi.bind();
  const localRecovery = createLocalRecovery({
    control: storageControl, local: adapters.indexeddb,
    pause: async () => {
      if (isGenerating()) throw new Error('请先停止生成，再处理本地备份。');
      backendVerifier?.clearScheduledVerification();
      await backupEvents?.pause();
      await operationGate.pause('local-recovery');
      backendVerifier?.clearScheduledVerification(); await backendVerifier?.whenIdle();
    },
    resume: async () => {
      operationGate.resume('local-recovery');
      if (!operationGate.isPaused()) backupEvents?.resume();
    },
    onRebuilt: async () => {
      backupCoordinator.resetAfterLocalRebuild();
      // Detached old previews cannot submit their plans into the replacement DB.
      for (const node of document.querySelectorAll('.boxed-lllllabc-dialog')) node.remove();
      for (const target of ['settings', 'status', 'dialog']) panelController.setPanelOpenState(target, false);
    },
    onProgress: value => localRecoveryUi?.progress(value),
  });
  localRecoveryUi = createLocalRecoveryUi({ coordinator: localRecovery,
    getMode: () => backupStorage.getMode(),
    getChatKey: () => contextReader.readCurrentChat().identity?.chatKey,
    onRecovered: async () => {
      const state = await backupStorage.refresh();
      if (!state.journal && storageRecoveryPending) { storageRecoveryPending = false; operationGate.resume(); backupEvents?.resume(); switchUi?.close(); }
      setStatus(await runBackupNow({ eventName: 'local-backup-recovery', args: [] }));
      await storageController.refresh();
    },
  });
  localRecoveryUi.bind();
  if (adapters.indexeddb.getRecoveryState().writePaused) localRecoveryUi.showFault(adapters.indexeddb.getRecoveryState().error);
  try {
    await backupStorage.refresh();
    await transferCoordinator.recover();
    await switchUi.refresh();
  } catch (error) {
    localRecoveryUi.showFault(error);
    storageRecoveryPending = true;
    await operationGate.pause();
    await switchUi.failure(error);
    setStatus(createBackupStatus("db-error", "备份存储待恢复（备份暂停）",error));
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
