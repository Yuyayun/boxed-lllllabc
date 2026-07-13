import test from "node:test";
import assert from "node:assert/strict";

import { registerPageLifecycle } from "../src/lifecycle.js";

test("页面隐藏时冲刷备份，恢复时只刷新一次", async () => {
  const documentTarget = createEventTarget({ visibilityState: "visible", hidden: false });
  const windowTarget = createEventTarget();
  const calls = [];
  const lifecycle = registerPageLifecycle({
    documentTarget,
    windowTarget,
    flushBackupEvents: async () => calls.push("flush"),
    onResume: async () => calls.push("resume"),
  });

  documentTarget.visibilityState = "hidden";
  documentTarget.hidden = true;
  documentTarget.emit("visibilitychange");
  windowTarget.emit("pagehide");
  await lifecycle.whenIdle();
  assert.deepEqual(calls, ["flush"]);

  documentTarget.visibilityState = "visible";
  documentTarget.hidden = false;
  windowTarget.emit("pageshow");
  documentTarget.emit("visibilitychange");
  await lifecycle.whenIdle();
  assert.deepEqual(calls, ["flush", "flush", "resume"]);
  lifecycle.unregister();
});

test("注销生命周期监听后不再冲刷或刷新", async () => {
  const documentTarget = createEventTarget({ visibilityState: "visible", hidden: false });
  const windowTarget = createEventTarget();
  const calls = [];
  const lifecycle = registerPageLifecycle({
    documentTarget,
    windowTarget,
    flushBackupEvents: async () => calls.push("flush"),
    onResume: async () => calls.push("resume"),
  });
  lifecycle.unregister();

  documentTarget.visibilityState = "hidden";
  documentTarget.hidden = true;
  documentTarget.emit("visibilitychange");
  windowTarget.emit("pagehide");
  await lifecycle.whenIdle();

  assert.deepEqual(calls, []);
});

function createEventTarget(initial = {}) {
  const listeners = new Map();
  return {
    ...initial,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    emit(type, event = {}) {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
  };
}
