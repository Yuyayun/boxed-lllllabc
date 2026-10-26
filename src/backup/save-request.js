import { hashCanonicalChat } from "./canonicalize.js";

export const SAVE_REQUEST_TIMEOUT_MS = 15000;

const SAVE_TIMEOUT = Symbol("save-request-timeout");

export function createSaveRequestPlan({ chat, chatKey, pending }) {
  const safeChat = Array.isArray(chat) ? chat : [];
  const safePending = Array.isArray(pending) ? pending : [];
  return {
    chatKey,
    chatLength: safeChat.length,
    chatHash: hashCanonicalChat(safeChat),
    pendingCount: safePending.length,
    pendingFingerprint: fingerprintPending(safePending),
  };
}

export function validateSaveRequestPlan({ plan, current, pending }) {
  if (!plan?.chatKey || !current?.ok || current.identity?.chatKey !== plan.chatKey) {
    return {
      ok: false,
      reason: "当前聊天已经变化，请重新打开确认窗口。",
    };
  }

  if (current.chat.length !== plan.chatLength || hashCanonicalChat(current.chat) !== plan.chatHash) {
    return {
      ok: false,
      reason: "当前聊天内容已经变化，请重新确认后再请求保存。",
    };
  }

  const safePending = Array.isArray(pending) ? pending : [];
  if (safePending.length !== plan.pendingCount || fingerprintPending(safePending) !== plan.pendingFingerprint) {
    return {
      ok: false,
      reason: "未保存变更已经变化，请重新确认后再请求保存。",
    };
  }

  return { ok: true, reason: "" };
}

export function fingerprintPending(records) {
  return JSON.stringify((Array.isArray(records) ? records : [])
    .map((record) => ({
      id: record?.id ?? "",
      messageIndex: Number.isInteger(record?.messageIndex) ? record.messageIndex : null,
      canonicalHash: record?.canonicalHash ?? "",
      canonicalChatHash: record?.canonicalChatHash ?? "",
      chatLength: Number.isInteger(record?.chatLength) ? record.chatLength : null,
      ...(record?.snapshotSaveProof ? { snapshotSaveProof: record.snapshotSaveProof } : {}),
    }))
    .sort((left, right) => left.id.localeCompare(right.id)));
}

export async function waitForSaveRequest({
  save,
  timeoutMs = SAVE_REQUEST_TIMEOUT_MS,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
}) {
  if (typeof save !== "function") {
    const error = new Error("当前酒馆版本没有提供聊天保存接口。");
    return {
      ok: false,
      status: "failed",
      reason: error.message,
      error,
    };
  }

  let timeoutHandle = null;
  const saveResult = Promise.resolve()
    .then(() => save())
    .then(
      (value) => ({ ok: true, status: "completed", value }),
      (error) => ({
        ok: false,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
        error,
      }),
    );
  const races = [saveResult];
  if (Number.isFinite(timeoutMs) && timeoutMs >= 0 && typeof setTimer === "function") {
    races.push(new Promise((resolve) => {
      timeoutHandle = setTimer(() => resolve(SAVE_TIMEOUT), timeoutMs);
    }));
  }

  try {
    const result = await Promise.race(races);
    if (result === SAVE_TIMEOUT) {
      return {
        ok: true,
        status: "timeout",
        reason: "酒馆保存请求超过 15 秒仍未返回，已转为后台核对。",
      };
    }
    return result;
  } finally {
    if (timeoutHandle !== null && typeof clearTimer === "function") {
      clearTimer(timeoutHandle);
    }
  }
}
