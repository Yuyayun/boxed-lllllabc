const DEFAULT_RELOAD_DELAY_MS = 900;

export function createPageReloadScheduler({
  beforeReload = async () => {},
  reloadPage = () => globalThis.location?.reload?.(),
  setTimer = globalThis.setTimeout?.bind(globalThis),
  clearTimer = globalThis.clearTimeout?.bind(globalThis),
  delayMs = DEFAULT_RELOAD_DELAY_MS,
  reportError = (message, error) => console.warn(message, error),
} = {}) {
  let timer = null;

  function schedule(reason = "extension-change") {
    if (timer !== null) {
      return true;
    }
    if (typeof setTimer !== "function") {
      return false;
    }

    timer = setTimer(async () => {
      timer = null;
      try {
        await beforeReload(reason);
      } catch (error) {
        reportError("[boxed-lllllabc] 自动刷新前排空备份事件失败", error);
      }

      try {
        reloadPage(reason);
      } catch (error) {
        reportError("[boxed-lllllabc] 自动刷新酒馆页面失败", error);
      }
    }, delayMs);
    return true;
  }

  function cancel() {
    if (timer === null) {
      return;
    }
    clearTimer?.(timer);
    timer = null;
  }

  return {
    cancel,
    isScheduled: () => timer !== null,
    schedule,
  };
}
