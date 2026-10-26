const DEFAULT_DEBOUNCE_MS = 500;

export function registerBackupEvents({
  eventSource,
  eventTypes,
  onBackupNeeded,
  onChatRenamed,
  debounceMs = DEFAULT_DEBOUNCE_MS,
}) {
  const eventNames = pickEventNames(eventTypes);
  const renameEventName = eventTypes?.CHAT_RENAMED;
  let timer = null;
  let queuedTriggers = [];
  let queuedRun = Promise.resolve();
  let stopped = false;
  let paused = false;
  const handlers = new Map();

  const schedule = (trigger) => {
    if (stopped || paused) {
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

  const enqueueRename = (trigger) => {
    if (stopped || paused) {
      return queuedRun;
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    // CHAT_RENAMED is emitted after SillyTavern reloads the renamed chat. Keep
    // preceding events, but process them only after the explicit old-to-new
    // migration so they cannot create the target key first.
    const precedingTriggers = queuedTriggers;
    queuedTriggers = [];
    queuedRun = queuedRun
      .then(async () => {
        await onChatRenamed?.(trigger);
        await onBackupNeeded({
          eventName: "batched",
          args: [],
          triggers: [...precedingTriggers, trigger],
        });
      })
      .catch((error) => {
        console.error("[boxed-lllllabc] 聊天改名事件处理失败", error);
      });
    return queuedRun;
  };

  for (const eventName of eventNames) {
    if (typeof eventSource?.on === "function") {
      const handler = (...args) => {
        const trigger = { eventName, args };
        if (renameEventName && eventName === renameEventName) {
          return enqueueRename(trigger);
        }
        return schedule(trigger);
      };
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
    async pause() { paused = true; await enqueueQueuedTriggers(); },
    resume() { paused = false; },
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
    eventTypes.GROUP_CHAT_CREATED,
    eventTypes.CHAT_RENAMED,
    eventTypes.CHAT_DELETED,
    eventTypes.GROUP_CHAT_DELETED,
    eventTypes.GROUP_UPDATED,
  ].filter(Boolean);
}
