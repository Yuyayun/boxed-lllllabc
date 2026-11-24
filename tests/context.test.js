import test from "node:test";
import assert from "node:assert/strict";

import { createContextReader } from "../src/context.js";
import { createMessageRecord } from "../src/backup/pending.js";
import { createPendingRestorePlan } from "../src/backup/restore.js";
import { executeRestorePlan } from "../src/backup/restore-executor.js";

function characterContext(chat = []) {
  return {
    characterId: 0,
    chatId: "empty-chat",
    characters: [{ name: "测试角色", avatar: "tester.png" }],
    chat,
  };
}

for (const [name, context, chatKey] of [
  ["角色聊天", characterContext(), "character:tester.png:empty-chat"],
  ["群聊", { groupId: "group-1", chatId: "empty-chat", chat: [] }, "group:group-1:empty-chat"],
]) {
  test(`已识别的空${name}仍可读取，保留原聊天数组`, () => {
    const current = createContextReader({ getContext: () => context }).readCurrentChat();

    assert.equal(current.ok, true);
    assert.equal(current.identity.chatKey, chatKey);
    assert.equal(current.chat, context.chat);
    assert.deepEqual(current.chat, []);
  });
}

test("空数组没有聊天身份时仍拒绝读取", () => {
  const current = createContextReader({ getContext: () => ({ chat: [] }) }).readCurrentChat();

  assert.equal(current.ok, false);
});

for (const chat of [undefined, null, {}]) {
  test(`有身份但聊天数据为 ${String(chat)} 时不能伪造成空聊天`, () => {
    const current = createContextReader({ getContext: () => ({ ...characterContext(), chat }) }).readCurrentChat();

    assert.equal(current.ok, false);
  });
}

test("读取酒馆上下文失败时保留失败原因", () => {
  const error = new Error("测试读取失败");
  const current = createContextReader({ getContext: () => { throw error; } }).readCurrentChat();

  assert.equal(current.ok, false);
  assert.equal(current.error, error);
});

test("已有消息的聊天继续返回原数组", () => {
  const context = characterContext([{ mes: "已有消息" }]);
  const current = createContextReader({ getContext: () => context }).readCurrentChat();

  assert.equal(current.ok, true);
  assert.equal(current.chat, context.chat);
});

test("已识别的空聊天可通过实际上下文读取器恢复第一条 pending 消息", async () => {
  const context = characterContext();
  const reader = createContextReader({ getContext: () => context });
  const chatKey = "character:tester.png:empty-chat";
  const message = { name: "测试角色", mes: "待恢复的第一条消息", swipes: ["待恢复的第一条消息"], swipe_id: 0 };
  const pending = [createMessageRecord({ chatKey, messageIndex: 0, kind: "new_message", message })];
  const plan = createPendingRestorePlan({ chat: context.chat, chatKey, pending });
  let saves = 0;

  const result = await executeRestorePlan({
    plan,
    readCurrent: () => reader.readCurrentChat(),
    readPending: async () => pending,
    writePending: async () => {},
    render: async () => {},
    save: async () => { saves += 1; },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(context.chat, [message]);
  assert.equal(saves, 1);
  assert.equal(pending.length, 1);
});
