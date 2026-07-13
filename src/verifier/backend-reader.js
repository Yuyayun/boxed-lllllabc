export async function readBackendChat({ current, fetchImpl = globalThis.fetch }) {
  const request = buildBackendChatRequest(current);
  if (!request.ok) {
    return request;
  }

  if (typeof fetchImpl !== "function") {
    return {
      ok: false,
      reason: "当前浏览器无法请求后端。",
    };
  }

  const headers = getRequestHeaders(current);
  const response = await fetchImpl(request.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(request.body),
    cache: "no-cache",
  });

  if (!response.ok) {
    return {
      ok: false,
      reason: "后端读取失败。",
      status: response.status,
    };
  }

  const chat = await response.json();
  if (!Array.isArray(chat)) {
    return {
      ok: false,
      reason: "后端返回的聊天格式不可用。",
    };
  }

  return {
    ok: true,
    chat,
  };
}

export function buildBackendChatRequest(current) {
  const meta = current?.identity?.meta;
  if (!meta) {
    return {
      ok: false,
      reason: "当前聊天身份不可用。",
    };
  }

  if (meta.chatType === "group") {
    const id = firstValue(meta.chatId, meta.chatFile, meta.groupId);
    if (!id) {
      return {
        ok: false,
        reason: "当前群聊文件标识不可用。",
      };
    }

    return {
      ok: true,
      endpoint: "/api/chats/group/get",
      body: { id: stripJsonl(id) },
    };
  }

  const avatarUrl = firstValue(meta.characterAvatar, findCurrentCharacter(current)?.avatar);
  const fileName = firstValue(meta.chatId, meta.chatFile);
  if (!avatarUrl || !fileName) {
    return {
      ok: false,
      reason: "当前角色聊天文件标识不可用。",
    };
  }

  return {
    ok: true,
    endpoint: "/api/chats/get",
    body: {
      avatar_url: avatarUrl,
      file_name: stripJsonl(fileName),
    },
  };
}

function getRequestHeaders(current) {
  const getHeaders = current?.context?.getRequestHeaders;
  if (typeof getHeaders === "function") {
    return getHeaders();
  }

  return {
    "Content-Type": "application/json",
  };
}

function findCurrentCharacter(current) {
  const characterId = current?.context?.characterId;
  const characters = current?.context?.characters;
  if (!Array.isArray(characters)) {
    return null;
  }

  const index = Number(characterId);
  if (Number.isInteger(index) && characters[index]) {
    return characters[index];
  }

  return null;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function stripJsonl(value) {
  return String(value).replace(/\.jsonl$/i, "");
}
