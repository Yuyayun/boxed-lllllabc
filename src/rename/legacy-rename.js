import { hashCanonicalChat } from "../backup/canonicalize.js";
import { buildChatRenameIdentity, resolveChatRenameTarget } from "../identity.js";

const FALLBACK_EVENTS = {
  CHAT_CHANGED: "chat_id_changed",
  CHAT_CREATED: "chat_created",
  CHAT_DELETED: "chat_deleted",
  GROUP_CHAT_CREATED: "group_chat_created",
  GROUP_CHAT_DELETED: "group_chat_deleted",
  CHAT_RENAMED: "chat_renamed",
};

export function createLegacyRenameObservation({ current, catalogEntries }) {
  if (!current?.ok || !current.identity?.meta || !Array.isArray(catalogEntries)) {
    return null;
  }
  const meta = current.identity.meta;
  const ownerId = meta.chatType === "group" ? meta.groupId : meta.characterAvatar;
  if (!ownerId || !["character", "group"].includes(meta.chatType)) {
    return null;
  }
  return {
    chatType: meta.chatType,
    ownerId: String(ownerId),
    identity: current.identity,
    currentMarker: normalizeChatMarker(meta.chatId || meta.chatFile),
    currentChatHash: hashCanonicalChat(current.chat),
    catalog: new Map(catalogEntries.map((entry) => [entry.marker, { ...entry }])),
  };
}

export function updateLegacyRenameObservation(previous, current) {
  if (!previous || !current?.ok || !sameOwner(previous, current.identity?.meta)) {
    return previous;
  }
  return {
    ...previous,
    identity: current.identity,
    currentMarker: normalizeChatMarker(current.identity.meta.chatId || current.identity.meta.chatFile),
    currentChatHash: hashCanonicalChat(current.chat),
  };
}

export function detectLegacyChatRename({ previous, next, triggers = [], eventTypes = {} }) {
  if (!previous || !next || previous.chatType !== next.chatType || previous.ownerId !== next.ownerId) {
    return { status: "not-detected", reason: "owner-changed" };
  }

  const names = new Set((Array.isArray(triggers) ? triggers : []).map((trigger) => trigger?.eventName));
  if (!names.has(eventName(eventTypes, "CHAT_CHANGED"))) {
    return { status: "not-detected", reason: "no-chat-change" };
  }
  if ([
    "CHAT_CREATED",
    "CHAT_DELETED",
    "GROUP_CHAT_CREATED",
    "GROUP_CHAT_DELETED",
    "CHAT_RENAMED",
  ].some((key) => names.has(eventName(eventTypes, key)))) {
    return { status: "not-detected", reason: "explicit-lifecycle-event" };
  }

  const removed = [...previous.catalog.keys()].filter((marker) => !next.catalog.has(marker));
  const added = [...next.catalog.keys()].filter((marker) => !previous.catalog.has(marker));
  if (removed.length !== 1 || added.length !== 1) {
    return { status: "not-detected", reason: "catalog-diff-not-unique" };
  }

  const oldMarker = removed[0];
  const newMarker = added[0];
  const oldEntry = previous.catalog.get(oldMarker);
  const newEntry = next.catalog.get(newMarker);
  const payload = previous.chatType === "group"
    ? { groupId: previous.ownerId, oldFileName: oldMarker, newFileName: newMarker }
    : { avatarId: previous.ownerId, oldFileName: oldMarker, newFileName: newMarker };
  const eventRename = buildChatRenameIdentity(payload);
  if (!eventRename.ok) {
    return { status: "ambiguous", reason: eventRename.reason, oldMarker, newMarker };
  }
  const rename = resolveChatRenameTarget(eventRename, next.identity);
  const sameIntegrity = Boolean(
    oldEntry?.integrity
    && newEntry?.integrity
    && oldEntry.integrity === newEntry.integrity,
  );
  const sameActiveChat = previous.currentMarker === oldMarker
    && next.currentMarker === newMarker
    && previous.currentChatHash === next.currentChatHash;
  if (!sameIntegrity && !sameActiveChat) {
    return {
      status: "ambiguous",
      reason: "content-not-confirmed",
      rename,
      oldMarker,
      newMarker,
    };
  }
  return {
    status: "rename",
    reason: sameIntegrity ? "matching-integrity" : "matching-active-chat",
    rename,
    oldMarker,
    newMarker,
  };
}

export async function confirmLegacyRenameWithStoredIntegrity({
  rename,
  current,
  readSourceMeta,
  readBackend,
}) {
  if (!rename?.source?.sourceKey || !rename?.identity?.meta) {
    return false;
  }
  const sourceMeta = await readSourceMeta(rename.source.sourceKey);
  const sourceIntegrity = String(sourceMeta?.chatIntegrity ?? "");
  if (!sourceIntegrity) {
    return false;
  }
  const backend = await readBackend({
    current: {
      ...current,
      identity: rename.identity,
    },
  });
  const targetIntegrity = String(backend?.chat?.[0]?.chat_metadata?.integrity ?? "");
  return Boolean(backend?.ok && targetIntegrity && targetIntegrity === sourceIntegrity);
}

export function shouldRefreshLegacyRenameCatalog({ previous, current, triggers = [], eventTypes = {} }) {
  if (!previous || !sameOwner(previous, current?.identity?.meta)) {
    return true;
  }
  const names = new Set((Array.isArray(triggers) ? triggers : []).map((trigger) => trigger?.eventName));
  return [
    "CHAT_CHANGED",
    "CHAT_CREATED",
    "CHAT_DELETED",
    "GROUP_CHAT_CREATED",
    "GROUP_CHAT_DELETED",
    "CHAT_RENAMED",
  ].some((key) => names.has(eventName(eventTypes, key)));
}

function sameOwner(observation, meta) {
  const ownerId = meta?.chatType === "group" ? meta?.groupId : meta?.characterAvatar;
  return observation?.chatType === meta?.chatType && observation?.ownerId === String(ownerId ?? "");
}

function eventName(eventTypes, key) {
  return eventTypes?.[key] || FALLBACK_EVENTS[key];
}

function normalizeChatMarker(value) {
  return String(value ?? "")
    .trim()
    .replace(/\.jsonl$/i, "")
    .replace(/\s+/g, " ")
    .replace(/[:|]/g, "_");
}
