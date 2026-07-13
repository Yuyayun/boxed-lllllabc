import test from "node:test";
import assert from "node:assert/strict";

import {
  clampRecentLimit,
  clampVerifyDelay,
  createSettingsAccessor,
  normalizeStatusDisplayMode,
} from "../src/settings.js";

test("设置访问器补全默认值并规范化已有设置", () => {
  const extensionSettings = {
    boxed: {
      enabled: 0,
      recentLimit: 999,
      backendVerifyDelayMs: 20,
      statusDisplayMode: "other",
    },
  };
  const getSettings = createSettingsAccessor({ extensionSettings, extensionName: "boxed" });
  const settings = getSettings();

  assert.equal(settings.enabled, false);
  assert.equal(settings.recentBackupEnabled, true);
  assert.equal(settings.historicalBackupEnabled, true);
  assert.equal(settings.recentLimit, 200);
  assert.equal(settings.backendVerifyDelayMs, 500);
  assert.equal(settings.statusDisplayMode, "message");
});

test("设置数值与状态位置保持原有限制", () => {
  assert.equal(clampRecentLimit("0"), 1);
  assert.equal(clampRecentLimit("12"), 12);
  assert.equal(clampVerifyDelay("100"), 500);
  assert.equal(normalizeStatusDisplayMode("top"), "top");
  assert.equal(normalizeStatusDisplayMode("message"), "message");
});
