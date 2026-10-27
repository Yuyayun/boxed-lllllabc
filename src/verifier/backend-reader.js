export const BACKEND_READ_TIMEOUT_MS = 15000;

const READ_TIMEOUT = Symbol("backend-read-timeout");
const READ_SUPERSEDED = Symbol("backend-read-superseded");

export async function readBackendChat({
  current,
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = BACKEND_READ_TIMEOUT_MS,
  AbortControllerImpl = globalThis.AbortController,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
}) {
  const request = buildBackendChatRequest(current);
  if (!request.ok) {
    return request;
  }

  if (typeof fetchImpl !== "function") {
    return {
      ok: false,
      reason: "当前浏览器无法读取酒馆聊天文件。",
    };
  }

  if (signal?.aborted) {
    return supersededResult();
  }

  const controller = typeof AbortControllerImpl === "function"
    ? new AbortControllerImpl()
    : null;
  let timeoutHandle = null;
  let timedOut = false;
  let superseded = false;
  let removeAbortListener = () => {};
  const races = [];

  if (Number.isFinite(timeoutMs) && timeoutMs >= 0 && typeof setTimer === "function") {
    races.push(new Promise((resolve) => {
      timeoutHandle = setTimer(() => {
        timedOut = true;
        resolve(READ_TIMEOUT);
        controller?.abort?.();
      }, timeoutMs);
    }));
  }

  if (signal && typeof signal.addEventListener === "function") {
    races.push(new Promise((resolve) => {
      const onAbort = () => {
        superseded = true;
        resolve(READ_SUPERSEDED);
        controller?.abort?.();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener?.("abort", onAbort);
    }));
  }

  const headers = getRequestHeaders(current);
  const fetchPromise = Promise.resolve().then(() => fetchImpl(request.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(request.body),
    cache: "no-cache",
    signal: controller?.signal ?? signal,
  }));
  races.unshift(fetchPromise);

  let response;
  try {
    response = await Promise.race(races);
    if (response === READ_TIMEOUT) {
      return timeoutResult();
    }
    if (response === READ_SUPERSEDED) {
      return supersededResult();
    }

    if (!response.ok) {
      return {
        ok: false,
        reason: "酒馆聊天文件读取失败。",
        status: response.status,
      };
    }

    const chat = await raceRead(response.json(), races.slice(1));
    if (chat === READ_TIMEOUT) {
      return timeoutResult();
    }
    if (chat === READ_SUPERSEDED) {
      return supersededResult();
    }
    if (!Array.isArray(chat)) {
      return {
        ok: false,
        reason: "酒馆聊天文件的格式不可用。",
      };
    }

    return {
      ok: true,
      chat,
    };
  } catch (error) {
    if (superseded || signal?.aborted) {
      return supersededResult();
    }
    if (timedOut) {
      return timeoutResult();
    }
    throw error;
  } finally {
    if (timeoutHandle !== null && typeof clearTimer === "function") {
      clearTimer(timeoutHandle);
    }
    removeAbortListener();
  }
}

export function buildBackendChatRequest(current) {
  const meta = current?.identity?.meta;
  if (!meta) {
    return {
      ok: false,
      reason: "无法确认当前聊天文件。",
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

function timeoutResult() {
  return {
    ok: false,
    code: "timeout",
    reason: "酒馆聊天文件读取超过 15 秒，已停止等待。",
  };
}

function supersededResult() {
  return {
    ok: false,
    code: "superseded",
    reason: "本次核对已被新的核对取代。",
  };
}

function raceRead(readPromise, cancellationRaces) {
  return Promise.race([Promise.resolve(readPromise), ...cancellationRaces]);
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
