import {
  CANONICAL_HASH_VERSION,
  canonicalizeMessage,
  hashCanonicalChat,
  hashCanonicalMessage,
} from "./canonicalize.js";

const SKIP_PENDING_EVENTS = new Set([
  "chat_id_changed",
  "chat_loaded",
  "chat_created",
  "chat_deleted",
  "debug-refresh",
  "extension-loaded",
  "lifecycle-resume",
  "manual-refresh",
  "settings-enabled-changed",
  "settings-limit-changed",
  "settings-recent-enabled-changed",
  'restore-complete',
  'snapshot-restored',
  'storage-recovery-complete',
]);

export function createPendingRecords({ chat, chatKey, eventName, args = [], now = new Date().toISOString() }) {
  if (!chatKey || SKIP_PENDING_EVENTS.has(eventName) || isLoadOnlyMessageEvent(args)) {
    return [];
  }

  const safeChat = Array.isArray(chat) ? chat : [];
  const messageIndex = inferMessageIndex(eventName, args, safeChat.length);
  const kind = inferPendingKind(eventName);

  if (messageIndex === null) {
    return [createStructuralRecord({ chatKey, kind, chat: safeChat, now })];
  }

  const message = safeChat[messageIndex];
  if (!message) {
    return [createStructuralRecord({
      chatKey,
      kind: "structural_change",
      chat: safeChat,
      now,
    })];
  }

  if (isPendingSwipeGeneration(eventName, message)) {
    return [];
  }

  return [createMessageRecord({
    chatKey,
    messageIndex,
    kind,
    message,
    now,
  })];
}

function isLoadOnlyMessageEvent(args) {
  return args.some((value) => value === "first_message");
}

export function createMessageRecord({ chatKey, messageIndex, kind, message, now = new Date().toISOString() }) {
  return {
    id: `${chatKey}:${messageIndex}`,
    chatKey,
    messageIndex,
    kind,
    message: canonicalizeMessage(message, messageIndex, now),
    hashVersion: CANONICAL_HASH_VERSION,
    canonicalHash: hashCanonicalMessage(message),
    createdAt: now,
    updatedAt: now,
  };
}

export function summarizePendingChanges(records) {
  const safeRecords = (Array.isArray(records) ? records : []).filter(row=>row.pendingType!=='message_part');
  const numericIndexes = safeRecords
    .map((record) => record.messageIndex)
    .filter((value) => Number.isInteger(value))
    .sort((a, b) => a - b);

  if (!numericIndexes.length) {
    return {
      count: safeRecords.length,
      firstIndex: null,
      lastIndex: null,
      rangeText: safeRecords.length ? `改动记录，共 ${safeRecords.length} 项` : "",
    };
  }

  const firstIndex = numericIndexes[0];
  const lastIndex = numericIndexes[numericIndexes.length - 1];

  return {
    count: safeRecords.length,
    firstIndex,
    lastIndex,
    rangeText: safeRecords.some(row=>!Number.isInteger(row.messageIndex))?`改动记录，共 ${safeRecords.length} 项`:formatPendingRange(firstIndex, lastIndex),
  };
}

export function formatPendingRange(firstIndex, lastIndex = firstIndex) {
  if (!Number.isInteger(firstIndex)) {
    return "";
  }

  const firstFloor = firstIndex;
  const lastFloor = Number.isInteger(lastIndex) ? lastIndex : firstFloor;

  if (firstFloor === lastFloor) {
    return `改动记录：第 ${firstFloor} 层`;
  }

  return `改动记录：第 ${firstFloor}–${lastFloor} 层`;
}

export function inferPendingKind(eventName = "") {
  if(eventName==='message_swipe_deleted')return 'swipe_change';
  if(eventName==='message_reasoning_deleted')return 'message_edit';
  if (eventName.includes("deleted")) {
    return eventName.includes("message") ? "message_delete" : "structural_change";
  }

  if (eventName.includes("swipe")) {
    return "swipe_change";
  }

  if (eventName.includes("edited") || eventName.includes("updated") || eventName.includes("reasoning")) {
    return "message_edit";
  }

  if (eventName.includes("sent") || eventName.includes("received") || eventName.includes("generation")) {
    return "new_message";
  }

  return "structural_change";
}

export function inferMessageIndex(eventName = "", args = [], chatLength = 0) {
  const values=args.map(value=>value&&typeof value==='object'?value.messageId:value);
  const numberArg = values.find(value => (typeof value==='number'||typeof value==='string'&&value.trim())&&Number.isInteger(Number(value)));
  if (numberArg !== undefined) {
    const index = Number(numberArg);
    if (eventName.includes("generation") && index === chatLength && chatLength > 0) {
      return chatLength - 1;
    }

    if (index >= 0 && index < chatLength) {
      return index;
    }
  }

  if (eventName.includes("deleted")) {
    return null;
  }

  return chatLength > 0 ? chatLength - 1 : null;
}

function isPendingSwipeGeneration(eventName, message) {
  if (eventName !== "message_swiped" || !Array.isArray(message?.swipes)) {
    return false;
  }

  const swipeIndex = Number(message.swipe_id);
  return Number.isInteger(swipeIndex) && swipeIndex >= message.swipes.length;
}

export function createStructuralPendingRecord({
  chatKey,
  kind = "structural_change",
  chat,
  now = new Date().toISOString(),
}) {
  const safeChat = Array.isArray(chat) ? chat : [];
  return {
    id: `${chatKey}:structural`,
    chatKey,
    messageIndex: null,
    kind,
    message: null,
    canonicalHash: "",
    hashVersion: CANONICAL_HASH_VERSION,
    canonicalChatHash: hashCanonicalChat(safeChat),
    chatLength: safeChat.length,
    createdAt: now,
    updatedAt: now,
  };
}

function createStructuralRecord(options) {
  return createStructuralPendingRecord(options);
}
