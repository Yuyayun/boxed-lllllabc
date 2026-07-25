import { createBackupStatus } from "../backup/recent.js";
import { canonicalizeMessage, hashCanonicalChat } from "../backup/canonicalize.js";
import { buildBackupCatalog } from "../backup/catalog.js";
import {
  createFrozenFullBackupResolutionPlan,
  FROZEN_FULL_BACKUP_ACTIONS,
  validateFrozenFullBackupResolution,
} from "../backup/frozen-resolution.js";
import {
  getChatMeta,
  getFullMessages,
  getHistoricalChanges,
  getPendingChanges,
  getRecentMessages,
  openBackupDatabase,
  resolveFrozenFullBackup,
  updateChatMetaSummary,
} from "../db/index.js";
import { renderCurrentChatPanel } from "../ui/current-chat-panel.js";
import { openFrozenBackupDialog } from "../ui/frozen-backup-dialog.js";
import { createCurrentChatStorageText } from "../ui/storage-status.js";
import {
  closeStatusDialog,
  openStatusDialog,
  syncStatusLinePlacement,
} from "../ui/status-line.js";

export function createPanelController({
  getContextReader,
  getSettings,
  getLatestStatus,
  setStatus,
  readCurrentPending,
  createDisplayStatus,
  createRestoreUiState,
  verifyBackendNow,
  verifyBackendSnapshotNow,
  verificationRetryLimit,
  openBackupCleanup,
  getStorageSnapshot = () => ({}),
  openFrozenDialog = openFrozenBackupDialog,
  resolveFrozenBackup = resolveFrozenFullBackup,
  onBackupsChanged = async () => {},
}) {
  function getPanelElements(target = "settings") {
    if (target === "status" || target === "dialog") {
      syncStatusLinePlacement();
    }

    if (target === "dialog") {
      return {
        panel: document.querySelector("#boxed-lllllabc-status-dialog"),
        panelBody: document.querySelector("#boxed-lllllabc-status-dialog-body"),
        button: null,
      };
    }

    const panelId = target === "status" ? "#boxed-lllllabc-status-panel" : "#boxed-lllllabc-settings-panel";
    const panelBodyId = target === "status" ? "#boxed-lllllabc-status-panel-body" : "#boxed-lllllabc-settings-panel-body";
    return {
      panel: document.querySelector(panelId),
      panelBody: document.querySelector(panelBodyId),
      button: target === "status" ? null : document.querySelector("#boxed-lllllabc-toggle-panel"),
    };
  }

  function setPanelOpenState(target, isOpen) {
    if (target === "dialog") {
      if (isOpen) {
        openStatusDialog();
      } else {
        closeStatusDialog();
      }
      return;
    }

    const { panel, panelBody, button } = getPanelElements(target);
    if (panel) {
      panel.hidden = !isOpen;
    }

    if (!isOpen) {
      panelBody?.removeAttribute("data-recent-expanded");
    }

    if (button) {
      setButtonLabel(button, isOpen
        ? "收起"
        : target === "status"
          ? "查看"
          : "查看当前聊天备份");
    }
  }

  async function openCurrentChatPanel() {
    if (getSettings().statusDisplayMode === "top") {
      await showPanel("status");
      return;
    }

    await showPanel("dialog");
  }

  async function toggleCurrentChatPanel() {
    if (getSettings().statusDisplayMode === "top") {
      await togglePanel("status");
      return;
    }

    await showPanel("dialog");
  }

  async function togglePanel(target = "settings") {
    const { panel } = getPanelElements(target);
    if (!panel) {
      return;
    }

    if (!panel.hidden) {
      setPanelOpenState(target, false);
      return;
    }

    await showPanel(target);
  }

  async function showPanel(target = "settings") {
    setPanelOpenState(target, true);
    await acknowledgeFullBackupIncident();
    await renderPanel(target);
  }

  async function renderPanel(target = "settings") {
    const { panel, panelBody } = getPanelElements(target);
    const contextReader = getContextReader();
    if (!panel || !panelBody || !contextReader) {
      return;
    }

    const current = contextReader.readCurrentChat();
    if (!current.ok) {
      renderCurrentChatPanel(panelBody, {
        status: createBackupStatus("identity-missing", "无法识别当前聊天", current.reason),
        meta: null,
        messages: [],
        pending: [],
        settings: getSettings(),
      });
      return;
    }

    try {
      const db = await openBackupDatabase();
      try {
        const [messages, pending, fullMessages, historicalChanges, meta] = await Promise.all([
          getRecentMessages(db, current.identity.chatKey),
          getPendingChanges(db, current.identity.chatKey),
          getFullMessages(db, current.identity.chatKey),
          getHistoricalChanges(db, current.identity.chatKey),
          getChatMeta(db, current.identity.chatKey),
        ]);
        const panelMeta = { ...current.identity.meta, ...meta };
        const settings = getSettings();
        const restore = createRestoreUiState({
          current,
          messages,
          fullMessages,
          historicalChanges,
          pending,
          meta: panelMeta,
        });
        const cleanupChat = buildCurrentCleanupChat({
          meta: panelMeta,
          messages,
          pending,
          fullMessages,
          historicalChanges,
        });
        const frozenResolution = createFrozenFullBackupResolutionPlan({
          current,
          meta: panelMeta,
          fullMessages,
        });
        renderCurrentChatPanel(panelBody, {
          status: getLatestStatus(),
          meta: panelMeta,
          messages,
          fullMessages,
          historicalChanges,
          pending,
          settings,
          restore,
          frozenResolution: frozenResolution.ok
            ? {
              plan: frozenResolution.plan,
              onOpen: () => openFrozenDialog({
                plan: frozenResolution.plan,
                fullBackupEnabled: Boolean(settings.enabled && settings.fullBackupEnabled),
                onConfirm: (action, plan) => executeFrozenResolution(plan, action),
              }),
            }
            : {},
          management: {
            disabledReason: cleanupChat ? "" : "当前聊天还没有可管理的本地备份。",
            storageText: createCurrentChatStorageText(
              getStorageSnapshot(),
              cleanupChat?.storageBytes ?? 0,
            ),
            onOpen: cleanupChat && typeof openBackupCleanup === "function"
              ? () => openBackupCleanup(cleanupChat)
              : null,
          },
          onVerify: async () => {
            if (pending.length) {
              await verifyBackendNow({
                chatKey: current.identity.chatKey,
                retryIndex: verificationRetryLimit,
              });
            } else {
              await verifyBackendSnapshotNow({
                chatKey: current.identity.chatKey,
                expectedChatHash: hashCanonicalChat(current.chat),
                retryIndex: verificationRetryLimit,
              });
            }
            await refreshVisiblePanel();
          },
        });
      } finally {
        db.close();
      }
    } catch (error) {
      renderCurrentChatPanel(panelBody, {
        status: createBackupStatus("db-error", "本地备份不可用", error),
        meta: current.identity.meta,
        messages: [],
        pending: [],
        settings: getSettings(),
      });
    }
  }

  async function refreshVisiblePanel() {
    const panels = [
      ["settings", document.querySelector("#boxed-lllllabc-settings-panel")],
      ["status", document.querySelector("#boxed-lllllabc-status-panel")],
      ["dialog", document.querySelector("#boxed-lllllabc-status-dialog")],
    ];

    for (const [target, panel] of panels) {
      if (!panel || panel.hidden) {
        continue;
      }

      await renderPanel(target);
    }
  }

  async function executeFrozenResolution(plan, action) {
    const contextReader = getContextReader();
    if (!contextReader) {
      return { ok: false, reason: "扩展尚未准备好，请关闭后重新打开。" };
    }

    const current = contextReader.readCurrentChat();
    let db;
    try {
      db = await openBackupDatabase();
      const [meta, fullMessages] = await Promise.all([
        getChatMeta(db, plan?.chatKey),
        getFullMessages(db, plan?.chatKey),
      ]);
      const validation = validateFrozenFullBackupResolution({
        plan,
        action,
        current,
        meta,
        fullMessages,
      });
      if (!validation.ok) {
        return validation;
      }

      const now = new Date().toISOString();
      const messages = action === FROZEN_FULL_BACKUP_ACTIONS.adoptCurrent
        ? current.chat.map((message, index) => canonicalizeMessage(message, index, now))
        : [];
      const result = await resolveFrozenBackup(db, {
        chatKey: plan.chatKey,
        action,
        expectedFullFingerprint: plan.expectedFullFingerprint,
        expectedIncidentFingerprint: plan.expectedIncidentFingerprint,
        messages,
        identityMeta: current.identity.meta,
        now,
      });
      await refreshVisiblePanel();
      await onBackupsChanged();
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

  async function acknowledgeFullBackupIncident() {
    const contextReader = getContextReader();
    if (!contextReader) {
      return;
    }

    const current = contextReader.readCurrentChat();
    if (!current.ok) {
      return;
    }

    const db = await openBackupDatabase();
    try {
      const meta = await getChatMeta(db, current.identity.chatKey);
      if (meta?.fullBackupState !== "frozen" || meta?.fullBackupIncident?.acknowledgedAt) {
        return;
      }
      await updateChatMetaSummary(db, current.identity.chatKey, {
        fullBackupIncident: {
          ...meta.fullBackupIncident,
          acknowledgedAt: new Date().toISOString(),
        },
      });
      if (getLatestStatus().code === "full-frozen") {
        const pending = await readCurrentPending(current.identity.chatKey);
        setStatus(pending.length
          ? createDisplayStatus("checking", "保存中", "", pending)
          : createDisplayStatus("saved", "后端已保存"));
      }
    } finally {
      db.close();
    }
  }

  function handleStatusDisplayModeChange(mode) {
    if (mode === "message") {
      setPanelOpenState("status", false);
    } else {
      closeStatusDialog();
    }
    syncStatusLinePlacement();
  }

  return {
    executeFrozenResolution,
    getPanelElements,
    handleStatusDisplayModeChange,
    openCurrentChatPanel,
    refreshVisiblePanel,
    renderPanel,
    setPanelOpenState,
    syncStatusLinePlacement,
    toggleCurrentChatPanel,
    togglePanel,
  };
}

export function buildCurrentCleanupChat({
  meta,
  messages = [],
  pending = [],
  fullMessages = [],
  historicalChanges = [],
} = {}) {
  return buildBackupCatalog({
    chatMeta: meta ? [meta] : [],
    recentMessages: messages,
    pendingChanges: pending,
    fullMessages,
    historicalChanges,
  }).chats[0] ?? null;
}

function setButtonLabel(button, text) {
  const label = button?.querySelector("[data-boxed-lllllabc-button-label]");
  if (label) {
    label.textContent = text;
    return;
  }

  if (button) {
    button.textContent = text;
  }
}
