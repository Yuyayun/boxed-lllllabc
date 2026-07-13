import test from "node:test";
import assert from "node:assert/strict";

import {
  checkNativeExtensionVersion,
  createUpdateController,
  updateNativeExtension,
} from "../src/controllers/update-controller.js";

function response({ ok = true, status = 200, json = {}, text = "" } = {}) {
  return {
    ok,
    status,
    async json() { return json; },
    async text() { return text; },
  };
}

test("更新检查先查当前用户扩展并识别可用更新", async () => {
  const calls = [];
  const result = await checkNativeExtensionVersion({
    extensionName: "boxed-lllllabc",
    getRequestHeaders: () => ({ token: "x" }),
    fetchImpl: async (url, options) => {
      calls.push([url, JSON.parse(options.body)]);
      return response({ json: { isUpToDate: false, remoteUrl: "https://github.com/test/repo" } });
    },
  });

  assert.equal(result.isUpToDate, false);
  assert.equal(result.isGlobal, false);
  assert.deepEqual(calls, [["/api/extensions/version", { extensionName: "boxed-lllllabc", global: false }]]);
});

test("当前用户目录不存在时改查全局扩展", async () => {
  const bodies = [];
  const result = await checkNativeExtensionVersion({
    extensionName: "boxed-lllllabc",
    getRequestHeaders: () => ({}),
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      return body.global
        ? response({ json: { isUpToDate: true } })
        : response({ ok: false, status: 404 });
    },
  });

  assert.equal(result.isGlobal, true);
  assert.deepEqual(bodies.map((item) => item.global), [false, true]);
});

test("同一标签页会话复用更新检查结果", async () => {
  const states = [];
  const values = new Map();
  let fetches = 0;
  const controller = createUpdateController({
    extensionName: "boxed-lllllabc",
    getRequestHeaders: () => ({}),
    renderUpdateState: (state) => states.push(state),
    confirmUpdate: async () => false,
    sessionStore: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
    fetchImpl: async () => {
      fetches += 1;
      return response({ json: { isUpToDate: false } });
    },
  });

  await controller.checkOnce();
  await controller.checkOnce();
  assert.equal(fetches, 1);
  assert.deepEqual(states, ["available", "available"]);
});

test("确认更新时只调用酒馆原生更新接口", async () => {
  let request;
  const result = await updateNativeExtension({
    extensionName: "boxed-lllllabc",
    isGlobal: false,
    getRequestHeaders: () => ({ token: "x" }),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response({ json: { shortCommitHash: "abc1234" } });
    },
  });
  assert.equal(result.shortCommitHash, "abc1234");
  assert.equal(request.url, "/api/extensions/update");
  assert.deepEqual(JSON.parse(request.options.body), { extensionName: "boxed-lllllabc", global: false });
});
