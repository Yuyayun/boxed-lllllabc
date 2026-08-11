import test from "node:test";
import assert from "node:assert/strict";

import { createMessageRecord, createPendingRecords } from "../src/backup/pending.js";
import { comparePendingWithBackend } from "../src/verifier/compare.js";
import { buildBackendChatRequest } from "../src/verifier/backend-reader.js";

test("后端比较会跳过聊天 header 并确认一致楼层", () => {
  const message = {
    name: "角色",
    mes: "回复",
    swipes: ["回复", "另一个回复"],
    swipe_id: 0,
  };
  const record = createMessageRecord({
    chatKey: "character:1:chat-a",
    messageIndex: 0,
    kind: "new_message",
    message,
    now: "2026-07-09T00:00:00.000Z",
  });

  const result = comparePendingWithBackend([
    record,
  ], [
    { chat_metadata: {}, user_name: "unused", character_name: "unused" },
    { ...message },
  ]);

  assert.deepEqual(result.confirmedIds, [record.id]);
  assert.equal(result.remaining.length, 0);
});

test("后端不一致时 pending 保留", () => {
  const record = createMessageRecord({
    chatKey: "character:1:chat-a",
    messageIndex: 0,
    kind: "message_edit",
    message: { mes: "前端内容" },
  });

  const result = comparePendingWithBackend([record], [{ mes: "后端内容" }]);

  assert.deepEqual(result.confirmedIds, []);
  assert.deepEqual(result.remaining, [record]);
});

test("旧版 Date 哈希记录在正文与全部 swipe 一致时核销", () => {
  const frontendMessage = {
    name: "角色",
    mes: "第二个回复",
    send_date: "2026-07-10 21:36:55",
    gen_started: new Date("2026-07-10T13:35:00.000Z"),
    gen_finished: new Date("2026-07-10T13:36:00.000Z"),
    swipe_id: 1,
    swipes: ["第一个回复", "第二个回复"],
    swipe_info: [{}, {}],
    extra: { token_count: 20 },
  };
  const record = createMessageRecord({
    chatKey: "character:1:chat-a",
    messageIndex: 7,
    kind: "swipe_change",
    message: frontendMessage,
  });
  delete record.hashVersion;
  delete record.message.hashVersion;
  delete record.message.raw;
  record.canonicalHash = "旧版错误哈希";

  const backendMessage = JSON.parse(JSON.stringify(frontendMessage));
  const result = comparePendingWithBackend([record], Array.from(
    { length: 8 },
    (_, index) => index === 7 ? backendMessage : { mes: String(index) },
  ));

  assert.deepEqual(result.confirmedIds, [record.id]);
  assert.deepEqual(result.remaining, []);
});

test("新版记录仍要求完整字段精确一致", () => {
  const record = createMessageRecord({
    chatKey: "character:1:chat-a",
    messageIndex: 0,
    kind: "new_message",
    message: { mes: "正文", extra: { media: ["a.png"] } },
  });

  const result = comparePendingWithBackend([record], [
    { mes: "正文", extra: { media: ["b.png"] } },
  ]);

  assert.deepEqual(result.confirmedIds, []);
  assert.deepEqual(result.remaining, [record]);
});

test("结构 pending 使用完整聊天哈希核销", () => {
  const [record] = createPendingRecords({
    chatKey: "character:1:chat-a",
    eventName: "message_deleted",
    args: [1],
    chat: [{ mes: "保留的消息" }],
  });

  const result = comparePendingWithBackend([record], [
    { chat_metadata: {} },
    { mes: "保留的消息" },
  ]);

  assert.deepEqual(result.confirmedIds, [record.id]);
  assert.deepEqual(result.remaining, []);
});

test("结构 pending 与后端不一致时继续保留", () => {
  const [record] = createPendingRecords({
    chatKey: "character:1:chat-a",
    eventName: "message_deleted",
    args: [1],
    chat: [{ mes: "删除后的内容" }],
  });

  const result = comparePendingWithBackend([record], [{ mes: "后端旧内容" }]);

  assert.deepEqual(result.confirmedIds, []);
  assert.deepEqual(result.remaining, [record]);
});

test("旧版不可核对的结构 pending 在成功读取后端时清理", () => {
  const legacyRecord = {
    id: "character:1:chat-a:structural",
    chatKey: "character:1:chat-a",
    messageIndex: null,
    kind: "structural_change",
  };

  const result = comparePendingWithBackend([legacyRecord], [{ mes: "后端消息" }]);

  assert.deepEqual(result.confirmedIds, [legacyRecord.id]);
  assert.deepEqual(result.remaining, []);
});

test("单人聊天后端请求去掉 jsonl 后缀", () => {
  const request = buildBackendChatRequest({
    identity: {
      meta: {
        chatType: "character",
        characterAvatar: "tester.png",
        chatId: "测试聊天.jsonl",
      },
    },
  });

  assert.equal(request.ok, true);
  assert.equal(request.endpoint, "/api/chats/get");
  assert.deepEqual(request.body, {
    avatar_url: "tester.png",
    file_name: "测试聊天",
  });
});

test("群聊后端请求使用群聊文件标识", () => {
  const request = buildBackendChatRequest({
    identity: {
      meta: {
        chatType: "group",
        chatId: "group-chat.jsonl",
      },
    },
  });

  assert.equal(request.ok, true);
  assert.equal(request.endpoint, "/api/chats/group/get");
  assert.deepEqual(request.body, {
    id: "group-chat",
  });
});

test("身份不足时使用面向用户的聊天文件说明", () => {
  const request = buildBackendChatRequest({ identity: {} });

  assert.equal(request.ok, false);
  assert.equal(request.reason, "无法确认当前聊天文件。");
});
