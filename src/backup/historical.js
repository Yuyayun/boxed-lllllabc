import { canonicalizeMessage } from "./canonicalize.js";
import { inferMessageIndex, inferPendingKind } from "./pending.js";

const HISTORICAL_EVENTS = new Set([
  "message_edited",
  "message_updated",
  "message_swiped",
  "message_swipe_deleted",
  "message_reasoning_edited",
  "message_reasoning_deleted",
  "generation_ended",
  "generation_stopped",
]);

export function createHistoricalRecord({
  chat,
  chatKey,
  eventName,
  args = [],
  recentLimit,
  settings = {},
  now = new Date().toISOString(),
} = {}) {
  if (!chatKey || settings.enabled === false || settings.historicalBackupEnabled === false) {
    return null;
  }

  if (!HISTORICAL_EVENTS.has(eventName) || includesFirstMessage(args)) {
    return null;
  }

  const safeChat = Array.isArray(chat) ? chat : [];
  const messageIndex = inferMessageIndex(eventName, args, safeChat.length);
  if (!Number.isInteger(messageIndex) || !isHistoricalIndex(messageIndex, safeChat.length, recentLimit)) {
    return null;
  }

  const message = safeChat[messageIndex];
  if (!message || isTransientSwipe(eventName, message)) {
    return null;
  }

  const normalizedMessage = canonicalizeMessage(message, messageIndex, now);
  return {
    chatKey,
    messageIndex,
    message: normalizedMessage,
    canonicalHash: normalizedMessage.canonicalHash,
    firstCapturedAt: now,
    updatedAt: now,
    lastKind: inferPendingKind(eventName),
  };
}

export function mergeHistoricalRecord(previous, next) {
  if (!next) {
    return previous ?? null;
  }

  return {
    ...next,
    firstCapturedAt: previous?.firstCapturedAt ?? next.firstCapturedAt,
  };
}

export function isHistoricalIndex(messageIndex, chatLength, recentLimit) {
  const safeLength = Number.isInteger(chatLength) && chatLength > 0 ? chatLength : 0;
  const limit = normalizeRecentLimit(recentLimit);
  return Number.isInteger(messageIndex)
    && messageIndex >= 0
    && messageIndex < safeLength - limit;
}

function includesFirstMessage(args) {
  return Array.isArray(args) && args.includes("first_message");
}

function isTransientSwipe(eventName, message) {
  if (eventName !== "message_swiped" || !Array.isArray(message?.swipes)) {
    return false;
  }

  const swipeIndex = Number(message.swipe_id);
  return Number.isInteger(swipeIndex) && swipeIndex >= message.swipes.length;
}

function normalizeRecentLimit(value) {
  const limit = Number.parseInt(value, 10);
  if (!Number.isFinite(limit)) {
    return 20;
  }

  return Math.max(1, Math.min(200, limit));
}
