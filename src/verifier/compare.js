import {
  CANONICAL_HASH_VERSION,
  canonicalizeMessage,
  hashCanonicalChat,
  hashCanonicalMessage,
  stableStringify,
  stripChatHeader,
} from "../backup/canonicalize.js";

export function comparePendingWithBackend(pendingRecords, backendChat) {
  const backendMessages = stripChatHeader(backendChat);
  const confirmedIds = [];
  const remaining = [];

  for (const record of pendingRecords ?? []) {
    // Snapshot restores additionally require the asynchronous metadata proof.
    if (record.snapshotSaveProof) { remaining.push(record); continue; }
    if (!Number.isInteger(record.messageIndex)) {
      const isLegacyRecord = record.hashVersion !== CANONICAL_HASH_VERSION;
      if (isLegacyRecord || hashCanonicalChat(backendMessages) === record.canonicalChatHash) {
        confirmedIds.push(record.id);
      } else {
        remaining.push(record);
      }
      continue;
    }

    const backendMessage = backendMessages[record.messageIndex];
    if (!backendMessage) {
      remaining.push(record);
      continue;
    }

    const backendHash = hashCanonicalMessage(backendMessage);
    const isExactMatch = backendHash === record.canonicalHash;
    const isLegacyMatch = record.hashVersion !== CANONICAL_HASH_VERSION
      && matchesLegacyMessage(record, backendMessage);
    if (isExactMatch || isLegacyMatch) {
      confirmedIds.push(record.id);
    } else {
      remaining.push(record);
    }
  }

  return {
    confirmedIds,
    remaining,
  };
}

function matchesLegacyMessage(record, backendMessage) {
  if (!record.message || !backendMessage) {
    return false;
  }

  const backendSnapshot = canonicalizeMessage(
    backendMessage,
    record.messageIndex,
    record.message.backedUpAt,
  );
  return stableStringify(toLegacyComparable(record.message))
    === stableStringify(toLegacyComparable(backendSnapshot));
}

function toLegacyComparable(message) {
  return {
    role: message?.role ?? "",
    name: message?.name ?? "",
    isUser: Boolean(message?.isUser),
    isSystem: Boolean(message?.isSystem),
    sendDate: message?.sendDate ?? "",
    text: message?.text ?? "",
    swipeIndex: Number(message?.swipeIndex) || 0,
    swipes: (Array.isArray(message?.swipes) ? message.swipes : []).map((swipe) => ({
      index: Number(swipe?.index) || 0,
      text: String(swipe?.text ?? ""),
      raw: swipe?.raw,
    })),
  };
}
