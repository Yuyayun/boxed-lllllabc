import test from "node:test";
import assert from "node:assert/strict";

import { buildChatIdentity } from "../src/identity.js";
import { parseCharacterCatalog, parseGroupCatalog, readOwnerChatCatalog } from "../src/rename/chat-catalog.js";
import {
  confirmLegacyRenameWithStoredIntegrity,
  createLegacyRenameObservation,
  detectLegacyChatRename,
} from "../src/rename/legacy-rename.js";

test("1.15 当前聊天改名由唯一文件差异和相同内容确认", () => {
  const previous = observation("chat-a", [entry("chat-a")]);
  const next = observation("chat-b", [entry("chat-b")]);

  const result = detect(previous, next);

  assert.equal(result.status, "rename");
  assert.equal(result.reason, "matching-active-chat");
  assert.equal(result.rename.source.sourceKey, "character:tester.png:chat-a");
  assert.equal(result.rename.identity.chatKey, "character:tester.png:chat-b");
});

test("Branch 保留原文件时不会被识别成改名", () => {
  const previous = observation("chat-a", [entry("chat-a")]);
  const next = observation("chat-b", [entry("chat-a"), entry("chat-b")]);

  assert.equal(detect(previous, next).status, "not-detected");
});

test("连续 A 到 B 再到 C 的每一步都能独立识别", () => {
  const a = observation("chat-a", [entry("chat-a")]);
  const b = observation("chat-b", [entry("chat-b")]);
  const c = observation("chat-c", [entry("chat-c")]);

  assert.equal(detect(a, b).rename.identity.chatKey, "character:tester.png:chat-b");
  assert.equal(detect(b, c).rename.identity.chatKey, "character:tester.png:chat-c");
});

test("普通切换到既有聊天时不会被识别成改名", () => {
  const catalog = [entry("chat-a"), entry("chat-b")];
  const previous = observation("chat-a", catalog);
  const next = observation("chat-b", catalog);

  assert.equal(detect(previous, next).status, "not-detected");
});

test("非当前聊天可用一致 integrity 定向迁移且不会误用当前聊天身份", () => {
  const previous = observation("chat-current", [
    entry("chat-a", "same-integrity"),
    entry("chat-current", "current-integrity"),
  ]);
  const next = observation("chat-current", [
    entry("chat-b", "same-integrity"),
    entry("chat-current", "current-integrity"),
  ]);

  const result = detect(previous, next);

  assert.equal(result.status, "rename");
  assert.equal(result.reason, "matching-integrity");
  assert.equal(result.rename.identity.chatKey, "character:tester.png:chat-b");
});

test("唯一增删但内容证据不足时保留旧备份", () => {
  const previous = observation("chat-current", [entry("chat-a"), entry("chat-current")]);
  const next = observation("chat-current", [entry("chat-b"), entry("chat-current")]);

  assert.equal(detect(previous, next).status, "ambiguous");
});

test("创建或删除事件出现时禁止旧版改名推断", () => {
  const previous = observation("chat-a", [entry("chat-a")]);
  const next = observation("chat-b", [entry("chat-b")]);

  const result = detectLegacyChatRename({
    previous,
    next,
    triggers: [
      { eventName: "chat_id_changed" },
      { eventName: "chat_created" },
    ],
  });

  assert.equal(result.status, "not-detected");
  assert.equal(result.reason, "explicit-lifecycle-event");
});

test("1.15 当前群聊改名也可由完整内容确认", () => {
  const previous = groupObservation("group-a", [entry("group-a")]);
  const next = groupObservation("group-b", [entry("group-b")]);

  const result = detect(previous, next);

  assert.equal(result.status, "rename");
  assert.equal(result.rename.source.sourceKey, "group:group-1:group-a");
  assert.equal(result.rename.identity.chatKey, "group:group-1:group-b");
});

test("角色聊天目录使用轻量文件列表，避免扫描全部聊天正文", async () => {
  let request;
  const result = await readOwnerChatCatalog({
    current: makeCurrent("chat-a"),
    fetchImpl: async (endpoint, options) => {
      request = { endpoint, body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => [{
          file_name: "chat-a.jsonl",
        }],
      };
    },
  });

  assert.deepEqual(request, {
    endpoint: "/api/characters/chats",
    body: { avatar_url: "tester.png", simple: true },
  });
  assert.equal(result.ok, true);
  assert.equal(result.entries[0].marker, "chat-a");
  assert.equal(result.entries[0].integrity, "");
});

test("非当前聊天的唯一改名差异可用本地旧 integrity 与新文件头复核", async () => {
  const previous = observation("chat-current", [entry("chat-a"), entry("chat-current")]);
  const next = observation("chat-current", [entry("chat-b"), entry("chat-current")]);
  const detection = detect(previous, next);
  let requestedChatKey;

  const confirmed = await confirmLegacyRenameWithStoredIntegrity({
    rename: detection.rename,
    current: makeCurrent("chat-current"),
    readSourceMeta: async () => ({ chatIntegrity: "same-integrity" }),
    readBackend: async ({ current }) => {
      requestedChatKey = current.identity.chatKey;
      return {
        ok: true,
        chat: [{ chat_metadata: { integrity: "same-integrity" } }],
      };
    },
  });

  assert.equal(detection.status, "ambiguous");
  assert.equal(confirmed, true);
  assert.equal(requestedChatKey, "character:tester.png:chat-b");
});

test("聊天目录读取本身也有超时保护", async () => {
  const result = await readOwnerChatCatalog({
    current: makeCurrent("chat-a"),
    timeoutMs: 5,
    fetchImpl: async () => new Promise(() => {}),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "timeout");
});

test("目录解析规范化角色和群聊文件名", () => {
  assert.deepEqual(parseCharacterCatalog([{ file_name: "测试.jsonl" }]), [{
    marker: "测试",
    integrity: "",
    fileSize: "",
    chatItems: null,
    lastMessage: "",
    lastMessageAt: "",
  }]);
  assert.deepEqual(parseGroupCatalog([{
    id: "group-1",
    chats: ["群聊 A", "群聊 B.jsonl"],
  }], {
    groupId: "group-1",
    chatId: "群聊 B",
    chatIntegrity: "group-integrity",
  }), [
    { marker: "群聊 A", integrity: "" },
    { marker: "群聊 B", integrity: "group-integrity" },
  ]);
});

function detect(previous, next) {
  return detectLegacyChatRename({
    previous,
    next,
    triggers: [{ eventName: "chat_id_changed" }],
  });
}

function observation(chatId, entries) {
  return createLegacyRenameObservation({
    current: makeCurrent(chatId),
    catalogEntries: entries,
  });
}

function groupObservation(chatId, entries) {
  const identity = buildChatIdentity({
    groupId: "group-1",
    chatId,
    chatMetadata: { integrity: "group-integrity" },
    groups: [{ id: "group-1", name: "测试群组", chats: entries.map((item) => item.marker) }],
  });
  return createLegacyRenameObservation({
    current: {
      ok: true,
      identity,
      chat: [{ mes: "未变化的当前群聊" }],
      context: {},
    },
    catalogEntries: entries,
  });
}

function makeCurrent(chatId) {
  const identity = buildChatIdentity({
    characterId: 0,
    chatId,
    chatMetadata: { integrity: "current-integrity" },
    characters: [{ name: "测试角色", avatar: "tester.png" }],
  });
  return {
    ok: true,
    identity,
    chat: [{ mes: "未变化的当前聊天" }],
    context: {},
  };
}

function entry(marker, integrity = "") {
  return { marker, integrity };
}
