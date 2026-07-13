import { refreshRecentBackup } from "../backup/recent.js";
import { executeRestorePlan } from "../backup/restore-executor.js";
import {
  createHistoricalRestorePlan,
  createFullRestorePlan,
  createPendingRestorePlan,
  createRecentRestoreOptions,
  createRecentRestorePlan,
} from "../backup/restore.js";
import { createSaveRequestPlan, validateSaveRequestPlan } from "../backup/save-request.js";
import { openBackupDatabase, putPendingChanges, replacePendingChanges } from "../db/index.js";
import { buildVisibleChatSummary } from "../ui/presentation.js";
import { openRestoreDialog } from "../ui/restore-dialog.js";
import { openRecoveryCenterDialog } from "../ui/recovery-center-dialog.js";
import { openSaveRequestDialog } from "../ui/save-request-dialog.js";

export function createRestoreController({
  getContextReader,
  getSettings,
  eventTypes,
  readCurrentPending,
  setStatus,
  createDisplayStatus,
  scheduleBackendVerification,
  scheduleBackendSnapshotVerification,
  refreshVisiblePanel,
  refreshFullBackup,
  refreshHistoricalBackup,
}) {
  function createRestoreUiState({ current, messages, fullMessages, historicalChanges, pending, meta }) {
    const pendingPlan = createPendingRestorePlan({
      chat: current.chat,
      chatKey: current.identity.chatKey,
      pending,
    });
    const recentOptions = createRecentRestoreOptions({
      chat: current.chat,
      recent: messages,
    });
    const fullPlan = createFullRestorePlan({
      chat: current.chat,
      chatKey: current.identity.chatKey,
      fullMessages,
      pending,
    });
    const saveRequestPlan = createSaveRequestPlan({
      chat: current.chat,
      chatKey: current.identity.chatKey,
      pending,
    });
    const disabledReason = getSettings().enabled ? "" : "请先启用本地备份，再执行恢复或请求保存。";

    return {
      pendingPlan,
      fullPlan,
      recentOptions,
      disabledReason,
      onRequestSave: disabledReason
        ? undefined
        : () => showSaveRequestDialog({ plan: saveRequestPlan, pending, meta }),
      onOpenRecovery: () => showRecoveryCenter({
        current,
        messages,
        fullMessages,
        historicalChanges,
        pending,
        meta,
        pendingPlan,
        recentOptions,
        fullPlan,
        disabledReason,
      }),
      onPreviewPending: () => showRestorePreview({ plan: pendingPlan, current, meta }),
      onPreviewFull: () => showRestorePreview({ plan: fullPlan, current, meta }),
      onPreviewRecent: (endIndex) => {
        const plan = createRecentRestorePlan({
          chat: current.chat,
          chatKey: current.identity.chatKey,
          recent: messages,
          pending,
          endIndex,
        });
        return showRestorePreview({ plan, current, meta });
      },
      onPreviewHistorical: (messageIndex) => {
        const plan = createHistoricalRestorePlan({
          chat: current.chat,
          chatKey: current.identity.chatKey,
          historical: historicalChanges,
          pending,
          messageIndex,
        });
        return showRestorePreview({ plan, current, meta });
      },
    };
  }

  function showRecoveryCenter({
    current,
    messages,
    fullMessages,
    historicalChanges,
    pending,
    meta,
    pendingPlan,
    recentOptions,
    fullPlan,
    disabledReason,
  }) {
    const chatName = buildVisibleChatSummary(meta)[0]?.value || "当前聊天";
    openRecoveryCenterDialog({
      state: {
        chatName,
        pendingPlan,
        pendingCount: pending.length,
        recentOptions,
        recentMessages: messages,
        fullPlan,
        fullMessages,
        historicalChanges,
        disabledReason,
      },
      onPreviewPending: () => showRestorePreview({ plan: pendingPlan, current, meta }),
      onPreviewRecent: (endIndex) => {
        const plan = createRecentRestorePlan({
          chat: current.chat,
          chatKey: current.identity.chatKey,
          recent: messages,
          pending,
          endIndex,
        });
        return showRestorePreview({ plan, current, meta });
      },
      onPreviewFull: () => showRestorePreview({ plan: fullPlan, current, meta }),
      onPreviewHistorical: (messageIndex) => {
        const plan = createHistoricalRestorePlan({
          chat: current.chat,
          chatKey: current.identity.chatKey,
          historical: historicalChanges,
          pending,
          messageIndex,
        });
        return showRestorePreview({ plan, current, meta });
      },
    });
  }

  function showSaveRequestDialog({ plan, pending, meta }) {
    const chatName = buildVisibleChatSummary(meta)[0]?.value || "当前聊天";
    openSaveRequestDialog({
      plan,
      chatName,
      pending,
      onConfirm: (confirmedPlan) => requestSave(confirmedPlan),
    });
  }

  function showRestorePreview({ plan, current, meta }) {
    if (plan.blockedReason) {
      globalThis.toastr?.warning?.(plan.blockedReason, "箱装辣白菜");
      return;
    }

    const chatName = buildVisibleChatSummary(meta)[0]?.value || "当前聊天";
    openRestoreDialog({
      plan,
      chatName,
      currentChat: current.chat,
      onConfirm: (confirmedPlan) => confirmRestore(confirmedPlan),
    });
  }

  async function confirmRestore(plan) {
    const contextReader = getContextReader();
    const result = await executeRestorePlan({
      plan,
      readCurrent: () => contextReader.readCurrentChat(),
      readPending: (chatKey) => readCurrentPending(chatKey),
      writePending: async (records) => {
        const db = await openBackupDatabase();
        try {
          await putPendingChanges(db, records);
        } finally {
          db.close();
        }
      },
      replacePending: async (records) => {
        const db = await openBackupDatabase();
        try {
          await replacePendingChanges(db, { chatKey: plan.chatKey, records });
        } finally {
          db.close();
        }
      },
      render: renderRestoredMessages,
      save: async ({ current }) => {
        if (typeof current.context?.saveChat !== "function") {
          throw new Error("当前酒馆版本没有提供聊天保存接口。");
        }
        await current.context.saveChat();
      },
    });

    if (result.changed) {
      const restored = contextReader.readCurrentChat();
      if (restored.ok && restored.identity.chatKey === plan.chatKey) {
        await refreshBackupsAfterRestore({ current: restored, plan });
        const pending = await readCurrentPending(plan.chatKey);
        setStatus(createDisplayStatus("checking", "保存中", "", pending));
        scheduleBackendVerification(plan.chatKey, getSettings().backendVerifyDelayMs, 0);
      }
      await refreshVisiblePanel();
    }

    if (result.ok) {
      globalThis.toastr?.success?.("恢复内容已提交给酒馆保存。", "箱装辣白菜");
    } else {
      globalThis.toastr?.error?.(result.reason, "箱装辣白菜");
    }
    return result;
  }

  async function requestSave(plan) {
    const current = getContextReader().readCurrentChat();
    const pending = current.ok
      ? await readCurrentPending(current.identity.chatKey)
      : [];
    const validation = validateSaveRequestPlan({ plan, current, pending });
    if (!validation.ok) {
      globalThis.toastr?.warning?.(validation.reason, "箱装辣白菜");
      return validation;
    }

    if (typeof current.context?.saveChat !== "function") {
      const reason = "当前酒馆版本没有提供聊天保存接口。";
      globalThis.toastr?.error?.(reason, "箱装辣白菜");
      return { ok: false, reason };
    }

    try {
      await current.context.saveChat();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setStatus(createDisplayStatus("unconfirmed", "后端内容待确认", reason, pending));
      await refreshVisiblePanel();
      globalThis.toastr?.error?.("重新请求保存失败，未保存变更仍会保留。", "箱装辣白菜");
      return { ok: false, reason };
    }

    const latestPending = await readCurrentPending(plan.chatKey);
    setStatus(createDisplayStatus("checking", "保存中", "", latestPending));
    if (latestPending.length) {
      scheduleBackendVerification(plan.chatKey, getSettings().backendVerifyDelayMs, 0);
    } else {
      scheduleBackendSnapshotVerification(
        plan.chatKey,
        plan.chatHash,
        getSettings().backendVerifyDelayMs,
        0,
      );
    }
    await refreshVisiblePanel();
    globalThis.toastr?.info?.("已请求保存，等待后端确认。", "箱装辣白菜");
    return { ok: true, reason: "" };
  }

  async function refreshBackupsAfterRestore({ current, plan }) {
    const settings = getSettings();
    const triggers = [...plan.replacements, ...plan.appends].map((item) => ({
      eventName: eventTypes.MESSAGE_UPDATED || "message_updated",
      args: [item.messageIndex],
    }));
    if (plan.deletions?.length) {
      triggers.push({
        eventName: eventTypes.MESSAGE_DELETED || "message_deleted",
        args: [plan.deletions[0].messageIndex],
      });
    }

    await refreshFullBackup({
      current,
      settings,
      triggers,
      reason: "restore",
    });
    await refreshHistoricalBackup({ current, settings, triggers });
    if (settings.recentBackupEnabled) {
      await refreshRecentBackup({
        contextReader: getContextReader(),
        settings,
        reason: "restore",
      });
    }
  }

  return {
    confirmRestore,
    createRestoreUiState,
    requestSave,
    showRestorePreview,
    showSaveRequestDialog,
  };
}

export async function renderRestoredMessages({ current, plan }) {
  const context = current.context ?? {};
  if (plan.source === "full") {
    if (typeof context.clearChat !== "function" || typeof context.printMessages !== "function") {
      throw new Error("当前酒馆版本无法完整重绘聊天。");
    }
    await context.clearChat();
    await context.printMessages();
    return;
  }

  for (const item of plan.replacements) {
    if (typeof context.updateMessageBlock !== "function") {
      throw new Error("当前酒馆版本无法重新渲染已有楼层。");
    }
    context.updateMessageBlock(item.messageIndex, current.chat[item.messageIndex]);
  }

  for (const item of plan.appends) {
    if (typeof context.addOneMessage !== "function") {
      throw new Error("当前酒馆版本无法渲染追加楼层。");
    }
    context.addOneMessage(current.chat[item.messageIndex], {
      scroll: false,
      forceId: item.messageIndex,
      showSwipes: false,
    });
  }
  context.swipe?.refresh?.(true, false);
}
