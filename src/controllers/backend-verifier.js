import { deletePendingChangesIfUnchanged, openBackupDatabase } from "../db/index.js";
import { hashCanonicalChat, stripChatHeader } from "../backup/canonicalize.js";
import { readBackendChat } from "../verifier/backend-reader.js";
import { comparePendingWithBackend } from "../verifier/compare.js";

export function createBackendVerifier({
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
  needsFullBackupConfirmation = async () => false,
  readBackend = readBackendChat,
  deleteConfirmedPending = deleteConfirmedPendingRecords,
  retryDelays = [2000, 5000, 10000],
  AbortControllerImpl = globalThis.AbortController,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
}) {
  let verifyTimer = null;
  let verifyRunId = 0;
  let activeRequest = null;
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
      if (type === "snapshot") {
        await runSnapshotVerification({ chatKey, expectedChatHash, retryIndex, runId });
      } else {
        await runPendingVerification({ chatKey, retryIndex, runId });
      }
    }, delayMs);
  }

  function clearScheduledVerification() {
    clearVerificationTimer();
    verifyRunId += 1;
    abortActiveRequest();
  }

  function beginVerificationRun() {
    clearScheduledVerification();
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
      const status = createDisplayStatus("disabled", "未启用");
      return publishStatus(runId, { status, refresh: true });
    }

    const current = getContextReader().readCurrentChat();
    if (!current.ok || current.identity.chatKey !== chatKey || !isCurrentRun(runId)) {
      return latestStatus();
    }

    const pending = await readCurrentPending(chatKey);
    if (!isCurrentRun(runId)) {
      return latestStatus();
    }
    if (!pending.length) {
      const needsConfirmation = await needsFullBackupConfirmation(chatKey);
      if (!isCurrentRun(runId)) {
        return latestStatus();
      }
      if (!needsConfirmation) {
        const requestedStatus = createDisplayStatus("saved", "酒馆已保存聊天记录");
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

    const checking = await prioritizeFullBackupStatus(
      chatKey,
      createDisplayStatus("checking", "正在核对后端", "", pending),
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

      const needsFullConfirmation = await needsFullBackupConfirmation(chatKey);
      if (!isCurrentRun(runId)) {
        return latestStatus();
      }
      const latestCurrent = needsFullConfirmation ? getContextReader().readCurrentChat() : current;
      if (needsFullConfirmation && (!latestCurrent.ok || latestCurrent.identity.chatKey !== chatKey)) {
        return latestStatus();
      }
      const backendMatchesCurrent = needsFullConfirmation
        && hashCanonicalChat(stripChatHeader(backend.chat)) === hashCanonicalChat(latestCurrent.chat);
      const comparison = comparePendingWithBackend(pending, backend.chat);
      const confirmedIds = new Set(backendMatchesCurrent
        ? pending.map((record) => record?.id).filter(Boolean)
        : comparison.confirmedIds);
      const confirmedRecords = pending.filter((record) => confirmedIds.has(record?.id));
      if (confirmedRecords.length) {
        const deletion = await enqueueEffect(
          runId,
          () => deleteConfirmedPending(confirmedRecords, () => isCurrentRun(runId)),
        );
        if (!deletion.applied || !isCurrentRun(runId)) {
          return latestStatus();
        }
      }

      const latestPending = await readCurrentPending(chatKey);
      if (!isCurrentRun(runId)) {
        return latestStatus();
      }
      if (!latestPending.length && (!needsFullConfirmation || backendMatchesCurrent)) {
        if (needsFullConfirmation) {
          const confirmation = await enqueueEffect(
            runId,
            () => confirmFullBackup({ current: latestCurrent }),
          );
          if (!confirmation.applied || !isCurrentRun(runId)) {
            return latestStatus();
          }
          if (confirmation.value?.code === "db-error") {
            return publishStatus(runId, { status: confirmation.value, refresh: true });
          }
        }
        const requestedStatus = createDisplayStatus("saved", "酒馆已保存聊天记录");
        const status = await prioritizeFullBackupStatus(chatKey, requestedStatus);
        return publishStatus(runId, {
          status,
          meta: { chatKey, outcome: "saved", pending: [] },
          refresh: true,
        });
      }

      return handleVerificationPending({
        chatKey,
        pending: latestPending,
        retryIndex,
        detail: "后端内容尚未与当前聊天完全一致。",
        outcome: "unconfirmed",
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
      const status = createDisplayStatus("disabled", "未启用");
      return publishStatus(runId, { status, refresh: true });
    }

    const current = getContextReader().readCurrentChat();
    if (!current.ok || current.identity.chatKey !== chatKey || !isCurrentRun(runId)) {
      return latestStatus();
    }

    if (hashCanonicalChat(current.chat) !== expectedChatHash) {
      const status = createDisplayStatus(
        "unconfirmed",
        "等待确认保存情况",
        "请求保存后当前聊天又发生了变化，请重新请求保存。",
      );
      return publishStatus(runId, {
        status,
        meta: { chatKey, outcome: "unconfirmed", pending: [] },
        refresh: true,
      });
    }

    await publishStatus(runId, {
      status: createDisplayStatus("checking", "正在核对后端"),
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
            "等待确认保存情况",
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
        if (confirmation.value?.code === "db-error") {
          return publishStatus(runId, { status: confirmation.value, refresh: true });
        }
        const requestedStatus = createDisplayStatus("saved", "酒馆已保存聊天记录");
        const status = await prioritizeFullBackupStatus(chatKey, requestedStatus);
        return publishStatus(runId, {
          status,
          meta: { chatKey, outcome: "saved", pending: [] },
          refresh: true,
        });
      }

      const detail = backend.ok ? "后端内容尚未与当前聊天一致。" : backend.reason;
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
      const status = createDisplayStatus("checking", "正在核对后端", detail);
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
      ? createDisplayStatus("verify-unavailable", "无法核对后端", detail)
      : createDisplayStatus("unconfirmed", "等待确认保存情况", detail);
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
      const requestedStatus = createDisplayStatus("checking", "正在核对后端", detail, pending);
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
      ? createDisplayStatus("verify-unavailable", "无法核对后端", detail, pending)
      : createDisplayStatus("unconfirmed", "等待确认保存情况", detail, pending);
    const status = await prioritizeFullBackupStatus(chatKey, requestedStatus);
    return publishStatus(runId, {
      status,
      meta: { chatKey, outcome, pending },
      refresh: true,
    });
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
    clearScheduledVerification,
    retryLimit: retryDelays.length,
    scheduleBackendSnapshotVerification,
    scheduleBackendVerification,
    verifyBackendSnapshotNow,
    verifyBackendNow,
  };
}

async function deleteConfirmedPendingRecords(records, shouldDelete) {
  const db = await openBackupDatabase();
  try {
    return await deletePendingChangesIfUnchanged(db, records, { shouldDelete });
  } finally {
    db.close();
  }
}

function isAbortError(error) {
  return error?.name === "AbortError";
}
