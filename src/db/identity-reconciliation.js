export function selectIdentityReconciliationSource({ identity, metas = [] } = {}) {
  const targetKey = String(identity?.chatKey ?? "");
  if (!targetKey) {
    return { status: "invalid" };
  }

  const safeMetas = Array.isArray(metas) ? metas.filter((meta) => meta?.chatKey) : [];
  if (safeMetas.some((meta) => meta.chatKey === targetKey)) {
    return { status: "current", sourceKey: targetKey };
  }

  const candidates = safeMetas.filter((meta) => (
    meta.chatKey !== targetKey
    && sameChatType(meta, identity.meta)
    && sameOwner(meta, identity.meta)
  ));
  const legacyKeys = new Set(Array.isArray(identity.legacyChatKeys) ? identity.legacyChatKeys : []);
  const locationMatches = candidates.filter((meta) => (
    legacyKeys.has(meta.chatKey) || sameChatLocation(meta, identity.meta)
  ));
  if (locationMatches.length === 1) {
    return { status: "migrate", sourceKey: locationMatches[0].chatKey, reason: "location" };
  }
  if (locationMatches.length > 1) {
    return { status: "ambiguous", reason: "location" };
  }

  const integrity = String(identity.meta?.chatIntegrity ?? "");
  if (!integrity) {
    return { status: "new" };
  }

  const integrityMatches = candidates.filter((meta) => String(meta.chatIntegrity ?? "") === integrity);
  if (integrityMatches.length === 1) {
    return { status: "migrate", sourceKey: integrityMatches[0].chatKey, reason: "integrity" };
  }
  if (integrityMatches.length > 1) {
    return { status: "ambiguous", reason: "integrity" };
  }

  return { status: "new" };
}

export function mergeIdentityMeta(previous, identityMeta) {
  const merged = { ...(previous ?? {}) };
  for (const [key, value] of Object.entries(identityMeta ?? {})) {
    if (value !== "" && value !== undefined && value !== null) {
      merged[key] = value;
    }
  }
  return merged;
}

export function rekeyBackupRecord(record, targetKey, type) {
  const next = {
    ...record,
    chatKey: targetKey,
  };
  if (type === "pending") {
    const suffix = record?.messageIndex === null ? "structural" : record?.messageIndex;
    next.id = `${targetKey}:${suffix}`;
  }
  return next;
}

function sameChatType(left, right) {
  const leftType = String(left?.chatType ?? "");
  const rightType = String(right?.chatType ?? "");
  return !leftType || !rightType || leftType === rightType;
}

function sameOwner(left, right) {
  if (right?.chatType === "group") {
    return sameNonEmptyValue(left?.groupId, right?.groupId);
  }
  return sameNonEmptyValue(left?.characterAvatar, right?.characterAvatar);
}

function sameChatLocation(left, right) {
  const leftMarker = firstNonEmpty(left?.chatFile, left?.chatId);
  const rightMarker = firstNonEmpty(right?.chatFile, right?.chatId);
  return sameNonEmptyValue(leftMarker, rightMarker);
}

function sameNonEmptyValue(left, right) {
  const normalizedLeft = String(left ?? "");
  const normalizedRight = String(right ?? "");
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function firstNonEmpty(...values) {
  return values.find((value) => String(value ?? "") !== "") ?? "";
}
