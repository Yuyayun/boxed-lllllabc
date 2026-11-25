import { defaultBackupStorage } from "../storage/service.js";
import { hashCanonicalChat, stripChatHeader } from "../backup/canonicalize.js";
import { readBackendChat } from "../verifier/backend-reader.js";
import { backupBatches } from '../storage/backup-batches.js';
import { comparePendingWithBackend } from "../verifier/compare.js";
import { nativeChatHash,warmNativeChat } from '../backup/native-content.js';
import { warmPendingRecords } from '../backup/pending-journal.js';
import { confirmSnapshotPending } from "../snapshots/confirmation.js";
import {recordRecoverySafely} from '../storage/recovery-log.js';

export function createBackendVerifier({
  storage = defaultBackupStorage,
  getContextReader,
  getSettings,
  getLatestStatus,
  setStatus,
  refreshVisiblePanel,
  prioritizeFullBackupStatus,
  readCurrentPending,
  updateBackendMeta,
  createDisplayStatus,
  confirmFullBackup = async () => null,
  ensurePendingBackups = async () => null,
  onPendingBackupsConfirmed = async () => {},
  hasBackupProblem = () => false,
  needsFullBackupConfirmation = async () => false,
  readBackend = readBackendChat,
  deleteConfirmedPending = (records, shouldDelete, signal) => deleteConfirmedPendingRecords(storage, records, shouldDelete, signal),
  retryDelays = [2000, 5000, 10000],
  AbortControllerImpl = globalThis.AbortController,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  recordRecovery=()=>{},
  preparePendingVerification=async()=>{},
  isGenerating=()=>false,
}) {
  let verifyTimer = null;
  let verifyRunId = 0;
  let activeRequest = null;
  let operationController = null;
  let effectQueue = Promise.resolve();

  function scheduleBackendVerification(chatKey, delayMs, retryIndex) {
    const runId = beginVerificationRun();
    scheduleVerificationForRun({ type: "pending", chatKey, delayMs, retryIndex, runId });
  }

  function scheduleBackendSnapshotVerification(chatKey, expectedChatHash, delayMs, retryIndex) {
    const runId = beginVerificationRun();
    scheduleVerificationForRun({
      type: "snapshot",
      chatKey,
      expectedChatHash,
      delayMs,
      retryIndex,
      runId,
    });
  }

  function scheduleVerificationForRun({
    type,
    chatKey,
    expectedChatHash,
    delayMs,
    retryIndex,
    runId,
  }) {
    clearVerificationTimer();
    if (!isCurrentRun(runId)) {
      return;
    }
    verifyTimer = setTimer(async () => {
      verifyTimer = null;
      if (!isCurrentRun(runId)) {
        return;
      }
      try {
        if (type === "snapshot") await runSnapshotVerification({ chatKey, expectedChatHash, retryIndex, runId });
        else await runPendingVerification({ chatKey, retryIndex, runId });
      } catch (error) {
        if (!isCurrentRun(runId) || isAbortError(error)) return;
        console.warn('[boxed-lllllabc] 核对前读取保护记录失败，已保留原保存状态和保护记录', error);
        if (retryIndex < retryDelays.length) scheduleVerificationForRun({ type, chatKey, expectedChatHash, retryIndex: retryIndex + 1, delayMs: retryDelays[retryIndex], runId });
      }
    }, delayMs);
  }

  function clearScheduledVerification() {
    clearVerificationTimer();
    verifyRunId += 1;
    abortActiveRequest();
    operationController?.abort?.();
    operationController = null;
  }

  function beginVerificationRun() {
    clearScheduledVerification();
    operationController = typeof AbortControllerImpl === "function" ? new AbortControllerImpl() : null;
    return verifyRunId;
  }

  function clearVerificationTimer() {
    if (verifyTimer !== null) {
      clearTimer(verifyTimer);
      verifyTimer = null;
    }
  }

  function abortActiveRequest() {
    activeRequest?.controller?.abort?.();
    activeRequest = null;
  }

  function isCurrentRun(runId) {
    return runId === verifyRunId;
  }

  function latestStatus() {
    return getLatestStatus();
  }

  function verifyBackendNow({ chatKey, retryIndex = 0 }) {
    return runPendingVerification({ chatKey, retryIndex, runId: beginVerificationRun() });
  }

  function verifyBackendSnapshotNow({ chatKey, expectedChatHash, retryIndex = 0 }) {
    return runSnapshotVerification({
      chatKey,
      expectedChatHash,
      retryIndex,
      runId: beginVerificationRun(),
    });
  }

  async function runPendingVerification({ chatKey, retryIndex, runId }) {
    const settings = getSettings();
    if (!settings.enabled) {
      const status = createDisplayStatus("disabled", "备份未启用");
      return publishStatus(runId, { status, refresh: true });
    }

    let current = getContextReader().readCurrentChat();
    if (!current.ok || current.identity.chatKey !== chatKey || !isCurrentRun(runId)) {
      return latestStatus();
    }

    const integrity=current.identity.meta?.chatIntegrity;
    await enqueueEffect(runId,()=>preparePendingVerification({chatKey,shouldContinue:()=>isCurrentRun(runId)}));
    if(!isCurrentRun(runId))return latestStatus();
    current=getContextReader().readCurrentChat();
    if(!current.ok||current.identity.chatKey!==chatKey||current.identity.meta?.chatIntegrity!==integrity)return latestStatus();
    const pending = await readCurrentPending(chatKey);
    await warmPendingRecords(pending);
    await warmNativeChat(pending.map(row=>row.raw??row.message?.raw).filter(Boolean));
    if (!isCurrentRun(runId)) {
      return latestStatus();
    }
    if (!pending.length) {
      if (hasBackupProblem(chatKey)) {
        const repair = await enqueueEffect(runId, () => ensurePendingBackups({ current, records: [], shouldContinue: () => isCurrentRun(runId) }));
        if (!repair.applied || !isCurrentRun(runId)) return latestStatus();
        if (repair.value?.code) return publishBackupFailure(runId, chatKey, retryIndex, repair.value);
        return runSnapshotVerification({ chatKey, expectedChatHash: hashCanonicalChat(current.chat), retryIndex, runId });
      }
      const needsConfirmation = await needsFullBackupConfirmation(chatKey);
      if (!isCurrentRun(runId)) {
        return latestStatus();
      }
      if (!needsConfirmation) {
        const requestedStatus = createDisplayStatus("saved", "酒馆聊天已保存");
        const status = await prioritizeFullBackupStatus(chatKey, requestedStatus);
        return publishStatus(runId, {
          status,
          meta: { chatKey, outcome: "saved", pending: [] },
          refresh: true,
        });
      }
      return runSnapshotVerification({
        chatKey,
        expectedChatHash: hashCanonicalChat(current.chat),
        retryIndex,
        runId,
      });
    }

    const hasJournal=pending.some(row=>row.pendingFormat);
    if(hasJournal&&isGenerating())return handleVerificationPending({chatKey,pending,retryIndex,runId,
      detail:'生成尚未结束，操作记录继续保留，结束后再核对保存。'});
    const finalHash=hasJournal?nativeChatHash(current.chat):null;
    const targetUnchanged=()=>{
      if(!isCurrentRun(runId))return false;
      if(!finalHash)return true;
      if(isGenerating())return false;
      const live=getContextReader().readCurrentChat();
      return live.ok&&live.identity.chatKey===chatKey&&live.identity.meta?.chatIntegrity===integrity&&nativeChatHash(live.chat)===finalHash;
    };

    const checking = await prioritizeFullBackupStatus(
      chatKey,
      createDisplayStatus("checking", "正在检查保存状态", "", pending),
    );
    await publishStatus(runId, { status: checking });
    if (!isCurrentRun(runId)) {
      return latestStatus();
    }

    try {
      const backend = await readBackendForRun({ current, runId });
      if (!isCurrentRun(runId) || backend?.code === "superseded") {
        return latestStatus();
      }
      if (!backend.ok) {
        return handleVerificationPending({
          chatKey,
          pending,
          retryIndex,
          detail: backend.reason,
          outcome: "unavailable",
          runId,
        });
      }

      await warmNativeChat(stripChatHeader(backend.chat));
      if(!isCurrentRun(runId))return latestStatus();
      if(finalHash&&(!targetUnchanged()||nativeChatHash(stripChatHeader(backend.chat))!==finalHash))return handleVerificationPending({chatKey,pending,retryIndex,runId,
        detail:'酒馆文件尚未与本轮最终聊天一致，保护记录继续保留。'});
      const needsFullConfirmation = await needsFullBackupConfirmation(chatKey);
      if (!isCurrentRun(runId)) {
        return latestStatus();
      }
      const needsStructuralProof = pending.some(record => !Number.isInteger(record.messageIndex) && record.backupTargets?.includes('full_messages'));
      const fullComparison = needsFullConfirmation || needsStructuralProof;
      const latestCurrent = fullComparison ? getContextReader().readCurrentChat() : current;
      if (fullComparison && (!latestCurrent.ok || latestCurrent.identity.chatKey !== chatKey)) {
        return latestStatus();
      }
      const backendMatchesCurrent = fullComparison
        && nativeChatHash(stripChatHeader(backend.chat)) === nativeChatHash(latestCurrent.chat);
      const snapshotConfirmed = await confirmSnapshotPending(pending, backend.chat, getContextReader().readCurrentChat());
      if (!isCurrentRun(runId)) return latestStatus();
      const comparison = comparePendingWithBackend(pending, backend.chat,{recentLimit:settings.recentLimit,snapshotIds:snapshotConfirmed});
      const confirmedIds = new Set(comparison.confirmedIds);
      const ranks=deletionRanks(pending);
      for (const id of snapshotConfirmed) confirmedIds.add(id);
      const confirmedRecords = pending.filter((record) => confirmedIds.has(record?.id) && (!record.snapshotSaveProof || snapshotConfirmed.has(record.id)))
        .map(record => ({...record,...comparison.proofs?.get(record.id),
          ...(!record.pendingFormat&&!Number.isInteger(record.messageIndex)&&confirmedIds.has(record.id)?{verifiedFullChatHash:hashCanonicalChat(stripChatHeader(backend.chat))}:{})}))
        .sort((a,b)=>(ranks.get(a.id)??0)-(ranks.get(b.id)??0));
      let fullConfirmed = false;
      if (fullComparison && backendMatchesCurrent) {
        const confirmation = await enqueueEffect(runId, () => confirmFullBackup({ current: latestCurrent }));
        if (!confirmation.applied || !isCurrentRun(runId)) return latestStatus();
        if (confirmation.value?.code) return publishBackupFailure(runId, chatKey, retryIndex, confirmation.value);
        fullConfirmed = true;
      }
      const removedIds=new Set();
      if (confirmedRecords.length) {
        const deletion = await enqueueEffect(
          runId,
          () => targetUnchanged()?deleteConfirmedPending(confirmedRecords, () => isCurrentRun(runId), operationController?.signal):[],
        );
        if (!deletion.applied || !isCurrentRun(runId)) {
          return latestStatus();
        }
        if(Array.isArray(deletion.value))for(const id of deletion.value)removedIds.add(id);
        if (Array.isArray(deletion.value) && deletion.value.length < confirmedRecords.length) {
          const deletedIds = new Set(deletion.value);
          const retained = confirmedRecords.filter(record => !deletedIds.has(record.id));
          const repair = await enqueueEffect(runId, () => ensurePendingBackups({ current: latestCurrent, records: retained, shouldContinue: () => isCurrentRun(runId) }));
          if (!repair.applied || !isCurrentRun(runId)) return latestStatus();
          if (repair.value?.code) return publishBackupFailure(runId, chatKey, retryIndex, repair.value);
          const retryDeletion=await enqueueEffect(runId, () => targetUnchanged()?deleteConfirmedPending(retained, () => isCurrentRun(runId), operationController?.signal):[]);
          if(retryDeletion.applied&&Array.isArray(retryDeletion.value))for(const id of retryDeletion.value)removedIds.add(id);
          if (!isCurrentRun(runId)) return latestStatus();
        }
      }

      const latestPending = await readCurrentPending(chatKey);
      if (!isCurrentRun(runId)) {
        return latestStatus();
      }
      const retainedIds=new Set(latestPending.map(row=>row.id));
      for(const root of confirmedRecords)if(root.pendingType==='operation'&&root.kind==='restore'&&removedIds.has(root.id)&&!retainedIds.has(root.id)){
        recordRecoverySafely(recordRecovery,{chatKey,recoveryId:root.operationId,stage:'restore-confirmed',targetCount:root.afterLength,...(root.snapshotSaveProof?{recoverySource:'snapshot'}:{})});
      }
      if (!latestPending.length && (!needsFullConfirmation || backendMatchesCurrent) && targetUnchanged()) {
        await enqueueEffect(runId, () => onPendingBackupsConfirmed(confirmedRecords));
        if (!isCurrentRun(runId)) return latestStatus();
        if (needsFullConfirmation && !fullConfirmed) {
          const confirmation = await enqueueEffect(
            runId,
            () => confirmFullBackup({ current: latestCurrent }),
          );
          if (!confirmation.applied || !isCurrentRun(runId)) {
            return latestStatus();
          }
          if (confirmation.value?.code) {
            return publishStatus(runId, { status: confirmation.value, refresh: true });
          }
        }
        const requestedStatus = createDisplayStatus("saved", "酒馆聊天已保存");
        const status = await prioritizeFullBackupStatus(chatKey, requestedStatus);
        return publishStatus(runId, {
          status,
          meta: { chatKey, outcome: "saved", pending: [] },
          refresh: true,
        });
      }

      const backupPending=targetUnchanged()&&confirmedRecords.length&&latestPending.every(record=>confirmedIds.has(record.id));
      return handleVerificationPending({
        chatKey,
        pending: latestPending,
        retryIndex,
        detail: backupPending ? '酒馆文件已确认，备份仍在补全；保护记录继续保留。' : "酒馆聊天文件内容尚未与当前聊天完全一致。",
        outcome: backupPending ? 'backup-pending' : "unconfirmed",
        runId,
      });
    } catch (error) {
      if (!isCurrentRun(runId) || isAbortError(error)) {
        return latestStatus();
      }
      console.warn("[boxed-lllllabc] 后端核对失败", error);
      return handleVerificationPending({
        chatKey,
        pending,
        retryIndex,
        detail: error instanceof Error ? error.message : String(error),
        outcome: "unavailable",
        runId,
      });
    }
  }

  async function runSnapshotVerification({ chatKey, expectedChatHash, retryIndex, runId }) {
    const settings = getSettings();
    if (!settings.enabled) {
      const status = createDisplayStatus("disabled", "备份未启用");
      return publishStatus(runId, { status, refresh: true });
    }

    const current = getContextReader().readCurrentChat();
    if (!current.ok || current.identity.chatKey !== chatKey || !isCurrentRun(runId)) {
      return latestStatus();
    }

    if (hashCanonicalChat(current.chat) !== expectedChatHash) {
      const status = createDisplayStatus(
        "unconfirmed",
        "酒馆保存待确认",
        "请求酒馆保存后当前聊天又发生了变化，请重新请求酒馆保存。",
      );
      return publishStatus(runId, {
        status,
        meta: { chatKey, outcome: "unconfirmed", pending: [] },
        refresh: true,
      });
    }

    await publishStatus(runId, {
      status: createDisplayStatus("checking", "正在检查保存状态"),
    });
    if (!isCurrentRun(runId)) {
      return latestStatus();
    }

    try {
      const backend = await readBackendForRun({ current, runId });
      if (!isCurrentRun(runId) || backend?.code === "superseded") {
        return latestStatus();
      }
      if (backend.ok && hashCanonicalChat(stripChatHeader(backend.chat)) === expectedChatHash) {
        const latestCurrent = getContextReader().readCurrentChat();
        if (!latestCurrent.ok
          || latestCurrent.identity.chatKey !== chatKey
          || hashCanonicalChat(latestCurrent.chat) !== expectedChatHash) {
          const status = createDisplayStatus(
            "unconfirmed",
            "酒馆保存待确认",
            "核对期间当前聊天又发生了变化，请等待下一次核对。",
          );
          return publishStatus(runId, {
            status,
            meta: { chatKey, outcome: "unconfirmed", pending: [] },
            refresh: true,
          });
        }
        const confirmation = await enqueueEffect(
          runId,
          () => confirmFullBackup({ current: latestCurrent }),
        );
        if (!confirmation.applied || !isCurrentRun(runId)) {
          return latestStatus();
        }
        if (confirmation.value?.code) {
          return publishStatus(runId, { status: confirmation.value, refresh: true });
        }
        const requestedStatus = createDisplayStatus("saved", "酒馆聊天已保存");
        const status = await prioritizeFullBackupStatus(chatKey, requestedStatus);
        return publishStatus(runId, {
          status,
          meta: { chatKey, outcome: "saved", pending: [] },
          refresh: true,
        });
      }

      const detail = backend.ok ? "酒馆聊天文件内容尚未与当前聊天一致。" : backend.reason;
      return handleSnapshotVerificationPending({
        chatKey,
        expectedChatHash,
        retryIndex,
        detail,
        outcome: backend.ok ? "unconfirmed" : "unavailable",
        runId,
      });
    } catch (error) {
      if (!isCurrentRun(runId) || isAbortError(error)) {
        return latestStatus();
      }
      return handleSnapshotVerificationPending({
        chatKey,
        expectedChatHash,
        retryIndex,
        detail: error instanceof Error ? error.message : String(error),
        outcome: "unavailable",
        runId,
      });
    }
  }

  async function handleSnapshotVerificationPending({
    chatKey,
    expectedChatHash,
    retryIndex,
    detail,
    outcome,
    runId,
  }) {
    if (!isCurrentRun(runId)) {
      return latestStatus();
    }
    if (retryIndex < retryDelays.length) {
      const status = createDisplayStatus("checking", "正在检查保存状态", detail);
      await publishStatus(runId, {
        status,
        meta: { chatKey, outcome: "checking", pending: [] },
        refresh: true,
      });
      scheduleVerificationForRun({
        type: "snapshot",
        chatKey,
        expectedChatHash,
        delayMs: retryDelays[retryIndex],
        retryIndex: retryIndex + 1,
        runId,
      });
      return isCurrentRun(runId) ? status : latestStatus();
    }

    const status = outcome === "unavailable"
      ? createDisplayStatus("verify-unavailable", "无法确认保存状态", detail)
      : createDisplayStatus("unconfirmed", "酒馆保存待确认", detail);
    return publishStatus(runId, {
      status,
      meta: { chatKey, outcome, pending: [] },
      refresh: true,
    });
  }

  async function handleVerificationPending({
    chatKey,
    pending,
    retryIndex,
    detail,
    outcome = "unconfirmed",
    runId,
  }) {
    if (!isCurrentRun(runId)) {
      return latestStatus();
    }
    if (retryIndex < retryDelays.length) {
      const requestedStatus = createDisplayStatus("checking", outcome === 'backup-pending' ? '酒馆已保存，备份待补全' : "正在检查保存状态", detail, pending);
      const status = await prioritizeFullBackupStatus(chatKey, requestedStatus);
      await publishStatus(runId, {
        status,
        meta: { chatKey, outcome: "checking", pending },
        refresh: true,
      });
      scheduleVerificationForRun({
        type: "pending",
        chatKey,
        delayMs: retryDelays[retryIndex],
        retryIndex: retryIndex + 1,
        runId,
      });
      return isCurrentRun(runId) ? status : latestStatus();
    }

    const requestedStatus = outcome === "unavailable"
      ? createDisplayStatus("verify-unavailable", "无法确认保存状态", detail, pending)
      : createDisplayStatus("unconfirmed", outcome === 'backup-pending' ? '酒馆已保存，备份待补全' : "酒馆保存待确认", detail, pending);
    const status = await prioritizeFullBackupStatus(chatKey, requestedStatus);
    return publishStatus(runId, {
      status,
      meta: { chatKey, outcome, pending },
      refresh: true,
    });
  }

  function publishBackupFailure(runId, chatKey, retryIndex, status) {
    if (retryIndex < retryDelays.length && isCurrentRun(runId)) scheduleVerificationForRun({ type: 'pending', chatKey, delayMs: retryDelays[retryIndex], retryIndex: retryIndex + 1, runId });
    return publishStatus(runId, { status, refresh: true });
  }

  async function readBackendForRun({ current, runId }) {
    if (!isCurrentRun(runId)) {
      return { ok: false, code: "superseded" };
    }
    const controller = typeof AbortControllerImpl === "function"
      ? new AbortControllerImpl()
      : null;
    activeRequest = { runId, controller };
    try {
      return await readBackend({ current, signal: controller?.signal });
    } finally {
      if (activeRequest?.runId === runId && activeRequest.controller === controller) {
        activeRequest = null;
      }
    }
  }

  function enqueueEffect(runId, effect) {
    const operation = effectQueue.catch(() => undefined).then(async () => {
      if (!isCurrentRun(runId)) {
        return { applied: false, value: undefined };
      }
      const value = await effect();
      return { applied: true, value };
    });
    effectQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async function publishStatus(runId, { status, meta = null, refresh = false }) {
    const published = await enqueueEffect(runId, async () => {
      setStatus(status);
      if (meta) {
        await updateBackendMeta(meta.chatKey, meta.outcome, meta.pending);
      }
      if (refresh && isCurrentRun(runId)) {
        await refreshVisiblePanel();
      }
      return status;
    });
    return published.applied && isCurrentRun(runId) ? status : latestStatus();
  }

  return {
    whenIdle: () => effectQueue,
    clearScheduledVerification,
    retryLimit: retryDelays.length,
    scheduleBackendSnapshotVerification,
    scheduleBackendVerification,
    verifyBackendSnapshotNow,
    verifyBackendNow,
  };
}

function deletionRanks(records) {
  const operations=new Map(records.filter(row=>row.pendingType==='operation').map(row=>[row.id,row]));
  const ranks=new Map(),remaining=new Map(),parents=new Map(),queue=[];
  for(const [id,row] of operations) {
    const children=new Set((row.supersedes??[]).map(ref=>ref.id).filter(key=>operations.has(key)));
    remaining.set(id,children.size);ranks.set(id,1);
    if(!children.size)queue.push(id);
    for(const child of children){if(!parents.has(child))parents.set(child,[]);parents.get(child).push(id);}
  }
  for(let i=0;i<queue.length;i++)for(const parent of parents.get(queue[i])??[]) {
    ranks.set(parent,Math.max(ranks.get(parent),ranks.get(queue[i])+1));
    remaining.set(parent,remaining.get(parent)-1);if(!remaining.get(parent))queue.push(parent);
  }
  for(const [id,count] of remaining)if(count)ranks.set(id,records.length+1);
  return ranks;
}

async function deleteConfirmedPendingRecords(storage, records, shouldDelete, signal) {
  const session = await storage.open();
  try {
    const deleted = [];
    for (const rows of backupBatches(records)) {
      if (signal?.aborted || !shouldDelete()) break;
      deleted.push(...await session.deletePendingChangesIfUnchanged(rows, { shouldDelete, signal }));
    }
    return deleted;
  } finally {
    session.close();
  }
}

function isAbortError(error) {
  return error?.name === "AbortError";
}
