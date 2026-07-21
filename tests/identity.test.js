import test from "node:test";
import assert from "node:assert/strict";

import { buildChatIdentity, buildChatRenameIdentity, resolveChatRenameTarget } from "../src/identity.js";

test("为单人聊天生成稳定 chatKey", () => {
  const identity = buildChatIdentity({
    characterId: 0,
    chatId: "chat-a",
    characters: [
      {
        name: "测试角色",
        avatar: "tester.png",
      },
    ],
  });

  assert.equal(identity.ok, true);
  assert.equal(identity.chatKey, "character:tester.png:chat-a");
  assert.equal(identity.meta.chatType, "character");
  assert.equal(identity.meta.characterName, "测试角色");
  assert.deepEqual(identity.legacyChatKeys, ["character:0:chat-a"]);
});

test("为群聊生成独立命名空间 chatKey", () => {
  const identity = buildChatIdentity({
    groupId: "group-1",
    chatFile: "group-chat.jsonl",
    groups: [
      {
        id: "group-1",
        name: "测试群聊",
      },
    ],
  });

  assert.equal(identity.ok, true);
  assert.equal(identity.chatKey, "group:group-1:group-chat.jsonl");
  assert.equal(identity.meta.chatType, "group");
  assert.equal(identity.meta.groupName, "测试群聊");
});

test("同名聊天在有强标识时不会冲突", () => {
  const first = buildChatIdentity({
    characterId: 1,
    chatId: "chat-a",
    characters: [{ name: "同名" }, { name: "同名" }],
  });
  const second = buildChatIdentity({
    characterId: 2,
    chatId: "chat-a",
    characters: [{ name: "同名" }, { name: "同名" }, { name: "同名" }],
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(first.chatKey, second.chatKey);
});

test("角色数组顺序变化时仍使用头像文件名识别同一角色", () => {
  const first = buildChatIdentity({
    characterId: 0,
    chatId: "chat-a",
    chatMetadata: { integrity: "integrity-a" },
    characters: [
      { name: "测试角色", avatar: "tester.png" },
      { name: "其他角色", avatar: "other.png" },
    ],
  });
  const second = buildChatIdentity({
    characterId: 1,
    chatId: "chat-a",
    chatMetadata: { integrity: "integrity-a" },
    characters: [
      { name: "其他角色", avatar: "other.png" },
      { name: "测试角色", avatar: "tester.png" },
    ],
  });

  assert.equal(first.chatKey, "character:tester.png:chat-a");
  assert.equal(second.chatKey, first.chatKey);
  assert.equal(second.meta.chatIntegrity, "integrity-a");
});

test("身份信息不足时拒绝备份", () => {
  const identity = buildChatIdentity({
    chat: [{ mes: "hello" }],
  });

  assert.equal(identity.ok, false);
});

test("chatId 优先于可能继承父聊天的 metadata 文件名", () => {
  const identity = buildChatIdentity({
    characterId: 0,
    chatId: "branch-chat",
    chatMetadata: { file_name: "parent-chat" },
    characters: [{ name: "测试角色", avatar: "tester.png" }],
  });

  assert.equal(identity.chatKey, "character:tester.png:branch-chat");
  assert.equal(identity.meta.chatId, "branch-chat");
  assert.equal(identity.meta.chatFile, "parent-chat");
  assert.deepEqual(identity.legacyChatKeys, ["character:0:branch-chat"]);
});

test("只接受 SillyTavern 明确的对象式聊天改名参数", () => {
  const rename = buildChatRenameIdentity([{
    avatarId: "tester.png",
    groupId: undefined,
    oldFileName: "chat-a.jsonl",
    newFileName: "renamed-chat.jsonl",
  }]);

  assert.equal(rename.ok, true);
  assert.equal(rename.source.sourceKey, "character:tester.png:chat-a");
  assert.equal(rename.identity.chatKey, "character:tester.png:renamed-chat");
  assert.equal(buildChatRenameIdentity(["chat-a", "renamed-chat"]).ok, false);
});

test("群聊改名事件使用 groupId 构造定向身份", () => {
  const rename = buildChatRenameIdentity({
    avatarId: "ignored.png",
    groupId: "group-1",
    oldFileName: "group-chat.jsonl",
    newFileName: "renamed-group-chat.jsonl",
  });

  assert.equal(rename.ok, true);
  assert.equal(rename.source.sourceKey, "group:group-1:group-chat");
  assert.equal(rename.identity.chatKey, "group:group-1:renamed-group-chat");
  assert.equal(rename.identity.meta.characterAvatar, "");
});

test("服务端清洗改名时使用事件后已加载的真实聊天身份", () => {
  const eventRename = buildChatRenameIdentity({
    avatarId: "tester.png",
    oldFileName: "chat-a.jsonl",
    newFileName: "带/斜线.jsonl",
  });
  const currentIdentity = buildChatIdentity({
    characterId: 0,
    chatId: "带_斜线",
    characters: [{ name: "测试角色", avatar: "tester.png" }],
  });

  const rename = resolveChatRenameTarget(eventRename, currentIdentity);

  assert.equal(rename.source.sourceKey, "character:tester.png:chat-a");
  assert.equal(rename.identity.chatKey, "character:tester.png:带_斜线");
});
