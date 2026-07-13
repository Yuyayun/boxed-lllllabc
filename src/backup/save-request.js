import { hashCanonicalChat } from "./canonicalize.js";

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
    }))
    .sort((left, right) => left.id.localeCompare(right.id)));
}
