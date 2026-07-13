const SESSION_KEY_PREFIX = "boxed-lllllabc:update-check:";

export function createUpdateController({
  extensionName,
  getRequestHeaders,
  renderUpdateState,
  confirmUpdate,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  sessionStore = globalThis.sessionStorage,
  notify = defaultNotify,
  scheduleReload = defaultScheduleReload,
}) {
  let latest = null;
  const sessionKey = `${SESSION_KEY_PREFIX}${extensionName}`;

  async function checkOnce() {
    const cached = readSessionResult(sessionStore, sessionKey);
    if (cached) {
      latest = cached;
      renderUpdateState(cached.isUpToDate === false ? "available" : "hidden");
      return cached;
    }

    try {
      latest = await checkNativeExtensionVersion({ extensionName, getRequestHeaders, fetchImpl });
      writeSessionResult(sessionStore, sessionKey, latest);
      renderUpdateState(latest?.isUpToDate === false ? "available" : "hidden");
      return latest;
    } catch (error) {
      console.debug("[boxed-lllllabc] 暂时无法检查扩展更新", error);
      writeSessionResult(sessionStore, sessionKey, { isUpToDate: true, unavailable: true });
      renderUpdateState("hidden");
      return null;
    }
  }

  async function requestUpdate() {
    if (latest?.isUpToDate !== false) return { ok: false, reason: "当前没有已确认的新版本。" };
    const accepted = await confirmUpdate?.(latest);
    if (!accepted) return { ok: false, cancelled: true };

    renderUpdateState("updating");
    try {
      const result = await updateNativeExtension({
        extensionName,
        isGlobal: Boolean(latest.isGlobal),
        getRequestHeaders,
        fetchImpl,
      });
      latest = { ...latest, isUpToDate: true };
      writeSessionResult(sessionStore, sessionKey, latest);
      renderUpdateState("updated");
      const reloadScheduled = tryScheduleReload(scheduleReload);
      notify(
        reloadScheduled ? "success" : "warning",
        reloadScheduled
          ? "扩展已经更新，酒馆即将自动刷新。"
          : "扩展已经更新，但无法自动刷新，请手动刷新酒馆页面。",
        "箱装辣白菜",
      );
      return { ok: true, result, reloadScheduled };
    } catch (error) {
      console.error("[boxed-lllllabc] 扩展更新失败", error);
      renderUpdateState("available");
      notify("error", "更新失败，请稍后重试或使用酒馆扩展管理器更新。", "箱装辣白菜");
      return { ok: false, reason: error?.message || "扩展更新失败。" };
    }
  }

  return { checkOnce, requestUpdate };
}

export async function checkNativeExtensionVersion({ extensionName, getRequestHeaders, fetchImpl }) {
  if (typeof fetchImpl !== "function") throw new Error("当前环境无法检查扩展更新。");
  const localResult = await postVersionRequest({
    extensionName,
    isGlobal: false,
    getRequestHeaders,
    fetchImpl,
  });
  if (localResult.response.status !== 404) {
    return { ...localResult.data, isGlobal: false };
  }

  const globalResult = await postVersionRequest({
    extensionName,
    isGlobal: true,
    getRequestHeaders,
    fetchImpl,
  });
  return { ...globalResult.data, isGlobal: true };
}

export async function updateNativeExtension({ extensionName, isGlobal, getRequestHeaders, fetchImpl }) {
  const response = await fetchImpl("/api/extensions/update", {
    method: "POST",
    headers: getRequestHeaders(),
    body: JSON.stringify({ extensionName, global: Boolean(isGlobal) }),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `酒馆更新接口返回 ${response.status}。`);
  }
  return response.json();
}

async function postVersionRequest({ extensionName, isGlobal, getRequestHeaders, fetchImpl }) {
  const response = await fetchImpl("/api/extensions/version", {
    method: "POST",
    headers: getRequestHeaders(),
    body: JSON.stringify({ extensionName, global: Boolean(isGlobal) }),
  });
  if (!response.ok && response.status !== 404) {
    const message = await response.text();
    throw new Error(message || `酒馆版本接口返回 ${response.status}。`);
  }
  const data = response.status === 404 ? null : await response.json();
  return { response, data };
}

function readSessionResult(store, key) {
  try {
    const value = store?.getItem?.(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function writeSessionResult(store, key, result) {
  try {
    store?.setItem?.(key, JSON.stringify(result));
  } catch {
    // 会话缓存不可用不影响更新检查本身。
  }
}

function defaultNotify(type, message, title) {
  globalThis.toastr?.[type]?.(message, title);
}

function defaultScheduleReload() {
  if (typeof globalThis.setTimeout !== "function") {
    return false;
  }
  globalThis.setTimeout(() => globalThis.location?.reload?.(), 900);
  return true;
}

function tryScheduleReload(scheduleReload) {
  try {
    return scheduleReload?.() !== false;
  } catch (error) {
    console.warn("[boxed-lllllabc] 安排自动刷新失败", error);
    return false;
  }
}
