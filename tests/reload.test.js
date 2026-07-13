import test from "node:test";
import assert from "node:assert/strict";

import { createPageReloadScheduler } from "../src/reload.js";

test("自动刷新先排空备份事件再刷新酒馆", async () => {
  const calls = [];
  let callback;
  const scheduler = createPageReloadScheduler({
    beforeReload: async (reason) => calls.push(["flush", reason]),
    reloadPage: (reason) => calls.push(["reload", reason]),
    setTimer: (handler, delay) => {
      calls.push(["timer", delay]);
      callback = handler;
      return 7;
    },
  });

  assert.equal(scheduler.schedule("install"), true);
  assert.equal(scheduler.schedule("duplicate"), true);
  assert.equal(scheduler.isScheduled(), true);
  await callback();

  assert.deepEqual(calls, [
    ["timer", 900],
    ["flush", "install"],
    ["reload", "install"],
  ]);
  assert.equal(scheduler.isScheduled(), false);
});

test("排空备份事件失败时仍尝试刷新", async () => {
  const errors = [];
  let callback;
  let reloaded = false;
  const scheduler = createPageReloadScheduler({
    beforeReload: async () => { throw new Error("排空失败"); },
    reloadPage: () => { reloaded = true; },
    reportError: (...args) => errors.push(args),
    setTimer: (handler) => {
      callback = handler;
      return 9;
    },
  });

  scheduler.schedule("update");
  await callback();

  assert.equal(reloaded, true);
  assert.equal(errors.length, 1);
});

test("注销时取消尚未执行的自动刷新", () => {
  const cleared = [];
  const scheduler = createPageReloadScheduler({
    setTimer: () => 11,
    clearTimer: (timer) => cleared.push(timer),
  });

  scheduler.schedule();
  scheduler.cancel();

  assert.deepEqual(cleared, [11]);
  assert.equal(scheduler.isScheduled(), false);
});
