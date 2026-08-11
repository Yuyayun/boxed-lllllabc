import { BACKEND_READ_TIMEOUT_MS } from "../verifier/backend-reader.js";

const CATALOG_TIMEOUT = Symbol("chat-catalog-timeout");

export async function readOwnerChatCatalog({
  current,
  fetchImpl = globalThis.fetch,
  timeoutMs = BACKEND_READ_TIMEOUT_MS,
  AbortControllerImpl = globalThis.AbortController,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
}) {
  const meta = current?.identity?.meta;
  if (!meta || typeof fetchImpl !== "function") {
    return { ok: false, reason: "无法读取聊天文件列表。" };
  }

  const request = meta.chatType === "group"
    ? {
        endpoint: "/api/groups/all",
        body: {},
        parse: (groups) => parseGroupCatalog(groups, meta),
      }
    : {
        endpoint: "/api/characters/chats",
        body: { avatar_url: meta.characterAvatar, simple: true },
        parse: parseCharacterCatalog,
      };
  if (meta.chatType !== "group" && !meta.characterAvatar) {
    return { ok: false, reason: "无法确认当前角色的聊天文件列表。" };
  }

  const response = await postJsonWithTimeout({
    endpoint: request.endpoint,
    body: request.body,
    headers: getRequestHeaders(current),
    fetchImpl,
    timeoutMs,
    AbortControllerImpl,
    setTimer,
    clearTimer,
  });
  if (!response.ok) {
    return response;
  }

  const entries = request.parse(response.data);
  if (!entries) {
    return { ok: false, reason: "聊天文件列表格式不可用。" };
  }
  return { ok: true, entries };
}

export function parseCharacterCatalog(data) {
  if (!Array.isArray(data)) {
    return null;
  }
  return data
    .map((item) => normalizeCatalogEntry(item))
    .filter(Boolean);
}

export function parseGroupCatalog(data, meta) {
  if (!Array.isArray(data)) {
    return null;
  }
  const groupId = String(meta?.groupId ?? "");
  const group = data.find((item) => String(item?.id ?? item?.group_id ?? "") === groupId);
  if (!group || !Array.isArray(group.chats)) {
    return null;
  }
  const currentMarker = normalizeChatMarker(meta?.chatId || meta?.chatFile);
  return group.chats.map((chatId) => ({
    marker: normalizeChatMarker(chatId),
    integrity: normalizeChatMarker(chatId) === currentMarker
      ? String(meta?.chatIntegrity ?? "")
      : "",
  })).filter((entry) => entry.marker);
}

function normalizeCatalogEntry(item) {
  const marker = normalizeChatMarker(item?.file_id || item?.file_name);
  if (!marker) {
    return null;
  }
  return {
    marker,
    integrity: String(item?.chat_metadata?.integrity ?? ""),
    fileSize: String(item?.file_size ?? ""),
    chatItems: Number.isFinite(Number(item?.chat_items)) ? Number(item.chat_items) : null,
    lastMessage: String(item?.mes ?? ""),
    lastMessageAt: String(item?.last_mes ?? ""),
  };
}

async function postJsonWithTimeout({
  endpoint,
  body,
  headers,
  fetchImpl,
  timeoutMs,
  AbortControllerImpl,
  setTimer,
  clearTimer,
}) {
  const controller = typeof AbortControllerImpl === "function"
    ? new AbortControllerImpl()
    : null;
  let timeoutHandle = null;
  const timeoutPromise = new Promise((resolve) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || typeof setTimer !== "function") {
      return;
    }
    timeoutHandle = setTimer(() => {
      resolve(CATALOG_TIMEOUT);
      controller?.abort?.();
    }, timeoutMs);
  });

  try {
    const fetchPromise = Promise.resolve().then(() => fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-cache",
      signal: controller?.signal,
    }));
    const response = await Promise.race([fetchPromise, timeoutPromise]);
    if (response === CATALOG_TIMEOUT) {
      return { ok: false, code: "timeout", reason: "聊天文件列表读取超时。" };
    }
    if (!response.ok) {
      return { ok: false, reason: "聊天文件列表读取失败。", status: response.status };
    }
    const data = await Promise.race([Promise.resolve(response.json()), timeoutPromise]);
    if (data === CATALOG_TIMEOUT) {
      return { ok: false, code: "timeout", reason: "聊天文件列表读取超时。" };
    }
    return { ok: true, data };
  } catch (error) {
    if (error?.name === "AbortError") {
      return { ok: false, code: "timeout", reason: "聊天文件列表读取超时。" };
    }
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timeoutHandle !== null && typeof clearTimer === "function") {
      clearTimer(timeoutHandle);
    }
  }
}

function getRequestHeaders(current) {
  return typeof current?.context?.getRequestHeaders === "function"
    ? current.context.getRequestHeaders()
    : { "Content-Type": "application/json" };
}

function normalizeChatMarker(value) {
  return String(value ?? "")
    .trim()
    .replace(/\.jsonl$/i, "")
    .replace(/\s+/g, " ")
    .replace(/[:|]/g, "_");
}
