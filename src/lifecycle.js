export function registerPageLifecycle({
  documentTarget = globalThis.document,
  windowTarget = globalThis,
  flushBackupEvents,
  onResume,
} = {}) {
  let stopped = false;
  let wasAway = isDocumentHidden(documentTarget);
  let flushQueued = false;
  let resumeQueued = false;
  let resumeRunning = false;
  let lifecycleRun = Promise.resolve();

  const reportError = (label, error) => {
    console.warn(`[boxed-lllllabc] ${label}`, error);
  };

  const queueFlush = () => {
    if (stopped || flushQueued) {
      return lifecycleRun;
    }
    flushQueued = true;
    lifecycleRun = lifecycleRun
      .then(async () => {
        try {
          await flushBackupEvents?.();
        } finally {
          flushQueued = false;
        }
      })
      .catch((error) => reportError("页面进入后台时提交备份失败", error));
    return lifecycleRun;
  };

  const queueResume = () => {
    if (stopped || resumeQueued || resumeRunning) {
      return lifecycleRun;
    }
    resumeQueued = true;
    lifecycleRun = lifecycleRun
      .then(async () => {
        resumeQueued = false;
        if (stopped) return;
        resumeRunning = true;
        try {
          await flushBackupEvents?.();
          if (!stopped) {
            await onResume?.();
          }
        } finally {
          resumeRunning = false;
        }
      })
      .catch((error) => reportError("页面恢复后刷新备份状态失败", error));
    return lifecycleRun;
  };

  const handleVisibilityChange = () => {
    if (isDocumentHidden(documentTarget)) {
      wasAway = true;
      void queueFlush();
      return;
    }
    if (wasAway) {
      wasAway = false;
      void queueResume();
    }
  };
  const handlePageHide = () => {
    wasAway = true;
    void queueFlush();
  };
  const handlePageShow = () => {
    if (!wasAway || isDocumentHidden(documentTarget)) return;
    wasAway = false;
    void queueResume();
  };

  documentTarget?.addEventListener?.("visibilitychange", handleVisibilityChange);
  windowTarget?.addEventListener?.("pagehide", handlePageHide);
  windowTarget?.addEventListener?.("pageshow", handlePageShow);

  const unregister = () => {
    stopped = true;
    documentTarget?.removeEventListener?.("visibilitychange", handleVisibilityChange);
    windowTarget?.removeEventListener?.("pagehide", handlePageHide);
    windowTarget?.removeEventListener?.("pageshow", handlePageShow);
  };

  return {
    unregister,
    whenIdle: () => lifecycleRun,
  };
}

function isDocumentHidden(documentTarget) {
  return documentTarget?.visibilityState === "hidden" || documentTarget?.hidden === true;
}
