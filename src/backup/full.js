import { canonicalizeMessage } from "./canonicalize.js";
import { inferMessageIndex } from "./pending.js";

const DELETE_EVENT = "message_deleted";
const LOAD_EVENTS = new Set([
  "extension-loaded",
  "lifecycle-resume",
  "settings-full-enabled-changed",
  "chat_id_changed",
  "chat_created",
]);
const CONTENT_EVENTS = new Set([
  "message_sent",
  "message_received",
  "message_edited",
  "message_updated",
  "message_swiped",
  "message_swipe_deleted",
  "message_reasoning_edited",
  "message_reasoning_deleted",
  "generation_ended",
  "generation_stopped",
]);

export function createFullBackupDecision({
  existingMessages = [],
  currentChat = [],
  triggers = [],
  frozen = false,
  now = new Date().toISOString(),
}) {
  const currentMessages = canonicalizeAll(currentChat, now);
  const existing = Array.isArray(existingMessages) ? existingMessages : [];
  const eventInfo = classifyTriggers(triggers, currentMessages.length);

  if (!existing.length) {
    if (eventInfo.onlyIgnoredFirstMessage) {
      return { action: "skip", messages: [], currentMessages, eventInfo };
    }
    return currentMessages.length
      ? { action: "create", messages: currentMessages, currentMessages, eventInfo }
      : { action: "skip", messages: [], currentMessages, eventInfo };
  }

  if (frozen) {
    return matchesAll(existing, currentMessages)
      ? { action: "unfreeze", messages: currentMessages, currentMessages, eventInfo }
      : { action: "skip-frozen", messages: [], currentMessages, eventInfo };
  }

  if (eventInfo.hasDelete) {
    return { action: "rebuild", messages: currentMessages, currentMessages, eventInfo };
  }

  if (eventInfo.onlyIgnoredFirstMessage) {
    return { action: "noop", messages: [], currentMessages, eventInfo };
  }

  if (currentMessages.length < existing.length) {
    return freeze(existing, currentMessages, eventInfo, now, "unexpected-shorter-chat");
  }

  const targetIndexes = eventInfo.targetIndexes;
  const unexpectedIndex = findUnexpectedDifference(existing, currentMessages, targetIndexes);
  if (unexpectedIndex !== null) {
    return freeze(existing, currentMessages, eventInfo, now, "unexpected-message-change", unexpectedIndex);
  }

  if (currentMessages.length > existing.length) {
    return {
      action: "append",
      messages: currentMessages.slice(existing.length),
      currentMessages,
      eventInfo,
    };
  }

  if (targetIndexes.length) {
    return {
      action: "update",
      messages: targetIndexes.map((index) => currentMessages[index]).filter(Boolean),
      currentMessages,
      eventInfo,
    };
  }

  return { action: "noop", messages: [], currentMessages, eventInfo };
}

export function classifyTriggers(triggers = [], chatLength = 0) {
  const safeTriggers = Array.isArray(triggers) ? triggers : [];
  const hasIgnoredFirstMessage = safeTriggers.some((trigger) => {
    return trigger?.eventName === "message_received" && isFirstMessage(trigger?.args);
  });
  const contentTriggers = safeTriggers.filter((trigger) => {
    return CONTENT_EVENTS.has(trigger?.eventName) && !isFirstMessage(trigger?.args);
  });
  const targetIndexes = [...new Set(contentTriggers
    .map((trigger) => inferMessageIndex(trigger.eventName, trigger.args, chatLength))
    .filter(Number.isInteger))].sort((a, b) => a - b);

  const hasDelete = safeTriggers.some((trigger) => trigger?.eventName === DELETE_EVENT);
  const hasLoad = safeTriggers.some((trigger) => LOAD_EVENTS.has(trigger?.eventName));
  return {
    hasDelete,
    hasContent: contentTriggers.length > 0,
    hasLoad,
    onlyIgnoredFirstMessage: hasIgnoredFirstMessage
      && !contentTriggers.length
      && !hasDelete
      && !hasLoad,
    targetIndexes,
  };
}

export function createFullBackupMeta({ identity, messages, reason, previousMeta = {}, state = "active", incident = null, now = new Date().toISOString() }) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  return {
    ...previousMeta,
    ...identity.meta,
    chatKey: identity.chatKey,
    fullBackupAt: now,
    fullBackupMessageCount: safeMessages.length,
    fullBackupFirstIndex: safeMessages[0]?.messageIndex ?? null,
    fullBackupLastIndex: safeMessages.at(-1)?.messageIndex ?? null,
    fullBackupLastReason: reason,
    fullBackupState: state,
    fullBackupIncident: incident,
  };
}

export function shouldPrioritizeFullBackupWarning({ meta, settings } = {}) {
  return Boolean(
    settings?.enabled
    && settings?.fullBackupEnabled
    && meta?.fullBackupState === "frozen"
    && !meta?.fullBackupIncident?.acknowledgedAt,
  );
}

function canonicalizeAll(chat, now) {
  return (Array.isArray(chat) ? chat : [])
    .map((message, index) => canonicalizeMessage(message, index, now));
}

function isFirstMessage(args) {
  return Array.isArray(args) && args.includes("first_message");
}

function matchesAll(existing, current) {
  return existing.length === current.length
    && existing.every((message, index) => message?.canonicalHash === current[index]?.canonicalHash);
}

function findUnexpectedDifference(existing, current, targetIndexes) {
  const allowed = new Set(targetIndexes);
  for (let index = 0; index < existing.length; index += 1) {
    if (allowed.has(index)) {
      continue;
    }
    if (existing[index]?.canonicalHash !== current[index]?.canonicalHash) {
      return index;
    }
  }
  return null;
}

function freeze(existing, current, eventInfo, now, kind, differingIndex = null) {
  return {
    action: "freeze",
    messages: [],
    currentMessages: current,
    eventInfo,
    incident: {
      kind,
      detectedAt: now,
      backupMessageCount: existing.length,
      observedMessageCount: current.length,
      backupUpdatedAt: existing.at(-1)?.backedUpAt ?? null,
      differingIndex,
    },
  };
}
