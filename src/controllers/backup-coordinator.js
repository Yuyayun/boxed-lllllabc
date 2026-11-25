import {
  createFullBackupAwaitingMeta,
  createFullBackupDecision,
  createFullBackupMeta,
  shouldPrioritizeFullBackupWarning,
} from "../backup/full.js";
import { hashCanonicalChat } from "../backup/canonicalize.js";
import { createHistoricalRecord } from "../backup/historical.js";
import { createPendingRecords, summarizePendingChanges } from "../backup/pending.js";
import { createPendingObserver } from '../backup/pending-journal.js';
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
import { formatPendingStatusText } from '../ui/pending-status-text.js';
import { readBackendChat } from "../verifier/backend-reader.js";
import { refreshBoundedFullBackup } from '../backup/full-bounded.js';
import { readBackupRecords, writeBackupRecords, backupBatches, backupFailure } from '../storage/backup-batches.js';
import { backupFailureStatus } from '../backup/failure-status.js';
import { protectPendingRecord, pendingRepairTriggers } from '../backup/pending-protection.js';
import { hashCanonicalMessage } from '../backup/canonicalize.js';

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
  prepareBackup = async () => {},
}) {
  let legacyRenameObservation = null;
  const fullViews = new Map();
  const backupProblems = new Map();
  const backupRepairs = new Map();
  let sourceEpoch = 0, queuedBackup = Promise.resolve();
  const observer=createPendingObserver({readCurrent:()=>getContextReader().readCurrentChat(),deferHashes:true});
  const unwrittenCaptures=new Set();
  async function persistCapturedTriggers(triggers) {
    const settings=getSettings();
    if(!settings.enabled)return;
    const groups=new Map();
    for(const trigger of [...[...unwrittenCaptures].map(capture=>({capture})),...triggers]) {
      if(trigger.captureFailure)throw new Error(`无法捕获这次聊天改动：${trigger.captureFailure}`);
      const captured=trigger.capture;
      if(!captured?.records.length||captured.persisted)continue;
      await captured.ready;
      if(!groups.has(captured.chatKey))groups.set(captured.chatKey,[]);
      if(!groups.get(captured.chatKey).includes(captured))groups.get(captured.chatKey).push(captured);
    }
    for(const [chatKey,captures] of groups) {
      const session=await storage.open();
      try {
        await session.reconcileChatIdentity(captures[0].identity);
        const rows=captures.flatMap(capture=>capture.records.map(row=>protectPendingRecord(row,settings,
          capture.records.find(record=>record.pendingType==='operation')?.afterLength??row.chatLength??0)));
        await writeBackupRecords(session,{chatKey,store:'pending_changes',rows});
        captures.forEach(capture=>{capture.persisted=true;unwrittenCaptures.delete(capture);});
      } finally {session.close();}
    }
  }
  function runBackupNow(trigger = {}) {
    const run = queuedBackup.then(() => runBackupNowImpl(trigger));
    queuedBackup = run.catch(() => {}); return run;
  }

  function captureSettledState() {
    const capture=observer.settle();
    if(capture.records.length)unwrittenCaptures.add(capture);
    return {eventName:'message_updated',args:[],capture};
  }

  async function preparePendingVerification({chatKey,shouldContinue=()=>true}) {
    const current=getContextReader().readCurrentChat();
    if(!getSettings().enabled||!shouldContinue()||!current.ok||current.identity.chatKey!==chatKey)return;
    await persistCapturedTriggers([captureSettledState()]);
  }

  async function runBackupNowImpl(trigger = {}) {
    const eventName = typeof trigger === "string" ? trigger : trigger.eventName || "manual";
    const args = typeof trigger === "string" ? [] : trigger.args || [];
    const verifyNow = typeof trigger === "object" && Boolean(trigger.verifyNow);
    let triggerList = typeof trigger === "object" && Array.isArray(trigger.triggers) && trigger.triggers.length
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

    await prepareBackup();
    try { if(triggerList.some(item=>item.capture))triggerList=[...triggerList,captureSettledState()];await persistCapturedTriggers(triggerList); }
    catch(error) {const status=backupFailureStatus(error);setStatus(status);await refreshVisiblePanel();return status;}
    const contextReader = getContextReader();
    const current = contextReader.readCurrentChat();
    if (!current.ok) {
      const status = createBackupStatus("identity-missing", "无法识别当前聊天", current.reason);
      setStatus(status);
      await refreshVisiblePanel();
      return status;
    }
    if(!triggerList.some(item=>item.capture))observer.reset(current);
    triggerList=triggerList.filter(item=>!item.capture||item.capture.chatKey===current.identity.chatKey);
    if(!triggerList.length)triggerList=[{eventName:'chat_loaded',args:[]}];

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

    const failures = [];
    let pendingForBackup = [];

    try {
      const session = await storage.open();
      try {
        const pendingRecords = triggerList.filter(item=>!item.capture).flatMap((item) => createPendingRecords({
          chat: current.chat,
          chatKey: current.identity.chatKey,
          eventName: item.eventName,
          args: item.args,
        }));

        const records = [...new Map(pendingRecords.map(row => [row.id, protectPendingRecord(row, settings, current.chat.length)])).values()];
        pendingForBackup = records;
        if (records.length) await writeBackupRecords(session, { chatKey: current.identity.chatKey, store: 'pending_changes', rows: records });
        if (session.capabilities?.boundedBackup || typeof session.getPendingChanges === 'function') {
          pendingForBackup = await readBackupRecords(session, current.identity.chatKey, 'pending_changes');
        }
      } finally {
        session.close();
      }
    } catch (error) {
      console.error("[boxed-lllllabc] pending 写入失败", error);
      failures.push(backupFailureStatus(error));
    }

    const historicalTriggers = [...triggerList, ...pendingRepairTriggers(pendingForBackup, current, settings, { historicalOnly: true })];
    triggerList = [...triggerList, ...pendingRepairTriggers(pendingForBackup, current, settings)];
    const historicalStatus = await refreshHistoricalBackup({
      current,
      settings,
      triggers: historicalTriggers,
    });
    if (historicalStatus) failures.push(historicalStatus);

    if (settings.recentBackupEnabled) {
      const recentStatus = await refreshRecentBackup({
        storage,
        contextReader,
        settings,
        reason: eventName,
        triggers: triggerList,
      });

      if (['db-error','backup-update-failed'].includes(recentStatus.code)) failures.push(recentStatus);
    }

    const fullStatus = await refreshFullBackup({ current, settings, triggers: triggerList, reason: eventName, pendingRecords: pendingForBackup });
    if (['db-error','backup-update-failed'].includes(fullStatus?.code)) failures.push(fullStatus);
    if (failures.length) {
      backupProblems.set(current.identity.chatKey, failures[0]); setStatus(failures[0]);
      backupRepairs.set(current.identity.chatKey, pendingForBackup);
      if (pendingForBackup.length) scheduleBackendVerification?.(current.identity.chatKey, settings.backendVerifyDelayMs, 0);
      await refreshVisiblePanel(); return failures[0];
    }
    backupProblems.delete(current.identity.chatKey);
    backupRepairs.delete(current.identity.chatKey);
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

  async function refreshFullBackup({ current, settings, triggers, reason, backendConfirmed = false, pendingRecords = [] }) {
    if (!settings.enabled || !settings.fullBackupEnabled) {
      return null;
    }

    try {
      const session = await storage.open();
      try {
        if (session.capabilities?.boundedBackup) {
          const structural = pendingRecords.find(record => !Number.isInteger(record.messageIndex) && record.backupTargets?.includes('full_messages'));
          const sourceChatHash = backendConfirmed ? hashCanonicalChat(current.chat) : structural && hashCanonicalChat(current.chat) === structural.canonicalChatHash ? structural.canonicalChatHash : null;
          const result = await refreshBoundedFullBackup({ session, current, settings, triggers, reason, backendConfirmed, sourceChatHash, views: fullViews, readCurrent: () => getContextReader().readCurrentChat(), epoch: () => sourceEpoch });
          return result ? createBackupStatus(result.code, result.shortText, result.detail ?? '') : null;
        }
        const meta = await session.getChatMeta(current.identity.chatKey);
        if (session.capabilities && !session.capabilities.boundedBackup && ((meta?.fullBackupMessageCount ?? 0) > 200 || backupBatches(current.chat).length > 1)) throw backupFailure('服务器备份插件需要更新，才能分批处理此聊天。', 'backup-upgrade-required');
        const messages = await session.getFullMessages(current.identity.chatKey);
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
          await writeBackupRecords(session, { chatKey: current.identity.chatKey, store: 'full_messages', rows: decision.currentMessages, meta: nextMeta, replace: true });
        } else {
          await writeBackupRecords(session, { chatKey: current.identity.chatKey, store: 'full_messages', rows: decision.messages, meta: nextMeta });
        }
        return null;
      } finally {
        session.close();
      }
    } catch (error) {
      fullViews.delete(current.identity.chatKey);
      console.error("[boxed-lllllabc] 完整聊天备份失败", error);
      return backupFailureStatus(error);
    }
  }

  async function confirmFullBackupAfterBackendVerification({ current }) {
    const pendingRecords = await readCurrentPending(current.identity.chatKey);
    return refreshFullBackup({
      current,
      settings: getSettings(),
      triggers: [{ eventName: "backend-confirmed", args: [] }],
      reason: "backend-confirmed",
      backendConfirmed: true,
      pendingRecords,
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
        await writeBackupRecords(session, { chatKey: current.identity.chatKey, store: 'historical_changes', rows: records, sourceUnchanged: () => {
          const live = getContextReader().readCurrentChat();
          return live.ok && live.identity.chatKey === current.identity.chatKey && records.every(record => hashCanonicalMessage(live.chat[record.messageIndex]) === record.canonicalHash);
        } });
        if (session.capabilities?.boundedBackup) return;
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
      return backupFailureStatus(error);
    }
  }

  async function ensurePendingBackups({ current, records, shouldContinue = () => true }) {
    const live = getContextReader().readCurrentChat(), settings = getSettings();
    if (!shouldContinue() || !live.ok || live.identity.chatKey !== current.identity.chatKey) return createDisplayStatus('checking', '备份正在补全');
    records = [...new Map([...(backupRepairs.get(live.identity.chatKey) ?? []), ...records].map(record => [record.id, record])).values()];
    if (records.some(record => Number.isInteger(record.messageIndex) && hashCanonicalMessage(live.chat[record.messageIndex]) !== record.canonicalHash)) return createDisplayStatus('checking', '聊天已变化，等待接续备份');
    if (records.some(record => record.backupTargets?.some(target => target === 'full_messages' && !settings.fullBackupEnabled || target === 'historical_changes' && !settings.historicalBackupEnabled))) return createDisplayStatus('checking', '备份已暂停，保护记录仍保留');
    const triggers = pendingRepairTriggers(records, live, settings);
    const historical = await refreshHistoricalBackup({ current: live, settings, triggers: pendingRepairTriggers(records, live, settings, { historicalOnly: true }) });
    if (historical) return historical;
    if (!shouldContinue()) return createDisplayStatus('checking', '备份正在补全');
    const full = await refreshFullBackup({ current: live, settings, triggers, reason: 'pending-backup-repair', pendingRecords: records });
    if (full) return full;
    if (settings.recentBackupEnabled) {
      const recent = await refreshRecentBackup({ storage, contextReader: getContextReader(), settings, triggers, reason: 'pending-backup-repair' });
      if (['db-error', 'backup-update-failed'].includes(recent.code)) return recent;
    }
    if (shouldContinue()) { backupProblems.delete(live.identity.chatKey); backupRepairs.delete(live.identity.chatKey); }
    return null;
  }

  async function prioritizeFullBackupStatus(chatKey, status) {
    if (backupProblems.has(chatKey)) return backupProblems.get(chatKey);
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
      return await readBackupRecords(session, chatKey, 'pending_changes');
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
    return createBackupStatus(code, formatPendingStatusText(text, pending) ?? formatStatusText(text, summary.rangeText), detail);
  }

  return {
    preparePendingVerification,
    ensurePendingBackups,
    hasBackupProblem: chatKey => backupProblems.has(chatKey),
    onPendingBackupsConfirmed(records) {
      if (records.length && records.every(record => Number.isInteger(record.messageIndex) && Array.isArray(record.backupTargets))) { backupProblems.delete(records[0].chatKey); backupRepairs.delete(records[0].chatKey); }
    },
    noteSourceChange() { sourceEpoch++; },
    getSourceEpoch: ()=>sourceEpoch,
    captureTrigger: trigger=>{
      if(!getSettings().enabled){observer.reset();return {records:[],chatKey:null};}
      const captured=observer.capture(trigger);if(captured.records.length)unwrittenCaptures.add(captured);return captured;
    },
    resetObservation: ()=>observer.reset(),
    persistCapturedTriggers,
    whenIdle: ()=>queuedBackup,
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
