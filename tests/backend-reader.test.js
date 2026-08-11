import test from "node:test";
import assert from "node:assert/strict";

import { readBackendChat } from "../src/verifier/backend-reader.js";

test("后端聊天读取超过上限会结束等待并中止请求", async () => {
  let requestSignal;
  const result = await readBackendChat({
    current: makeCurrent(),
    timeoutMs: 5,
    fetchImpl: async (_endpoint, options) => {
      requestSignal = options.signal;
      return new Promise(() => {});
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "timeout");
  assert.equal(requestSignal.aborted, true);
});

test("读取响应正文卡住时同样受总超时保护", async () => {
  const result = await readBackendChat({
    current: makeCurrent(),
    timeoutMs: 5,
    fetchImpl: async () => ({
      ok: true,
      json: () => new Promise(() => {}),
    }),
  });

  assert.equal(result.code, "timeout");
});

test("外部取消会把旧后端读取标记为已被取代", async () => {
  const controller = new AbortController();
  const reading = readBackendChat({
    current: makeCurrent(),
    signal: controller.signal,
    timeoutMs: 1000,
    fetchImpl: async () => new Promise(() => {}),
  });

  controller.abort();
  const result = await reading;

  assert.equal(result.ok, false);
  assert.equal(result.code, "superseded");
});

test("正常后端读取仍返回聊天数组", async () => {
  const chat = [{ chat_metadata: {} }, { mes: "内容" }];
  const result = await readBackendChat({
    current: makeCurrent(),
    timeoutMs: 100,
    fetchImpl: async () => ({ ok: true, json: async () => chat }),
  });

  assert.deepEqual(result, { ok: true, chat });
});

function makeCurrent() {
  return {
    identity: {
      meta: {
        chatType: "character",
        characterAvatar: "tester.png",
        chatId: "chat-a",
      },
    },
    context: {},
  };
}
