import { refreshRecentBackup } from "../backup/recent.js";
import { executeRestorePlan } from "../backup/restore-executor.js";
import {
  createHistoricalRestorePlan,
  createFullRestorePlan,
  createPendingRestorePlan,
  selectPendingRestoreBranch,
  validateRestorePlan,
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
import { openLegacyBranchDialog } from '../ui/legacy-branch-dialog.js';
import { openRecoveryCenterDialog } from "../ui/recovery-center-dialog.js";
import { openSaveRequestDialog } from "../ui/save-request-dialog.js";
import { readBackupRecords, readBackupBundle, writeBackupRecords } from '../storage/backup-batches.js';
import { backupFailureStatus } from '../backup/failure-status.js';
import { protectPendingRecord } from '../backup/pending-protection.js';
import { summarizePendingChanges } from '../backup/pending.js';
import { pendingRecordFingerprint,warmPendingRecords } from '../backup/pending-journal.js';
import { nativeChatHash, sha256Text,warmNativeChat,nativeMessageText } from '../backup/native-content.js';
import {recordRecoverySafely,newRecoveryLogId} from '../storage/recovery-log.js';

export function createRestoreController({
  storage = defaultBackupStorage,
  runGuard = (operation) => operation(),
  getContextReader,
  getSettings = () => ({}),
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
  openSaveDialog = openSaveRequestDialog,
  saveChatSnapshot,
  getSourceEpoch = ()=>0,
  onRestored = ()=>{},
  preparePreview=async()=>{},
  recordRecovery=()=>{},
}) {
  function evidenceHash(plan,bundle) {
    return sha256Text(JSON.stringify((plan.evidenceStores??[]).map(store=>[store,(bundle[store]??[])
      .filter(row=>plan.source==='historical'?row.messageIndex===plan.replacements[0]?.messageIndex:plan.source==='recent'?plan.appends.some(item=>item.messageIndex===row.messageIndex):true)
      .map(row=>[row.messageIndex,pendingRecordFingerprint(row)])])));
  }
  const needsLegacyEvidence=rows=>rows.some(row=>!row.pendingFormat&&!Number.isInteger(row.messageIndex));
  function createRestoreUiState({ current, messages, fullMessages, historicalChanges, pending, meta, summary }) {
    if (summary) {
      const mode = storage.getMode?.();
      const load = async (action, argument) => {
        let session;
        try {
          await preparePreview();
          const fresh = getContextReader().readCurrentChat();
          if (!fresh.ok || fresh.identity.chatKey !== current.identity.chatKey || storage.getMode?.() !== mode) throw new Error('聊天或备份位置已经变化，请重新打开面板。');
          session = await storage.open();
          await warmNativeChat(fresh.chat);
          const full = action === 'onPreviewFull' || action === 'onOpenRecovery';
          const historical = action === 'onPreviewHistorical' || action === 'onOpenRecovery';
          const recent = action === 'onPreviewRecent' || action === 'onOpenRecovery';
          const stores = ['pending_changes', ...(full ? ['full_messages'] : []), ...(historical ? ['historical_changes'] : []), ...(recent ? ['recent_messages'] : [])];
          let { records, summary: state } = await readBackupBundle(session, fresh.identity.chatKey, stores);
          if(action==='onPreviewPending'&&(needsLegacyEvidence(records.pending_changes)||createPendingRestorePlan({chat:fresh.chat,chatKey:fresh.identity.chatKey,pending:records.pending_changes}).blockedReason)) {
            ({records,summary:state}=await readBackupBundle(session,fresh.identity.chatKey,['pending_changes','recent_messages','full_messages','historical_changes']));
          }
          const loadedPending = records.pending_changes, loadedFull = records.full_messages ?? [], loadedHistorical = records.historical_changes ?? [], loadedRecent = records.recent_messages ?? [];
          await warmNativeChat([...loadedPending.map(row=>row.raw??row.message?.raw),...loadedFull.map(row=>row.raw),...loadedHistorical.map(row=>row.message?.raw),...loadedRecent.map(row=>row.raw)].filter(Boolean));
          await warmPendingRecords(loadedPending);
          const latest=getContextReader().readCurrentChat();
          if(!latest.ok||latest.identity.chatKey!==fresh.identity.chatKey||storage.getMode?.()!==mode)throw new Error('读取备份期间聊天或存储位置发生变化，请重新打开恢复。');
          const ui = createRestoreUiState({ current: fresh, messages: loadedRecent, fullMessages: loadedFull, historicalChanges: loadedHistorical, pending: loadedPending, meta: state.meta ?? meta });
          return ui[action]?.(argument);
        } catch (error) { const status = backupFailureStatus(error, '读取'); if (status.code === 'db-error') setStatus(status); globalThis.toastr?.error?.(status.detail, '箱装辣白菜'); return { ok: false, reason: status.detail }; }
        finally { session?.close?.(); }
      };
      return { fullPlan: { totalCount: summary.counts.full_messages }, recentOptions: createRecentRestoreOptions({ chat: current.chat, recent: messages }), disabledReason: getSettings().enabled ? '' : '请先启用备份，再执行恢复或请求酒馆保存。',
        onRequestSave: getSettings().enabled ? () => load('onRequestSave') : undefined,
        onOpenRecovery: () => load('onOpenRecovery'), onPreviewFull: () => load('onPreviewFull'),
        onPreviewRecent: index => load('onPreviewRecent', index), onPreviewHistorical: index => load('onPreviewHistorical', index), onPreviewPending: () => load('onPreviewPending') };
    }
    let pendingPlan = createPendingRestorePlan({
      chat: current.chat,
      chatKey: current.identity.chatKey,
      pending,
      chatIntegrity:current.identity.meta?.chatIntegrity,
    });
    let pendingEvidence=[];
    if(needsLegacyEvidence(pending)||pendingPlan.blockedReason) {
      pendingPlan=createPendingRestorePlan({chat:current.chat,chatKey:current.identity.chatKey,pending,recent:messages,full:fullMessages,historical:historicalChanges,chatIntegrity:current.identity.meta?.chatIntegrity});
      pendingEvidence=['recent_messages','full_messages','historical_changes'];
    }
    pendingPlan.storageMode=storage.getMode?.();pendingPlan.evidenceStores=pendingEvidence;
    pendingPlan.baseEvidenceHash=evidenceHash(pendingPlan,{recent_messages:messages,full_messages:fullMessages,historical_changes:historicalChanges});
    if(pendingPlan.targetMetadata)pendingPlan.baseMetadataHash=sha256Text(nativeMessageText(current.context?.chatMetadata??{}));
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
    fullPlan.storageMode=storage.getMode?.();fullPlan.evidenceStores=['full_messages'];
    fullPlan.baseEvidenceHash=evidenceHash(fullPlan,{full_messages:fullMessages});
    const saveRequestPlan = createSaveRequestPlan({
      chat: current.chat,
      chatKey: current.identity.chatKey,
      pending,
    });
    const disabledReason = getSettings().enabled ? "" : "请先启用备份，再执行恢复或请求酒馆保存。";

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
        return showRestorePreview({ plan, current, meta,evidence:{recent_messages:messages} });
      },
      onPreviewHistorical: (messageIndex) => {
        const plan = createHistoricalRestorePlan({
          chat: current.chat,
          chatKey: current.identity.chatKey,
          historical: historicalChanges,
          pending,
          messageIndex,
        });
        return showRestorePreview({ plan, current, meta,evidence:{historical_changes:historicalChanges} });
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
        pendingCount: summarizePendingChanges(pending).count,
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
        return showRestorePreview({ plan, current, meta,evidence:{recent_messages:messages} });
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
        return showRestorePreview({ plan, current, meta,evidence:{historical_changes:historicalChanges} });
      },
    });
  }

  function showSaveRequestDialog({ plan, pending, meta }) {
    const chatName = buildVisibleChatSummary(meta)[0]?.value || "当前聊天";
    openSaveDialog({
      plan,
      chatName,
      pending,
      onConfirm: (confirmedPlan) => requestSave(confirmedPlan),
    });
  }

  function showRestorePreview({ plan, current, meta,evidence }) {
    if(evidence){plan.evidenceStores=Object.keys(evidence);plan.baseEvidenceHash=evidenceHash(plan,evidence);}
    plan.storageMode??=storage.getMode?.();
    plan.baseIntegrity??=current.identity.meta?.chatIntegrity;
    if(plan.selectionRequired){
      openLegacyBranchDialog({plan,onSelect:async (id,active=()=>true)=>{
        const selected=selectPendingRestoreBranch(plan,id);
        if(!selected)return {ok:false,reason:'请选择要恢复的完整聊天内容。'};
        const pending=await readCurrentPending(plan.chatKey),live=getContextReader().readCurrentChat();
        if(!active())return {ok:false,cancelled:true};
        if(!live.ok||storage.getMode?.()!==plan.storageMode)return {ok:false,reason:'聊天或备份位置已经变化，请重新预览。'};
        if(selected.baseIntegrity!==undefined&&live.identity.meta?.chatIntegrity!==selected.baseIntegrity)return {ok:false,reason:'聊天文件身份已经变化，请重新预览。'};
        const checked=validateRestorePlan({plan:selected,chat:live.chat,chatKey:live.identity.chatKey,pending});
        if(!checked.ok)return checked;
        if(selected.targetMetadata)selected.baseMetadataHash=sha256Text(nativeMessageText(live.context?.chatMetadata??{}));
        return showRestorePreview({plan:selected,current:live,meta});
      }});
      return {ok:true};
    }
    if (plan.blockedReason) {
      plan.previewLogId??=newRecoveryLogId();
      recordRecoverySafely(recordRecovery,{chatKey:plan.chatKey,recoveryId:plan.previewLogId,recoverySource:plan.source,stage:'restore-blocked',errorCode:plan.blockedCode??'restore-preview-unavailable'});
      globalThis.toastr?.warning?.(plan.blockedReason, "箱装辣白菜");
      return {ok:false,reason:plan.blockedReason};
    }
    plan.storageMode??=storage.getMode?.();
    plan.baseIntegrity??=current.identity.meta?.chatIntegrity;

    const chatName = buildVisibleChatSummary(meta)[0]?.value || "当前聊天";
    openRestoreDialog({
      plan,
      chatName,
      currentChat: current.chat,
      onConfirm: (confirmedPlan) => confirmRestore(confirmedPlan),
    });
    return {ok:true};
  }

  const confirmRestore = (plan) => runGuard(() => confirmRestoreImpl(plan)).catch((error) => ({ ok: false, reason: error.message }));
  async function confirmRestoreImpl(plan) {
    const contextReader = getContextReader();
    const sourceEpoch=getSourceEpoch();
    const readCurrent=()=>{
      if(plan.storageMode!==undefined&&storage.getMode?.()!==plan.storageMode)return {ok:false,reason:'备份位置已经变化，请重新预览。'};
      const live=contextReader.readCurrentChat();
      if(live.ok&&plan.baseIntegrity!==undefined&&live.identity.meta?.chatIntegrity!==plan.baseIntegrity)return {ok:false,reason:'聊天文件身份已经变化，请重新预览，保护记录已保留。'};
      return live;
    };
    let pendingSummary,recoveryId;
    const result = await executeRestorePlan({
      plan,
      readCurrent,
      afterApply:onRestored,
      beforeApply: async()=>{
        if(plan.targetMetadata) {
          const metadata=readCurrent().context?.chatMetadata??{};
          if(sha256Text(nativeMessageText(metadata))!==plan.baseMetadataHash||metadata.integrity!==plan.targetMetadata.integrity)throw new Error('聊天设置或文件身份已经变化，请重新预览，保护记录已保留。');
        }
        if(!plan.evidenceStores?.length)return;
        const session=await storage.open();
        try {
          const bundle={};
          if(session.capabilities?.boundedBackup)Object.assign(bundle,(await readBackupBundle(session,plan.chatKey,plan.evidenceStores)).records);
          else for(const store of plan.evidenceStores)bundle[store]=await readBackupRecords(session,plan.chatKey,store);
          if(evidenceHash(plan,bundle)!==plan.baseEvidenceHash)throw new Error('参与恢复的备份已经变化，请重新预览。');
        } finally {session.close();}
      },
      readPending: async chatKey => {
        if (plan.source !== 'full') return readCurrentPending(chatKey);
        const session = await storage.open();
        try { pendingSummary = session.capabilities?.boundedBackup ? await session.getBackupSummary(chatKey) : undefined; return await readBackupRecords(session, chatKey, 'pending_changes', { summary: pendingSummary }); }
        finally { session.close(); }
      },
      writePending: async (records) => {
        const root=records.find(row=>row.pendingType==='operation');recoveryId=root?.operationId;
        if(recoveryId)recordRecoverySafely(recordRecovery,{chatKey:plan.chatKey,recoveryId,recoverySource:plan.source,stage:'restore-started',targetCount:root.afterLength,selectedOption:plan.selectedBranchNumber,candidateCount:plan.candidateCount});
        const session = await storage.open();
        try {
          await writeBackupRecords(session, { chatKey: plan.chatKey, store: 'pending_changes', rows: records.map(record => protectPendingRecord(record, getSettings(), record.afterLength??readCurrent().chat?.length??0)),
            sourceUnchanged:()=>{const live=readCurrent();return live.ok&&live.identity.chatKey===plan.chatKey&&getSourceEpoch()===sourceEpoch;},
            validateSource:()=>{const live=readCurrent();return live.ok&&nativeChatHash(live.chat)===plan.baseNativeHash;} });
        } finally {
          session.close();
        }
      },
      render: renderRestoredMessages,
      save: async ({ current }) => {
        if(saveChatSnapshot)return waitForSave({save:()=>saveChatSnapshot({current:readCurrent(),shouldContinue:()=>{const live=readCurrent();return live.ok&&live.identity.chatKey===plan.chatKey&&live.chat===current.chat;}}),timeoutMs:saveRequestTimeoutMs});
        if (typeof current.context?.saveChat !== "function") {
          throw new Error("当前酒馆版本没有提供聊天保存接口。");
        }
        return waitForSave({
          save: () => current.context.saveChat(),
          timeoutMs: saveRequestTimeoutMs,
        });
      },
    });

    recoveryId??=newRecoveryLogId();
    recordRecoverySafely(recordRecovery,{chatKey:plan.chatKey,recoveryId,recoverySource:plan.source,stage:result.ok?'restore-submitted':result.changed?'restore-failed':'restore-blocked',
      ...(result.ok?result.saveOutcome?.status==='timeout'?{errorCode:'restore-save-pending'}:{}:{errorCode:({pending:'restore-protection-failed',render:'restore-render-failed',save:'restore-save-unconfirmed'})[result.stage]??'restore-source-changed'})});

    if (result.changed) {
      onRestored();
      const restored = contextReader.readCurrentChat();
      if (restored.ok && restored.identity.chatKey === plan.chatKey) {
        await refreshBackupsAfterRestore({ current: restored, plan });
        const pending = await readCurrentPending(plan.chatKey);
        setStatus(createDisplayStatus("checking", "正在检查保存状态", "", pending));
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

    if (!saveChatSnapshot && typeof current.context?.saveChat !== "function") {
      const reason = "当前酒馆版本没有提供聊天保存接口。";
      globalThis.toastr?.error?.(reason, "箱装辣白菜");
      return { ok: false, reason };
    }

    const saveNativeHash=nativeChatHash(current.chat),saveMode=storage.getMode?.();
    const saveOutcome = await waitForSave({
      save: () => saveChatSnapshot ? saveChatSnapshot({current,shouldContinue:()=>{const live=getContextReader().readCurrentChat();return live.ok&&storage.getMode?.()===saveMode&&live.identity.chatKey===plan.chatKey&&live.chat===current.chat&&nativeChatHash(live.chat)===saveNativeHash;}}) : current.context.saveChat(),
      timeoutMs: saveRequestTimeoutMs,
    });
    if (!saveOutcome.ok) {
      setStatus(createDisplayStatus("unconfirmed", "酒馆保存待确认", saveOutcome.reason, pending));
      await refreshVisiblePanel();
      globalThis.toastr?.error?.("重新请求酒馆保存失败，未保存变更仍会保留。", "箱装辣白菜");
      return { ok: false, reason: saveOutcome.reason };
    }

    const latestPending = await readCurrentPending(plan.chatKey);
    setStatus(createDisplayStatus("checking", "正在检查保存状态", "", latestPending));
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
        : "已请求酒馆保存，正在检查结果。",
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
  const withoutExtra=current.chat.filter(message=>!Object.hasOwn(message,'extra'));
  try {await renderNativeRestoredMessages({current,plan});}
  finally {
    // Native redraw initializes a missing extra to {} even when it has no
    // content. Keep the protected JSON exact; never discard populated fields.
    for(const message of withoutExtra)if(message.extra&&typeof message.extra==='object'&&!Array.isArray(message.extra)&&Object.keys(message.extra).length===0)delete message.extra;
  }
}

async function renderNativeRestoredMessages({ current, plan }) {
  const context = current.context ?? {};
  if(plan.targetMetadata) {
    if(typeof context.updateChatMetadata!=='function')throw new Error('当前酒馆无法恢复聊天设置，保护记录已保留。');
    context.updateChatMetadata(structuredClone(plan.targetMetadata),true);
  }
  if (plan.source==='full'||Array.isArray(plan.targetChat)) {
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
