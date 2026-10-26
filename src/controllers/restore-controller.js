import { refreshRecentBackup } from "../backup/recent.js";
import { executeRestorePlan } from "../backup/restore-executor.js";
import {
  createHistoricalRestorePlan,
  createFullRestorePlan,
  createPendingRestorePlan,
  createRecentRestoreOptions,
  createRecentRestorePlan,
} from "../backup/restore.js";
import {
  createSaveRequestPlan,
  SAVE_REQUEST_TIMEOUT_MS,
  validateSaveRequestPlan,
  waitForSaveRequest,
} from "../backup/save-request.js";
import { defaultBackupStorage } from "../storage/service.js";
import { buildVisibleChatSummary } from "../ui/presentation.js";
import { openRestoreDialog } from "../ui/restore-dialog.js";
import { openRecoveryCenterDialog } from "../ui/recovery-center-dialog.js";
import { openSaveRequestDialog } from "../ui/save-request-dialog.js";

export function createRestoreController({
  storage = defaultBackupStorage,
  runGuard = (operation) => operation(),
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
  saveRequestTimeoutMs = SAVE_REQUEST_TIMEOUT_MS,
  waitForSave = waitForSaveRequest,
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

  const confirmRestore = (plan) => runGuard(() => confirmRestoreImpl(plan)).catch((error) => ({ ok: false, reason: error.message }));
  async function confirmRestoreImpl(plan) {
    const contextReader = getContextReader();
    const result = await executeRestorePlan({
      plan,
      readCurrent: () => contextReader.readCurrentChat(),
      readPending: (chatKey) => readCurrentPending(chatKey),
      writePending: async (records) => {
        const session = await storage.open();
        try {
          await session.putPendingChanges(records);
        } finally {
          session.close();
        }
      },
      replacePending: async (records) => {
        const session = await storage.open();
        try {
          await session.replacePendingChanges({ chatKey: plan.chatKey, records });
        } finally {
          session.close();
        }
      },
      render: renderRestoredMessages,
      save: async ({ current }) => {
        if (typeof current.context?.saveChat !== "function") {
          throw new Error("当前酒馆版本没有提供聊天保存接口。");
        }
        return waitForSave({
          save: () => current.context.saveChat(),
          timeoutMs: saveRequestTimeoutMs,
        });
      },
    });

    if (result.changed) {
      const restored = contextReader.readCurrentChat();
      if (restored.ok && restored.identity.chatKey === plan.chatKey) {
        await refreshBackupsAfterRestore({ current: restored, plan });
        const pending = await readCurrentPending(plan.chatKey);
        setStatus(createDisplayStatus("checking", "正在核对后端", "", pending));
        scheduleBackendVerification(plan.chatKey, getSettings().backendVerifyDelayMs, 0);
      }
      await refreshVisiblePanel();
    }

    if (result.ok && result.saveOutcome?.status === "timeout") {
      globalThis.toastr?.info?.("酒馆仍在处理保存请求，已继续在后台核对。", "箱装辣白菜");
    } else if (result.ok) {
      globalThis.toastr?.success?.("恢复内容已提交给酒馆保存。", "箱装辣白菜");
    } else {
      globalThis.toastr?.error?.(result.reason, "箱装辣白菜");
    }
    return result;
  }

  const requestSave = (plan) => runGuard(() => requestSaveImpl(plan)).catch((error) => ({ ok: false, reason: error.message }));
  async function requestSaveImpl(plan) {
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

    const saveOutcome = await waitForSave({
      save: () => current.context.saveChat(),
      timeoutMs: saveRequestTimeoutMs,
    });
    if (!saveOutcome.ok) {
      setStatus(createDisplayStatus("unconfirmed", "等待确认保存情况", saveOutcome.reason, pending));
      await refreshVisiblePanel();
      globalThis.toastr?.error?.("重新请求保存失败，未保存变更仍会保留。", "箱装辣白菜");
      return { ok: false, reason: saveOutcome.reason };
    }

    const latestPending = await readCurrentPending(plan.chatKey);
    setStatus(createDisplayStatus("checking", "正在核对后端", "", latestPending));
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
    const timedOut = saveOutcome.status === "timeout";
    globalThis.toastr?.info?.(
      timedOut
        ? "酒馆仍在处理保存请求，已继续在后台核对。"
        : "已请求保存，等待后端确认。",
      "箱装辣白菜",
    );
    return { ok: true, reason: "", code: timedOut ? "save-timeout" : "save-requested" };
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
        storage,
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
