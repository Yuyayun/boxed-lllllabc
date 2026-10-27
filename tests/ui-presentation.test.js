import test from "node:test";
import assert from "node:assert/strict";

import {
  buildVisibleChatSummary,
  formatBackupRange,
  formatCandidateSummary,
  formatStatusText,
  getStatusMessageAlignment,
  getMessagePreview,
} from "../src/ui/presentation.js";

test("楼层范围与酒馆一致从 0 开始", () => {
  assert.equal(formatBackupRange([{ messageIndex: 2 }]), "第 2 层");
  assert.equal(formatBackupRange([
    { messageIndex: 0 },
    { messageIndex: 1 },
    { messageIndex: 2 },
  ]), "第 0 层－第 2 层");
});

test("候选回复摘要显示数量和当前序号", () => {
  assert.equal(formatCandidateSummary({
    swipes: Array.from({ length: 9 }, (_, index) => ({ text: `回复 ${index + 1}` })),
    swipeIndex: 0,
  }), "候选回复 9 个 · 当前第 1 个");

  assert.equal(formatCandidateSummary({
    swipes: [{ text: "第一条" }, { text: "第二条" }],
    swipeIndex: 99,
  }), "候选回复 2 个 · 当前第 1 个");
});

test("正文预览读取当前候选回复并清理空白", () => {
  assert.equal(getMessagePreview({
    text: "旧正文",
    swipes: [{ text: "第一条" }, { text: "  当前\n\n候选   回复  " }],
    swipeIndex: 1,
  }), "当前 候选 回复");

  assert.equal(getMessagePreview({ text: "abcdefghijklmnop" }, 10), "abcdefghij...");
});

test("单人聊天摘要隐藏内部键和群聊字段", () => {
  const rows = buildVisibleChatSummary({
    chatType: "character",
    chatKey: "character:14:internal-file",
    chatFile: "测试聊天.jsonl",
    characterId: "14",
    characterName: "方亦楷",
    groupId: "group-internal",
  });

  assert.deepEqual(rows, [
    { label: "聊天名称", value: "测试聊天" },
    { label: "角色", value: "方亦楷" },
  ]);
  assert.equal(JSON.stringify(rows).includes("character:14"), false);
  assert.equal(JSON.stringify(rows).includes("群聊"), false);
});

test("群聊摘要隐藏内部键和角色字段", () => {
  const rows = buildVisibleChatSummary({
    chatType: "group",
    chatKey: "group:1:internal-file",
    chatDisplayName: "夜班闲聊",
    groupId: "1",
    groupName: "夜班群",
    characterName: "不应出现",
  });

  assert.deepEqual(rows, [
    { label: "聊天名称", value: "夜班闲聊" },
    { label: "群聊", value: "夜班群" },
  ]);
  assert.equal(JSON.stringify(rows).includes("group:1"), false);
  assert.equal(JSON.stringify(rows).includes("角色"), false);
});

test("缺少友好名称时不暴露内部编号", () => {
  assert.deepEqual(buildVisibleChatSummary({
    chatType: "character",
    chatKey: "character:14:internal-file",
    chatId: "character:14:another-internal-file",
    characterId: "14",
  }), [
    { label: "聊天名称", value: "当前聊天" },
  ]);
});

test("酒馆聊天文件标识可作为聊天名称显示", () => {
  assert.deepEqual(buildVisibleChatSummary({
    chatType: "character",
    chatId: "测试用卡 - 2026-04-25@22h39m12s330ms.jsonl",
    characterName: "测试用卡",
  }), [
    { label: "聊天名称", value: "测试用卡 - 2026-04-25@22h39m12s330ms" },
    { label: "角色", value: "测试用卡" },
  ]);
});

test("状态文字只拼接楼层范围，不添加品牌前缀", () => {
  assert.equal(formatStatusText("酒馆聊天已保存"), "酒馆聊天已保存");
  assert.equal(
    formatStatusText("正在检查保存状态", "已备份第 2 层到第 3 层"),
    "正在检查保存状态 · 已备份第 2 层到第 3 层",
  );
  assert.equal(formatStatusText("酒馆聊天已保存").startsWith("箱装辣白菜："), false);
});

test("楼层状态灯默认靠左，开启后居中", () => {
  assert.equal(getStatusMessageAlignment(undefined), "left");
  assert.equal(getStatusMessageAlignment(false), "left");
  assert.equal(getStatusMessageAlignment(true), "center");
});
