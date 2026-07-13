const DEFAULT_DEBOUNCE_MS = 500;

export function registerBackupEvents({
  eventSource,
  eventTypes,
  onBackupNeeded,
  debounceMs = DEFAULT_DEBOUNCE_MS,
}) {
  const eventNames = pickEventNames(eventTypes);
  let timer = null;
  let queuedTriggers = [];
  let queuedRun = Promise.resolve();
  let stopped = false;
  const handlers = new Map();

  const schedule = (trigger) => {
    if (stopped) {
      return;
    }
    queuedTriggers.push(trigger);

    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      enqueueQueuedTriggers();
    }, debounceMs);
  };

  const enqueueQueuedTriggers = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!queuedTriggers.length) {
      return queuedRun;
    }

    const triggers = queuedTriggers;
    queuedTriggers = [];
    // Keep database writes and user notifications ordered across adjacent batches.
    queuedRun = queuedRun
      .then(() => onBackupNeeded({
        eventName: "batched",
        args: [],
        triggers,
      }))
      .catch((error) => {
        console.error("[boxed-lllllabc] 事件批处理失败", error);
      });
    return queuedRun;
  };

  for (const eventName of eventNames) {
    if (typeof eventSource?.on === "function") {
      const handler = (...args) => schedule({
        eventName,
        args,
      });
      handlers.set(eventName, handler);
      eventSource.on(eventName, handler);
    }
  }

  const unregister = () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    queuedTriggers = [];

    for (const eventName of eventNames) {
      const handler = handlers.get(eventName);
      if (typeof eventSource?.off === "function") {
        eventSource.off(eventName, handler);
      } else if (typeof eventSource?.removeListener === "function") {
        eventSource.removeListener(eventName, handler);
      }
    }
  };

  return {
    flush: enqueueQueuedTriggers,
    unregister,
    whenIdle: () => queuedRun,
  };
}

export function pickEventNames(eventTypes = {}) {
  return [
    eventTypes.CHAT_LOADED,
    eventTypes.CHAT_CHANGED,
    eventTypes.MESSAGE_SENT,
    eventTypes.MESSAGE_RECEIVED,
    eventTypes.MESSAGE_EDITED,
    eventTypes.MESSAGE_DELETED,
    eventTypes.MESSAGE_UPDATED,
    eventTypes.MESSAGE_SWIPED,
    eventTypes.MESSAGE_SWIPE_DELETED,
    eventTypes.MESSAGE_REASONING_EDITED,
    eventTypes.MESSAGE_REASONING_DELETED,
    eventTypes.GENERATION_ENDED,
    eventTypes.GENERATION_STOPPED,
    eventTypes.CHAT_CREATED,
    eventTypes.CHAT_DELETED,
    eventTypes.GROUP_UPDATED,
  ].filter(Boolean);
}
