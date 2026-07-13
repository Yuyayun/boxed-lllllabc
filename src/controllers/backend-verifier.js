import { deletePendingChanges, openBackupDatabase } from "../db/index.js";
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
  retryDelays = [2000, 5000, 10000],
}) {
  let verifyTimer = null;
  let verifyRunId = 0;

  function scheduleBackendVerification(chatKey, delayMs, retryIndex) {
    clearScheduledVerification();
    const runId = ++verifyRunId;
    verifyTimer = setTimeout(async () => {
      verifyTimer = null;
      if (runId !== verifyRunId) {
        return;
      }

      await verifyBackendNow({ chatKey, retryIndex });
    }, delayMs);
  }

  function scheduleBackendSnapshotVerification(chatKey, expectedChatHash, delayMs, retryIndex) {
    clearScheduledVerification();
    const runId = ++verifyRunId;
    verifyTimer = setTimeout(async () => {
      verifyTimer = null;
      if (runId !== verifyRunId) {
        return;
      }

      await verifyBackendSnapshotNow({ chatKey, expectedChatHash, retryIndex });
    }, delayMs);
  }

  function clearScheduledVerification() {
    if (verifyTimer) {
      clearTimeout(verifyTimer);
      verifyTimer = null;
    }
    verifyRunId += 1;
  }

  async function verifyBackendNow({ chatKey, retryIndex = 0 }) {
    const settings = getSettings();
    if (!settings.enabled) {
      clearScheduledVerification();
      const status = createDisplayStatus("disabled", "未启用");
      setStatus(status);
      await refreshVisiblePanel();
      return status;
    }

    const current = getContextReader().readCurrentChat();
    if (!current.ok || current.identity.chatKey !== chatKey) {
      return getLatestStatus();
    }

    const pending = await readCurrentPending(chatKey);
    if (!pending.length) {
      if (!await needsFullBackupConfirmation(chatKey)) {
        const status = await prioritizeFullBackupStatus(
          chatKey,
          createDisplayStatus("saved", "后端已保存"),
        );
        setStatus(status);
        await updateBackendMeta(chatKey, "saved", []);
        await refreshVisiblePanel();
        return status;
      }
      return verifyBackendSnapshotNow({
        chatKey,
        expectedChatHash: hashCanonicalChat(current.chat),
        retryIndex,
      });
    }

    setStatus(await prioritizeFullBackupStatus(
      chatKey,
      createDisplayStatus("checking", "保存中", "", pending),
    ));

    try {
      const backend = await readBackend({ current });
      if (!backend.ok) {
        return await handleVerificationPending({
          chatKey,
          pending,
          retryIndex,
          detail: backend.reason,
          outcome: "unavailable",
        });
      }

      const needsFullConfirmation = await needsFullBackupConfirmation(chatKey);
      const latestCurrent = needsFullConfirmation ? getContextReader().readCurrentChat() : current;
      if (needsFullConfirmation && (!latestCurrent.ok || latestCurrent.identity.chatKey !== chatKey)) {
        return getLatestStatus();
      }
      const backendMatchesCurrent = needsFullConfirmation
        && hashCanonicalChat(stripChatHeader(backend.chat)) === hashCanonicalChat(latestCurrent.chat);
      const comparison = comparePendingWithBackend(pending, backend.chat);
      const confirmedIds = backendMatchesCurrent
        ? pending.map((record) => record?.id).filter(Boolean)
        : comparison.confirmedIds;
      if (confirmedIds.length) {
        const db = await openBackupDatabase();
        try {
          await deletePendingChanges(db, confirmedIds);
        } finally {
          db.close();
        }
      }

      const latestPending = await readCurrentPending(chatKey);
      if (!latestPending.length && (!needsFullConfirmation || backendMatchesCurrent)) {
        if (needsFullConfirmation) {
          const fullStatus = await confirmFullBackup({ current: latestCurrent });
          if (fullStatus?.code === "db-error") {
            setStatus(fullStatus);
            await refreshVisiblePanel();
            return fullStatus;
          }
        }
        const status = await prioritizeFullBackupStatus(
          chatKey,
          createDisplayStatus("saved", "后端已保存"),
        );
        setStatus(status);
        await updateBackendMeta(chatKey, "saved", []);
        await refreshVisiblePanel();
        return status;
      }

      return await handleVerificationPending({
        chatKey,
        pending: latestPending,
        retryIndex,
        detail: "后端内容尚未与当前聊天完全一致。",
        outcome: "unconfirmed",
      });
    } catch (error) {
      console.warn("[boxed-lllllabc] 后端核对失败", error);
      return await handleVerificationPending({
        chatKey,
        pending,
        retryIndex,
        detail: error instanceof Error ? error.message : String(error),
        outcome: "unavailable",
      });
    }
  }

  async function verifyBackendSnapshotNow({ chatKey, expectedChatHash, retryIndex = 0 }) {
    const settings = getSettings();
    if (!settings.enabled) {
      clearScheduledVerification();
      const status = createDisplayStatus("disabled", "未启用");
      setStatus(status);
      await refreshVisiblePanel();
      return status;
    }

    const current = getContextReader().readCurrentChat();
    if (!current.ok || current.identity.chatKey !== chatKey) {
      return getLatestStatus();
    }

    if (hashCanonicalChat(current.chat) !== expectedChatHash) {
      const status = createDisplayStatus("unconfirmed", "后端内容待确认", "请求保存后当前聊天又发生了变化，请重新请求保存。");
      setStatus(status);
      await updateBackendMeta(chatKey, "unconfirmed", []);
      await refreshVisiblePanel();
      return status;
    }

    setStatus(createDisplayStatus("checking", "保存中"));
    try {
      const backend = await readBackend({ current });
      if (backend.ok && hashCanonicalChat(stripChatHeader(backend.chat)) === expectedChatHash) {
        const latestCurrent = getContextReader().readCurrentChat();
        if (!latestCurrent.ok
          || latestCurrent.identity.chatKey !== chatKey
          || hashCanonicalChat(latestCurrent.chat) !== expectedChatHash) {
          const status = createDisplayStatus(
            "unconfirmed",
            "后端内容待确认",
            "核对期间当前聊天又发生了变化，请等待下一次核对。",
          );
          setStatus(status);
          await updateBackendMeta(chatKey, "unconfirmed", []);
          await refreshVisiblePanel();
          return status;
        }
        const fullStatus = await confirmFullBackup({ current: latestCurrent });
        if (fullStatus?.code === "db-error") {
          setStatus(fullStatus);
          await refreshVisiblePanel();
          return fullStatus;
        }
        const status = await prioritizeFullBackupStatus(
          chatKey,
          createDisplayStatus("saved", "后端已保存"),
        );
        setStatus(status);
        await updateBackendMeta(chatKey, "saved", []);
        await refreshVisiblePanel();
        return status;
      }

      const detail = backend.ok ? "后端内容尚未与当前聊天一致。" : backend.reason;
      return handleSnapshotVerificationPending({
        chatKey,
        expectedChatHash,
        retryIndex,
        detail,
        outcome: backend.ok ? "unconfirmed" : "unavailable",
      });
    } catch (error) {
      return handleSnapshotVerificationPending({
        chatKey,
        expectedChatHash,
        retryIndex,
        detail: error instanceof Error ? error.message : String(error),
        outcome: "unavailable",
      });
    }
  }

  async function handleSnapshotVerificationPending({
    chatKey,
    expectedChatHash,
    retryIndex,
    detail,
    outcome,
  }) {
    if (retryIndex < retryDelays.length) {
      const status = createDisplayStatus("checking", "保存中", detail);
      setStatus(status);
      await updateBackendMeta(chatKey, "checking", []);
      scheduleBackendSnapshotVerification(
        chatKey,
        expectedChatHash,
        retryDelays[retryIndex],
        retryIndex + 1,
      );
      await refreshVisiblePanel();
      return status;
    }

    const status = outcome === "unavailable"
      ? createDisplayStatus("verify-unavailable", "无法核对后端", detail)
      : createDisplayStatus("unconfirmed", "后端内容待确认", detail);
    setStatus(status);
    await updateBackendMeta(chatKey, outcome, []);
    await refreshVisiblePanel();
    return status;
  }

  async function handleVerificationPending({
    chatKey,
    pending,
    retryIndex,
    detail,
    outcome = "unconfirmed",
  }) {
    if (retryIndex < retryDelays.length) {
      const status = await prioritizeFullBackupStatus(
        chatKey,
        createDisplayStatus("checking", "保存中", detail, pending),
      );
      setStatus(status);
      await updateBackendMeta(chatKey, "checking", pending);
      scheduleBackendVerification(chatKey, retryDelays[retryIndex], retryIndex + 1);
      await refreshVisiblePanel();
      return status;
    }

    const requestedStatus = outcome === "unavailable"
      ? createDisplayStatus("verify-unavailable", "无法核对后端", detail, pending)
      : createDisplayStatus("unconfirmed", "后端内容待确认", detail, pending);
    const status = await prioritizeFullBackupStatus(chatKey, requestedStatus);
    setStatus(status);
    await updateBackendMeta(chatKey, outcome, pending);
    await refreshVisiblePanel();
    return status;
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
