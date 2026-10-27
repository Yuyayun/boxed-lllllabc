import { canonicalizeRecentMessages } from "./canonicalize.js";
import { classifyTriggers } from "./full.js";
import { defaultBackupStorage } from "../storage/service.js";

export function createBackupStatus(code, shortText, detail = "") {
  const errorName = detail instanceof Error ? String(detail.name || "") : "";
  const quotaFailure = code === "db-error" && errorName === "QuotaExceededError";
  return {
    code,
    shortText: quotaFailure ? "空间不足，备份未写入" : shortText,
    detail: detail instanceof Error ? detail.message : String(detail ?? ""),
    ...(errorName ? { errorName } : {}),
    updatedAt: new Date().toISOString(),
  };
}

export async function refreshRecentBackup({ contextReader, settings, reason = "unknown", triggers = [], storage = defaultBackupStorage }) {
  if (!settings.enabled) {
    return createBackupStatus("disabled", "备份未启用");
  }

  if (!settings.recentBackupEnabled) {
    return createBackupStatus("recent-disabled", "最近楼层备份未启用");
  }

  const current = contextReader.readCurrentChat();
  if (!current.ok) {
    const shortText = current.reason === "当前没有可备份的聊天内容。"
      ? "当前没有可备份的聊天"
      : "无法识别当前聊天";
    return createBackupStatus("identity-missing", shortText, current.reason);
  }

  const backedUpAt = new Date().toISOString();
  const recentLimit = normalizeRecentLimit(settings.recentLimit);
  const messages = canonicalizeRecentMessages(current.chat, recentLimit, backedUpAt);
  const meta = {
    ...current.identity.meta,
    chatKey: current.identity.chatKey,
    lastSeenAt: backedUpAt,
    lastBackupAt: backedUpAt,
    messageCount: current.chat.length,
    recentCount: messages.length,
    recentFirstIndex: messages[0]?.messageIndex ?? null,
    recentLastIndex: messages.at(-1)?.messageIndex ?? null,
    lastReason: reason,
  };

  try {
    const session = await storage.open();
    try {
      const existingMessages = await session.getRecentMessages(current.identity.chatKey);
      if (shouldPreserveRecentSnapshot({
        existingMessages,
        currentChat: current.chat,
        triggers,
        reason,
      })) {
        return createBackupStatus("recent-preserved", `已保留较长的最近 ${existingMessages.length} 层备份`);
      }

      await session.replaceRecentSnapshot({
        meta,
        messages,
      });
    } finally {
      session.close();
    }
  } catch (error) {
    console.error("[boxed-lllllabc] 本地备份失败", error);
    return createBackupStatus("db-error", "备份不可用", error);
  }

  return createBackupStatus("ok", `已备份最近 ${messages.length} 层`);
}

export function shouldPreserveRecentSnapshot({
  existingMessages = [],
  currentChat = [],
  triggers = [],
  reason = "unknown",
}) {
  const existing = Array.isArray(existingMessages) ? existingMessages : [];
  const currentLength = Array.isArray(currentChat) ? currentChat.length : 0;
  const existingLastIndex = existing.at(-1)?.messageIndex;
  if (!Number.isInteger(existingLastIndex) || existingLastIndex < currentLength) {
    return false;
  }

  if (reason === "restore") {
    return false;
  }

  return !classifyTriggers(triggers, currentLength).hasDelete;
}

export function normalizeRecentLimit(value) {
  const limit = Number.parseInt(value, 10);
  if (!Number.isFinite(limit)) {
    return 20;
  }

  return Math.max(1, Math.min(200, limit));
}
