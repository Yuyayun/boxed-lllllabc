import {
  createFullBackupAwaitingMeta,
  createFullBackupDecision,
  createFullBackupMeta,
  shouldPrioritizeFullBackupWarning,
} from "../backup/full.js";
import { hashCanonicalChat } from "../backup/canonicalize.js";
import { createHistoricalRecord } from "../backup/historical.js";
import { createPendingRecords, summarizePendingChanges } from "../backup/pending.js";
import { createBackupStatus, refreshRecentBackup } from "../backup/recent.js";
import { defaultBackupStorage } from "../storage/service.js";
import { buildChatRenameIdentity, resolveChatRenameTarget } from "../identity.js";
import { readOwnerChatCatalog } from "../rename/chat-catalog.js";
import {
  confirmLegacyRenameWithStoredIntegrity,
  createLegacyRenameObservation,
  detectLegacyChatRename,
  shouldRefreshLegacyRenameCatalog,
  updateLegacyRenameObservation,
} from "../rename/legacy-rename.js";
import { formatStatusText } from "../ui/presentation.js";
import { readBackendChat } from "../verifier/backend-reader.js";

export function createBackupCoordinator({
  storage = defaultBackupStorage,
  getContextReader,
  getSettings,
  getLatestStatus,
  setStatus,
  refreshVisiblePanel,
  clearScheduledVerification,
  verifyBackendNow,
  verifyBackendSnapshotNow,
  scheduleBackendVerification,
  scheduleBackendSnapshotVerification,
  verificationRetryLimit,
  eventTypes = {},
  readChatCatalog = readOwnerChatCatalog,
  readRenameSourceMeta = (chatKey) => readStoredChatMeta(storage, chatKey),
  readRenameBackend = readBackendChat,
}) {
  let legacyRenameObservation = null;

  async function runBackupNow(trigger = {}) {
    const eventName = typeof trigger === "string" ? trigger : trigger.eventName || "manual";
    const args = typeof trigger === "string" ? [] : trigger.args || [];
    const verifyNow = typeof trigger === "object" && Boolean(trigger.verifyNow);
    const triggerList = typeof trigger === "object" && Array.isArray(trigger.triggers) && trigger.triggers.length
      ? trigger.triggers
      : [{ eventName, args }];
    const settings = getSettings();
    if (!settings.enabled) {
      clearScheduledVerification();
      const status = createDisplayStatus("disabled", "备份未启用");
      setStatus(status);
      await refreshVisiblePanel();
      return status;
    }

    const contextReader = getContextReader();
    const current = contextReader.readCurrentChat();
    if (!current.ok) {
      const status = createBackupStatus("identity-missing", "无法识别当前聊天", current.reason);
      setStatus(status);
      await refreshVisiblePanel();
      return status;
    }

    const legacyRenameStatus = await reconcileLegacyRename({ current, triggers: triggerList });
    if (legacyRenameStatus?.code === "db-error") {
      setStatus(legacyRenameStatus);
      await refreshVisiblePanel();
      return legacyRenameStatus;
    }

    const identityStatus = await reconcileCurrentIdentity(current.identity);
    if (identityStatus?.code === "db-error") {
      setStatus(identityStatus);
      await refreshVisiblePanel();
      return identityStatus;
    }

    const fullStatus = await refreshFullBackup({
      current,
      settings,
      triggers: triggerList,
      reason: eventName,
    });
    if (fullStatus?.code === "db-error") {
      setStatus(fullStatus);
      await refreshVisiblePanel();
      return fullStatus;
    }

    try {
      const session = await storage.open();
      try {
        const pendingRecords = triggerList.flatMap((item) => createPendingRecords({
          chat: current.chat,
          chatKey: current.identity.chatKey,
          eventName: item.eventName,
          args: item.args,
        }));

        await session.putPendingChanges(pendingRecords);
      } finally {
        session.close();
      }
    } catch (error) {
      console.error("[boxed-lllllabc] pending 写入失败", error);
      const status = createBackupStatus("db-error", "备份不可用", error);
      setStatus(status);
      await refreshVisiblePanel();
      return status;
    }

    const historicalStatus = await refreshHistoricalBackup({
      current,
      settings,
      triggers: triggerList,
    });
    if (historicalStatus?.code === "db-error") {
      setStatus(historicalStatus);
      await refreshVisiblePanel();
      return historicalStatus;
    }

    if (settings.recentBackupEnabled) {
      const recentStatus = await refreshRecentBackup({
        storage,
        contextReader,
        settings,
        reason: eventName,
        triggers: triggerList,
      });

      if (recentStatus.code === "db-error") {
        setStatus(recentStatus);
        await refreshVisiblePanel();
        return recentStatus;
      }
    }

    const pending = await readCurrentPending(current.identity.chatKey);
    const requestedStatus = fullStatus?.code === "full-frozen"
      ? fullStatus
      : fullStatus?.code === "full-awaiting-confirmation"
        ? createDisplayStatus("checking", "正在检查保存状态", "正在确认其他扩展写入的聊天数据。", pending)
      : pending.length
        ? createDisplayStatus("checking", "正在检查保存状态", "", pending)
        : createDisplayStatus("saved", "酒馆聊天已保存");
    const status = await prioritizeFullBackupStatus(current.identity.chatKey, requestedStatus);

    setStatus(status);
    const needsFullConfirmation = fullStatus?.code === "full-awaiting-confirmation";
    await updateBackendMeta(
      current.identity.chatKey,
      pending.length || needsFullConfirmation ? "checking" : "saved",
      pending,
    );

    if (pending.length) {
      if (verifyNow) {
        await verifyBackendNow({
          chatKey: current.identity.chatKey,
          retryIndex: verificationRetryLimit,
        });
      } else {
        scheduleBackendVerification(current.identity.chatKey, settings.backendVerifyDelayMs, 0);
      }
    } else if (needsFullConfirmation) {
      const expectedChatHash = hashCanonicalChat(current.chat);
      if (verifyNow) {
        await verifyBackendSnapshotNow({
          chatKey: current.identity.chatKey,
          expectedChatHash,
          retryIndex: verificationRetryLimit,
        });
      } else {
        scheduleBackendSnapshotVerification(
          current.identity.chatKey,
          expectedChatHash,
          settings.backendVerifyDelayMs,
          0,
        );
      }
    }

    await refreshVisiblePanel();
    return getLatestStatus();
  }

  async function refreshFullBackup({ current, settings, triggers, reason, backendConfirmed = false }) {
    if (!settings.enabled || !settings.fullBackupEnabled) {
      return null;
    }

    try {
      const session = await storage.open();
      try {
        const [meta, messages] = await Promise.all([
          session.getChatMeta(current.identity.chatKey),
          session.getFullMessages(current.identity.chatKey),
        ]);
        const decision = createFullBackupDecision({
          existingMessages: messages,
          currentChat: current.chat,
          triggers,
          frozen: meta?.fullBackupState === "frozen",
          frozenIncident: meta?.fullBackupIncident,
          awaitingConfirmation: meta?.fullBackupState === "awaiting-confirmation",
          backendConfirmed,
        });

        if (decision.action === "skip-frozen") {
          return meta?.fullBackupIncident?.acknowledgedAt
            ? null
            : createBackupStatus("full-frozen", "完整备份已暂停更新");
        }

        if (decision.action === "skip" || decision.action === "noop") {
          return null;
        }

        if (decision.action === "await-confirmation") {
          const incident = {
            ...decision.incident,
            notifiedAt: meta?.fullBackupIncident?.notifiedAt ?? new Date().toISOString(),
          };
          await session.updateChatMetaSummary(current.identity.chatKey, createFullBackupAwaitingMeta({
            identity: current.identity,
            currentMessages: decision.currentMessages,
            previousMeta: meta,
            reason,
            incident,
          }));
          return createBackupStatus(
            "full-awaiting-confirmation",
            "完整备份待酒馆确认",
            "检测到其他扩展更新了已有楼层，确认后会安全接续。",
          );
        }

        if (decision.action === "freeze") {
          const incident = {
            ...decision.incident,
            notifiedAt: new Date().toISOString(),
          };
          await session.updateChatMetaSummary(current.identity.chatKey, createFullBackupMeta({
            identity: current.identity,
            messages,
            previousMeta: meta,
            reason,
            state: "frozen",
            incident,
          }));
          globalThis.toastr?.warning?.("聊天内容疑似异常缩短，完整备份已保留。", "箱装辣白菜");
          return createBackupStatus("full-frozen", "完整备份已暂停更新");
        }

        const nextMeta = createFullBackupMeta({
          identity: current.identity,
          messages: decision.currentMessages,
          previousMeta: meta,
          reason,
        });
        if (["create", "rebuild", "unfreeze", "reconcile"].includes(decision.action)) {
          await session.replaceFullSnapshot({
            chatKey: current.identity.chatKey,
            messages: decision.currentMessages,
            meta: nextMeta,
          });
        } else {
          await session.putFullMessages({
            chatKey: current.identity.chatKey,
            messages: decision.messages,
            meta: nextMeta,
          });
        }
        return null;
      } finally {
        session.close();
      }
    } catch (error) {
      console.error("[boxed-lllllabc] 完整聊天备份失败", error);
      return createBackupStatus("db-error", "备份不可用", error);
    }
  }

  async function confirmFullBackupAfterBackendVerification({ current }) {
    return refreshFullBackup({
      current,
      settings: getSettings(),
      triggers: [{ eventName: "backend-confirmed", args: [] }],
      reason: "backend-confirmed",
      backendConfirmed: true,
    });
  }

  async function reconcileCurrentIdentity(identity) {
    try {
      const session = await storage.open();
      try {
        const result = await session.reconcileChatIdentity(identity);
        if (result.status === "conflict") {
          return createBackupStatus(
            "db-error",
            "备份不可用",
            "聊天身份接续时发现目标键已有备份，已停止写入以避免覆盖。",
          );
        }
        if (result.status === "ambiguous") {
          console.warn("[boxed-lllllabc] 找到多个可能属于当前聊天的旧备份，已保留旧记录并为当前聊天单独备份。");
        }
        return null;
      } finally {
        session.close();
      }
    } catch (error) {
      console.error("[boxed-lllllabc] 聊天身份接续失败", error);
      return createBackupStatus("db-error", "备份不可用", error);
    }
  }

  async function handleChatRenamed(eventArgs) {
    const eventRename = buildChatRenameIdentity(eventArgs);
    if (!eventRename.ok) {
      console.warn(`[boxed-lllllabc] 已忽略无法确认身份的聊天改名事件：${eventRename.reason}`);
      return { status: "invalid", reason: eventRename.reason };
    }
    const contextReader = getContextReader();
    const current = contextReader.readCurrentChat();
    const rename = resolveChatRenameTarget(eventRename, current.ok ? current.identity : null);

    return migrateRenameIdentity(rename);
  }

  async function reconcileLegacyRename({ current, triggers }) {
    if (!shouldRefreshLegacyRenameCatalog({
      previous: legacyRenameObservation,
      current,
      triggers,
      eventTypes,
    })) {
      legacyRenameObservation = updateLegacyRenameObservation(legacyRenameObservation, current);
      return null;
    }

    let catalog;
    try {
      catalog = await readChatCatalog({ current });
    } catch (error) {
      console.warn("[boxed-lllllabc] 旧版酒馆改名识别无法读取聊天文件列表", error);
      legacyRenameObservation = null;
      return null;
    }
    if (!catalog?.ok) {
      console.warn(`[boxed-lllllabc] 旧版酒馆改名识别已跳过：${catalog?.reason || "聊天文件列表不可用。"}`);
      legacyRenameObservation = null;
      return null;
    }

    const nextObservation = createLegacyRenameObservation({
      current,
      catalogEntries: catalog.entries,
    });
    const detection = detectLegacyChatRename({
      previous: legacyRenameObservation,
      next: nextObservation,
      triggers,
      eventTypes,
    });
    legacyRenameObservation = nextObservation;
    let rename = detection.status === "rename" ? detection.rename : null;
    if (detection.status === "ambiguous" && detection.rename) {
      try {
        const confirmed = await confirmLegacyRenameWithStoredIntegrity({
          rename: detection.rename,
          current,
          readSourceMeta: readRenameSourceMeta,
          readBackend: readRenameBackend,
        });
        if (confirmed) {
          rename = detection.rename;
        }
      } catch (error) {
        console.warn("[boxed-lllllabc] 疑似聊天改名的 integrity 复核失败", error);
      }
    }
    if (!rename) {
      if (detection.status === "ambiguous") {
        console.warn("[boxed-lllllabc] 发现疑似聊天改名，但证据不足；旧备份已原样保留。", detection);
      }
      return null;
    }

    const result = await migrateRenameIdentity(rename);
    if (result.status === "error") {
      return createBackupStatus("db-error", "备份不可用", result.error);
    }
    return null;
  }

  async function migrateRenameIdentity(rename) {

    try {
      const session = await storage.open();
      try {
        const result = await session.migrateRenamedChatIdentity(rename);
        if (result.status === "conflict") {
          console.warn("[boxed-lllllabc] 聊天改名目标已有独立备份，已保留两边记录且没有覆盖。");
        } else if (result.status === "ambiguous") {
          console.warn("[boxed-lllllabc] 聊天改名对应多个旧备份，已停止迁移以避免串档。");
        }
        return result;
      } finally {
        session.close();
      }
    } catch (error) {
      console.error("[boxed-lllllabc] 聊天改名备份迁移失败", error);
      return { status: "error", error };
    }
  }

  async function refreshHistoricalBackup({ current, settings, triggers }) {
    if (!settings.enabled || !settings.historicalBackupEnabled) {
      return;
    }

    const records = dedupeHistoricalRecords((Array.isArray(triggers) ? triggers : [])
      .map((trigger) => createHistoricalRecord({
        chat: current.chat,
        chatKey: current.identity.chatKey,
        eventName: trigger.eventName,
        args: trigger.args,
        recentLimit: settings.recentLimit,
        settings,
      }))
      .filter(Boolean));

    if (!records.length) {
      return;
    }

    try {
      const session = await storage.open();
      try {
        await session.putHistoricalChanges(records);
        const historicalChanges = await session.getHistoricalChanges(current.identity.chatKey);
        await session.updateChatMetaSummary(current.identity.chatKey, {
          historicalCount: historicalChanges.length,
          historicalUpdatedAt: new Date().toISOString(),
        });
      } finally {
        session.close();
      }
    } catch (error) {
      console.error("[boxed-lllllabc] 历史楼层备份失败", error);
      return createBackupStatus("db-error", "备份不可用", error);
    }
  }

  async function prioritizeFullBackupStatus(chatKey, status) {
    const settings = getSettings();
    if (!settings.enabled || !settings.fullBackupEnabled) {
      return status;
    }

    try {
      const session = await storage.open();
      try {
        const meta = await session.getChatMeta(chatKey);
        return shouldPrioritizeFullBackupWarning({ meta, settings })
          ? createBackupStatus("full-frozen", "完整备份已暂停更新")
          : status;
      } finally {
        session.close();
      }
    } catch (error) {
      console.warn("[boxed-lllllabc] 读取完整备份状态失败", error);
      return status;
    }
  }

  async function needsFullBackupConfirmation(chatKey) {
    const settings = getSettings();
    if (!settings.enabled || !settings.fullBackupEnabled) {
      return false;
    }
    try {
      const session = await storage.open();
      try {
        const meta = await session.getChatMeta(chatKey);
        return meta?.fullBackupState === "awaiting-confirmation"
          || (meta?.fullBackupState === "frozen"
            && meta?.fullBackupIncident?.kind === "unexpected-message-change");
      } finally {
        session.close();
      }
    } catch (error) {
      console.warn("[boxed-lllllabc] 读取完整备份确认状态失败", error);
      return false;
    }
  }

  async function readCurrentPending(chatKey) {
    const session = await storage.open();
    try {
      return await session.getPendingChanges(chatKey);
    } finally {
      session.close();
    }
  }

  async function updateBackendMeta(chatKey, backendStatus, pending) {
    try {
      const summary = summarizePendingChanges(pending);
      const session = await storage.open();
      try {
        await session.updateChatMetaSummary(chatKey, {
          lastBackendStatus: backendStatus,
          lastBackendCheckedAt: new Date().toISOString(),
          pendingCount: summary.count,
          pendingFirstIndex: summary.firstIndex,
          pendingLastIndex: summary.lastIndex,
        });
      } finally {
        session.close();
      }
    } catch (error) {
      console.warn("[boxed-lllllabc] 酒馆保存状态摘要写入失败", error);
    }
  }

  function createDisplayStatus(code, text, detail = "", pending = []) {
    const summary = summarizePendingChanges(pending);
    return createBackupStatus(code, formatStatusText(text, summary.rangeText), detail);
  }

  return {
    confirmFullBackupAfterBackendVerification,
    createDisplayStatus,
    handleChatRenamed,
    needsFullBackupConfirmation,
    prioritizeFullBackupStatus,
    readCurrentPending,
    refreshFullBackup,
    refreshHistoricalBackup,
    runBackupNow,
    updateBackendMeta,
  };
}

export function dedupeHistoricalRecords(records) {
  const latestByFloor = new Map();
  for (const record of records) {
    latestByFloor.set(`${record.chatKey}:${record.messageIndex}`, record);
  }
  return [...latestByFloor.values()];
}

async function readStoredChatMeta(storage, chatKey) {
  const session = await storage.open();
  try {
    return await session.getChatMeta(chatKey);
  } finally {
    session.close();
  }
}
