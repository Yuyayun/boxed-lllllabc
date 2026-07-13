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
import {
  getChatMeta,
  getFullMessages,
  getHistoricalChanges,
  getPendingChanges,
  openBackupDatabase,
  putFullMessages,
  putHistoricalChanges,
  putPendingChanges,
  reconcileChatIdentity,
  replaceFullSnapshot,
  updateChatMetaSummary,
} from "../db/index.js";
import { formatStatusText } from "../ui/presentation.js";

export function createBackupCoordinator({
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
}) {
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
      const status = createDisplayStatus("disabled", "未启用");
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
      const db = await openBackupDatabase();
      try {
        const pendingRecords = triggerList.flatMap((item) => createPendingRecords({
          chat: current.chat,
          chatKey: current.identity.chatKey,
          eventName: item.eventName,
          args: item.args,
        }));

        await putPendingChanges(db, pendingRecords);
      } finally {
        db.close();
      }
    } catch (error) {
      console.error("[boxed-lllllabc] pending 写入失败", error);
      const status = createBackupStatus("db-error", "本地备份不可用", error);
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
        ? createDisplayStatus("checking", "保存中", "正在确认其他扩展写入的聊天数据。", pending)
      : pending.length
        ? createDisplayStatus("checking", "保存中", "", pending)
        : createDisplayStatus("saved", "后端已保存");
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
      const db = await openBackupDatabase();
      try {
        const [meta, messages] = await Promise.all([
          getChatMeta(db, current.identity.chatKey),
          getFullMessages(db, current.identity.chatKey),
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
            : createBackupStatus("full-frozen", "聊天内容疑似异常，完整备份已保留");
        }

        if (decision.action === "skip" || decision.action === "noop") {
          return null;
        }

        if (decision.action === "await-confirmation") {
          const incident = {
            ...decision.incident,
            notifiedAt: meta?.fullBackupIncident?.notifiedAt ?? new Date().toISOString(),
          };
          await updateChatMetaSummary(db, current.identity.chatKey, createFullBackupAwaitingMeta({
            identity: current.identity,
            currentMessages: decision.currentMessages,
            previousMeta: meta,
            reason,
            incident,
          }));
          return createBackupStatus(
            "full-awaiting-confirmation",
            "完整备份等待后端确认",
            "检测到其他扩展更新了已有楼层，确认后会安全接续。",
          );
        }

        if (decision.action === "freeze") {
          const incident = {
            ...decision.incident,
            notifiedAt: new Date().toISOString(),
          };
          await updateChatMetaSummary(db, current.identity.chatKey, createFullBackupMeta({
            identity: current.identity,
            messages,
            previousMeta: meta,
            reason,
            state: "frozen",
            incident,
          }));
          globalThis.toastr?.warning?.("聊天内容疑似异常缩短，完整备份已保留。", "箱装辣白菜");
          return createBackupStatus("full-frozen", "聊天内容疑似异常，完整备份已保留");
        }

        const nextMeta = createFullBackupMeta({
          identity: current.identity,
          messages: decision.currentMessages,
          previousMeta: meta,
          reason,
        });
        if (["create", "rebuild", "unfreeze", "reconcile"].includes(decision.action)) {
          await replaceFullSnapshot(db, {
            chatKey: current.identity.chatKey,
            messages: decision.currentMessages,
            meta: nextMeta,
          });
        } else {
          await putFullMessages(db, {
            chatKey: current.identity.chatKey,
            messages: decision.messages,
            meta: nextMeta,
          });
        }
        return null;
      } finally {
        db.close();
      }
    } catch (error) {
      console.error("[boxed-lllllabc] 完整聊天备份失败", error);
      return createBackupStatus("db-error", "本地备份不可用", error);
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
      const db = await openBackupDatabase();
      try {
        const result = await reconcileChatIdentity(db, identity);
        if (result.status === "conflict") {
          return createBackupStatus(
            "db-error",
            "本地备份不可用",
            "聊天身份接续时发现目标键已有备份，已停止写入以避免覆盖。",
          );
        }
        if (result.status === "ambiguous") {
          console.warn("[boxed-lllllabc] 找到多个可能属于当前聊天的旧备份，已保留旧记录并为当前聊天单独备份。");
        }
        return null;
      } finally {
        db.close();
      }
    } catch (error) {
      console.error("[boxed-lllllabc] 聊天身份接续失败", error);
      return createBackupStatus("db-error", "本地备份不可用", error);
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
      const db = await openBackupDatabase();
      try {
        await putHistoricalChanges(db, records);
        const historicalChanges = await getHistoricalChanges(db, current.identity.chatKey);
        await updateChatMetaSummary(db, current.identity.chatKey, {
          historicalCount: historicalChanges.length,
          historicalUpdatedAt: new Date().toISOString(),
        });
      } finally {
        db.close();
      }
    } catch (error) {
      console.error("[boxed-lllllabc] 历史楼层备份失败", error);
      return createBackupStatus("db-error", "本地备份不可用", error);
    }
  }

  async function prioritizeFullBackupStatus(chatKey, status) {
    const settings = getSettings();
    if (!settings.enabled || !settings.fullBackupEnabled) {
      return status;
    }

    try {
      const db = await openBackupDatabase();
      try {
        const meta = await getChatMeta(db, chatKey);
        return shouldPrioritizeFullBackupWarning({ meta, settings })
          ? createBackupStatus("full-frozen", "聊天内容疑似异常，完整备份已保留")
          : status;
      } finally {
        db.close();
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
      const db = await openBackupDatabase();
      try {
        const meta = await getChatMeta(db, chatKey);
        return meta?.fullBackupState === "awaiting-confirmation"
          || (meta?.fullBackupState === "frozen"
            && meta?.fullBackupIncident?.kind === "unexpected-message-change");
      } finally {
        db.close();
      }
    } catch (error) {
      console.warn("[boxed-lllllabc] 读取完整备份确认状态失败", error);
      return false;
    }
  }

  async function readCurrentPending(chatKey) {
    const db = await openBackupDatabase();
    try {
      return await getPendingChanges(db, chatKey);
    } finally {
      db.close();
    }
  }

  async function updateBackendMeta(chatKey, backendStatus, pending) {
    try {
      const summary = summarizePendingChanges(pending);
      const db = await openBackupDatabase();
      try {
        await updateChatMetaSummary(db, chatKey, {
          lastBackendStatus: backendStatus,
          lastBackendCheckedAt: new Date().toISOString(),
          pendingCount: summary.count,
          pendingFirstIndex: summary.firstIndex,
          pendingLastIndex: summary.lastIndex,
        });
      } finally {
        db.close();
      }
    } catch (error) {
      console.warn("[boxed-lllllabc] 后端状态摘要写入失败", error);
    }
  }

  function createDisplayStatus(code, text, detail = "", pending = []) {
    const summary = summarizePendingChanges(pending);
    return createBackupStatus(code, formatStatusText(text, summary.rangeText), detail);
  }

  return {
    confirmFullBackupAfterBackendVerification,
    createDisplayStatus,
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
