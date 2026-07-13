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
  const chatMarker = firstValue(chatFile, chatId);

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
