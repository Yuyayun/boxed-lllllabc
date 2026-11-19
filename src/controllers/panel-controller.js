import { createBackupStatus } from "../backup/recent.js";
import { canonicalizeMessage, hashCanonicalChat } from "../backup/canonicalize.js";
import { buildBackupCatalog } from "../backup/catalog.js";
import {
  createFrozenFullBackupResolutionPlan,
  FROZEN_FULL_BACKUP_ACTIONS,
  validateFrozenFullBackupResolution,
} from "../backup/frozen-resolution.js";
import { defaultBackupStorage } from "../storage/service.js";
import { renderCurrentChatPanel } from "../ui/current-chat-panel.js";
import { openFrozenBackupDialog } from "../ui/frozen-backup-dialog.js";
import { createCurrentChatStorageText } from "../ui/storage-status.js";
import { readBackupRecords, writeBackupRecords } from '../storage/backup-batches.js';
import { readBackupCatalog } from '../storage/catalog-reader.js';
import { buildResolvedFullBackupMeta } from '../backup/frozen-resolution.js';
import { backupFailureStatus } from '../backup/failure-status.js';
import { stableText } from '../storage/value-digest.js';
import {
  closeStatusDialog,
  openStatusDialog,
  syncStatusLinePlacement,
} from "../ui/status-line.js";

export function createPanelController({
  storage = defaultBackupStorage,
  runGuard = (operation) => operation(),
  onCreateSnapshot,
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
  onBackupsChanged = async () => {},
}) {
  const readFailures = new Map();
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
      const session = await storage.open();
      try {
        const summary = session.capabilities?.boundedBackup ? await session.getBackupSummary(current.identity.chatKey) : null;
        const [messages, pending, fullMessages, historicalChanges, meta] = summary ? [await readBackupRecords(session, current.identity.chatKey, 'recent_messages', { summary }), [], [], [], summary.meta] : await Promise.all([
          session.getRecentMessages(current.identity.chatKey),
          session.getPendingChanges(current.identity.chatKey),
          session.getFullMessages(current.identity.chatKey),
          session.getHistoricalChanges(current.identity.chatKey),
          session.getChatMeta(current.identity.chatKey),
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
          summary,
        });
        const cleanupChat = summary ? null : buildCurrentCleanupChat({
          meta: panelMeta,
          messages,
          pending,
          summary,
          fullMessages,
          historicalChanges,
        });
        const hasCleanup = summary
          ? Object.values(summary.counts).some(count => count > 0)
          : Boolean(cleanupChat);
        const frozenResolution = createFrozenFullBackupResolutionPlan({
          current,
          meta: panelMeta,
          fullMessages,
        });
        renderCurrentChatPanel(panelBody, {
          onCreateSnapshot,
          summary,
          status: readFailures.get(current.identity.chatKey) ?? getLatestStatus(),
          meta: panelMeta,
          messages,
          fullMessages,
          historicalChanges,
          pending,
          settings,
          restore,
          frozenResolution: summary && panelMeta.fullBackupState === 'frozen' ? { plan: true, onOpen: async () => {
            const fresh = await storage.open();
            try { const state = await fresh.getBackupSummary(current.identity.chatKey); const full = await readBackupRecords(fresh, current.identity.chatKey, 'full_messages', { summary: state });
              const resolution = createFrozenFullBackupResolutionPlan({ current: contextReader.readCurrentChat(), meta: state.meta, fullMessages: full });
              if (resolution.ok) openFrozenDialog({ plan: resolution.plan, fullBackupEnabled: Boolean(settings.enabled && settings.fullBackupEnabled), onConfirm: (action, plan) => executeFrozenResolution(plan, action) });
            } catch (error) { globalThis.toastr?.error?.(error.message, '箱装辣白菜'); } finally { fresh.close(); }
          } } : frozenResolution.ok
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
            disabledReason: hasCleanup ? "" : "当前聊天还没有可管理的备份。",
            storageText: summary ? '' : createCurrentChatStorageText(
              getStorageSnapshot(),
              cleanupChat?.storageBytes ?? 0,
            ),
            onOpen: hasCleanup && typeof openBackupCleanup === "function"
              ? () => summary
                ? openCurrentBackupCleanup(current.identity.chatKey)
                : openBackupCleanup(cleanupChat)
              : null,
          },
          onVerify: async () => {
            readFailures.delete(current.identity.chatKey);
            try {
              let pendingCount = pending.length;
              if (summary) {
                const fresh = await storage.open();
                try {
                  pendingCount = (await fresh.getBackupSummary(current.identity.chatKey)).counts.pending_changes;
                } finally {
                  fresh.close();
                }
              }
              if (pendingCount > 0) {
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
            } catch (error) {
              const failure = backupFailureStatus(error, '读取');
              readFailures.set(current.identity.chatKey, failure);
              if (failure.code === 'db-error') setStatus(failure);
            }
            await refreshVisiblePanel();
          },
        });
      } finally {
        session.close();
      }
    } catch (error) {
      renderCurrentChatPanel(panelBody, {
        status: backupFailureStatus(error, '读取'),
        meta: current.identity.meta,
        messages: [],
        pending: [],
        settings: getSettings(),
      });
    }
  }

  async function openCurrentBackupCleanup(chatKey) {
    let chat;
    try {
      const session = await storage.open();
      try {
        const catalog = await readBackupCatalog(session);
        chat = catalog.chats.find(chat => chat.chatKey === chatKey);
      } finally {
        session.close();
      }
      if (!chat) {
        throw new Error("当前聊天已没有可管理的备份，请刷新后重试。");
      }
    } catch (error) {
      const failure = backupFailureStatus(error, '读取');
      readFailures.set(chatKey, failure);
      if (failure.code === 'db-error') setStatus(failure);
      globalThis.toastr?.error?.(failure.detail, '箱装辣白菜');
      await refreshVisiblePanel();
      return;
    }
    return openBackupCleanup(chat);
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

  const executeFrozenResolution = (plan, action) => runGuard(() => executeFrozenResolutionImpl(plan, action)).catch((error) => ({ ok: false, reason: error.message }));
  async function executeFrozenResolutionImpl(plan, action) {
    const contextReader = getContextReader();
    if (!contextReader) {
      return { ok: false, reason: "扩展尚未准备好，请关闭后重新打开。" };
    }

    const current = contextReader.readCurrentChat();
    let session;
    try {
      session = await storage.open();
      const state = session.capabilities?.boundedBackup ? await session.getBackupSummary(plan?.chatKey) : null;
      const [meta, fullMessages] = state ? [state.meta, await readBackupRecords(session, plan?.chatKey, 'full_messages', { summary: state })] : await Promise.all([
        session.getChatMeta(plan?.chatKey),
        session.getFullMessages(plan?.chatKey),
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
      const source = state && action === FROZEN_FULL_BACKUP_ACTIONS.adoptCurrent ? structuredClone(current.chat) : null;
      const observedLength = current.chat.length;
      const messages = source ? source.map((_raw, messageIndex) => ({ messageIndex })) : action === FROZEN_FULL_BACKUP_ACTIONS.adoptCurrent
        ? current.chat.map((message, index) => canonicalizeMessage(message, index, now))
        : [];
      const result = state ? await writeBackupRecords(session, { chatKey: plan.chatKey, store: 'full_messages', rows: source ?? messages, mapRow: source ? (raw, index) => canonicalizeMessage(raw, index, now) : undefined, replace: true, summary: state, meta: buildResolvedFullBackupMeta({ action, currentMeta: meta, identityMeta: current.identity.meta, messages, now }), sourceUnchanged: () => {
        const live = contextReader.readCurrentChat(); return live.ok && live.identity.chatKey === plan.chatKey && live.chat.length === observedLength;
      }, validateSource: () => {
        const live = contextReader.readCurrentChat(); return live.ok && live.identity.chatKey === plan.chatKey && (source ? source.length === live.chat.length && source.every((raw, index) => stableText(raw) === stableText(live.chat[index])) : hashCanonicalChat(live.chat) === plan.expectedCurrentChatHash);
      } }) : await session.resolveFrozenFullBackup({
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
      session?.close?.();
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

    const session = await storage.open();
    try {
      const meta = await session.getChatMeta(current.identity.chatKey);
      if (meta?.fullBackupState !== "frozen" || meta?.fullBackupIncident?.acknowledgedAt) {
        return;
      }
      await session.updateChatMetaSummary(current.identity.chatKey, {
        fullBackupIncident: {
          ...meta.fullBackupIncident,
          acknowledgedAt: new Date().toISOString(),
        },
      });
      if (getLatestStatus().code === "full-frozen") {
        const pending = await readCurrentPending(current.identity.chatKey);
        setStatus(pending.length
          ? createDisplayStatus("checking", "正在检查保存状态", "", pending)
          : createDisplayStatus("saved", "酒馆聊天已保存"));
      }
    } finally {
      session.close();
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
