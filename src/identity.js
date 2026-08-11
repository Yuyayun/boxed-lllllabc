const EMPTY_VALUES = new Set([undefined, null, "", "null", "undefined", "NaN"]);

export function buildChatIdentity(context) {
  const chatType = detectChatType(context);
  const chatIntegrity = firstValue(
    context.chatIntegrity,
    context.chat_integrity,
    context.chatMetadata?.integrity,
    context.chat_metadata?.integrity,
  );
  const chatId = firstValue(
    context.chatId,
    context.chat_id,
    context.currentChatId,
    context.current_chat_id,
    context.chatMetadata?.chat_id,
    context.chat_metadata?.chat_id,
  );
  const chatFile = firstValue(
    context.chatFile,
    context.chat_file,
    context.chatMetadata?.file_name,
    context.chatMetadata?.filename,
    context.chatMetadata?.name,
    context.chat_metadata?.file_name,
    context.chat_metadata?.filename,
    context.chat_metadata?.name,
  );

  const groupId = firstValue(context.groupId, context.group_id, context.selected_group);
  const characterId = firstValue(context.characterId, context.character_id, context.this_chid);
  const group = findGroup(context, groupId);
  const character = findCharacter(context, characterId);
  const groupName = firstValue(group?.name, context.groupName, context.group_name);
  const characterName = firstValue(character?.name, context.characterName, context.character_name, context.name2);
  const characterAvatar = firstValue(character?.avatar, character?.filename, character?.file_name);
  const locationMarker = firstValue(context.locationHref, context.url, globalThis.location?.pathname);

  const meta = {
    chatKey: "",
    identityVersion: 2,
    chatType,
    characterId: normalizePart(characterId),
    characterName: normalizePart(characterName),
    characterAvatar: normalizePart(characterAvatar),
    groupId: normalizePart(groupId),
    groupName: normalizePart(groupName),
    chatId: normalizePart(chatId),
    chatFile: normalizePart(chatFile),
    chatIntegrity: normalizePart(chatIntegrity),
  };

  const ownerId = chatType === "group"
    ? firstValue(groupId, groupName)
    : firstValue(characterAvatar, characterId, characterName);
  const ownerPrefix = chatType === "group" ? "group" : chatType === "character" ? "character" : "unknown";
  const chatMarker = firstValue(chatId, chatFile);

  if (chatType !== "unknown" && hasValue(ownerId) && hasValue(chatMarker)) {
    meta.chatKey = [
      ownerPrefix,
      normalizePart(ownerId),
      normalizePart(chatMarker),
    ].join(":");
    return {
      ok: true,
      chatKey: meta.chatKey,
      meta,
      legacyChatKeys: buildLegacyChatKeys({
        chatType,
        characterId,
        groupId,
        groupName,
        characterName,
        chatMarker,
        currentChatKey: meta.chatKey,
      }),
    };
  }

  if (chatType !== "unknown" && hasValue(chatMarker) && hasValue(firstValue(groupName, characterName))) {
    meta.chatKey = [
      ownerPrefix,
      normalizePart(firstValue(groupName, characterName)),
      normalizePart(chatMarker),
    ].join(":");
    return { ok: true, chatKey: meta.chatKey, meta };
  }

  if (hasValue(chatId) && hasValue(locationMarker)) {
    meta.chatKey = [
      ownerPrefix,
      normalizePart(locationMarker),
      normalizePart(chatId),
    ].join(":");
    return { ok: true, chatKey: meta.chatKey, meta };
  }

  return {
    ok: false,
    reason: "当前聊天身份信息不足。",
    meta,
  };
}

export function buildChatRenameIdentity(eventArgs) {
  const payload = Array.isArray(eventArgs)
    ? eventArgs.length === 1 ? eventArgs[0] : null
    : eventArgs;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "聊天改名事件参数格式不受支持。" };
  }

  const groupId = firstValue(payload.groupId);
  const characterAvatar = firstValue(payload.avatarId);
  const oldChatId = normalizeChatFileMarker(payload.oldFileName);
  const newChatId = normalizeChatFileMarker(payload.newFileName);
  const chatType = hasValue(groupId)
    ? "group"
    : hasValue(characterAvatar)
      ? "character"
      : "unknown";
  const ownerId = chatType === "group" ? groupId : characterAvatar;
  if (chatType === "unknown" || !hasValue(ownerId) || !oldChatId || !newChatId || oldChatId === newChatId) {
    return { ok: false, reason: "聊天改名事件缺少明确的旧名称、新名称或所属对象。" };
  }

  const ownerPrefix = chatType === "group" ? "group" : "character";
  const normalizedOwner = normalizePart(ownerId);
  const sourceKey = [ownerPrefix, normalizedOwner, oldChatId].join(":");
  const targetKey = [ownerPrefix, normalizedOwner, newChatId].join(":");
  const meta = {
    chatKey: targetKey,
    identityVersion: 2,
    chatType,
    characterId: "",
    characterName: "",
    characterAvatar: chatType === "character" ? normalizedOwner : "",
    groupId: chatType === "group" ? normalizedOwner : "",
    groupName: "",
    chatId: newChatId,
    chatFile: newChatId,
    chatIntegrity: "",
  };

  return {
    ok: true,
    source: {
      chatType,
      ownerId: normalizedOwner,
      chatId: oldChatId,
      sourceKey,
    },
    identity: {
      ok: true,
      chatKey: targetKey,
      meta,
      legacyChatKeys: [],
    },
  };
}

export function resolveChatRenameTarget(rename, currentIdentity) {
  if (!rename?.ok || !currentIdentity?.ok || !currentIdentity?.chatKey || !currentIdentity?.meta) {
    return rename;
  }

  const currentMeta = currentIdentity.meta;
  if (currentMeta.chatType !== rename.source.chatType) {
    return rename;
  }
  const currentOwner = currentMeta.chatType === "group"
    ? normalizePart(currentMeta.groupId)
    : normalizePart(currentMeta.characterAvatar);
  const currentChatId = normalizeChatFileMarker(firstValue(currentMeta.chatId, currentMeta.chatFile));
  const renameTargetId = normalizeChatFileMarker(firstValue(
    rename.identity?.meta?.chatId,
    rename.identity?.meta?.chatFile,
  ));
  if (currentOwner !== rename.source.ownerId
    || !currentChatId
    || !chatRenameTargetsMatch(renameTargetId, currentChatId)) {
    return rename;
  }

  return {
    ...rename,
    identity: currentIdentity,
  };
}

function chatRenameTargetsMatch(requestedTarget, currentTarget) {
  if (requestedTarget === currentTarget) {
    return true;
  }
  const sanitizedRequested = String(requestedTarget ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/_+/g, "_");
  return sanitizedRequested === currentTarget;
}

function buildLegacyChatKeys({
  chatType,
  characterId,
  groupId,
  groupName,
  characterName,
  chatMarker,
  currentChatKey,
}) {
  const ownerPrefix = chatType === "group" ? "group" : "character";
  const legacyOwner = chatType === "group"
    ? firstValue(groupId, groupName)
    : firstValue(characterId, characterName);

  if (!hasValue(legacyOwner) || !hasValue(chatMarker)) {
    return [];
  }

  const legacyKey = [
    ownerPrefix,
    normalizePart(legacyOwner),
    normalizePart(chatMarker),
  ].join(":");
  return legacyKey === currentChatKey ? [] : [legacyKey];
}

export function detectChatType(context) {
  if (hasValue(firstValue(context.groupId, context.group_id, context.selected_group))) {
    return "group";
  }

  if (hasValue(firstValue(context.characterId, context.character_id, context.this_chid))) {
    return "character";
  }

  return "unknown";
}

export function firstValue(...values) {
  return values.find(hasValue);
}

export function hasValue(value) {
  return !EMPTY_VALUES.has(value);
}

export function normalizePart(value) {
  if (!hasValue(value)) {
    return "";
  }

  return String(value)
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[:|]/g, "_");
}

function normalizeChatFileMarker(value) {
  if (!hasValue(value)) {
    return "";
  }
  return normalizePart(String(value).replace(/\.jsonl$/i, ""));
}

function findCharacter(context, characterId) {
  if (!Array.isArray(context.characters) || !hasValue(characterId)) {
    return null;
  }

  const index = Number(characterId);
  if (Number.isInteger(index) && context.characters[index]) {
    return context.characters[index];
  }

  return context.characters.find((character) => {
    return [character?.id, character?.avatar, character?.filename, character?.file_name]
      .some((value) => String(value) === String(characterId));
  }) ?? null;
}

function findGroup(context, groupId) {
  const groups = Array.isArray(context.groups)
    ? context.groups
    : Array.isArray(context.groupCandidates)
      ? context.groupCandidates
      : [];

  if (!groups.length || !hasValue(groupId)) {
    return null;
  }

  return groups.find((group) => {
    return [group?.id, group?.chat_id, group?.name].some((value) => String(value) === String(groupId));
  }) ?? null;
}
