import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizeMessage } from "../src/backup/canonicalize.js";
import { createMessageRecord } from "../src/backup/pending.js";
import { executeRestorePlan } from "../src/backup/restore-executor.js";
import {
  createHistoricalRestorePlan,
  createFullRestorePlan,
  createPendingRestorePlan,
  createRecentRestorePlan,
} from "../src/backup/restore.js";

const chatKey = "character:1:chat-a";

test("recent 恢复按修改、pending、渲染、保存的顺序执行一次", async () => {
  const chat = makeChat(2);
  const calls = [];
  const plan = createRecentRestorePlan({
    chat,
    chatKey,
    recent: [makeBackup(2, "恢复消息")],
    pending: [],
    endIndex: 2,
  });

  const result = await executeRestorePlan({
    plan,
    readCurrent: async () => ({ ok: true, chat, identity: { chatKey } }),
    readPending: async () => [],
    writePending: async (records) => {
      calls.push(["pending", chat.length, records[0].message.text]);
    },
    render: async () => calls.push(["render", chat.length]),
    save: async () => calls.push(["save", chat.length]),
    now: "2026-07-11T00:00:00.000Z",
  });

  assert.equal(result.ok, true);
  assert.equal(chat[2].mes, "恢复消息");
  assert.deepEqual(calls, [
    ["pending", 3, "恢复消息"],
    ["render", 3],
    ["save", 3],
  ]);
});

test("recent 写 pending 失败时回滚且不渲染不保存", async () => {
  const chat = makeChat(2);
  const original = structuredClone(chat);
  let rendered = 0;
  let saved = 0;
  const plan = createRecentRestorePlan({
    chat,
    chatKey,
    recent: [makeBackup(2, "恢复消息")],
    pending: [],
    endIndex: 2,
  });

  const result = await executeRestorePlan({
    plan,
    readCurrent: async () => ({ ok: true, chat, identity: { chatKey } }),
    readPending: async () => [],
    writePending: async () => { throw new Error("数据库失败"); },
    render: async () => { rendered += 1; },
    save: async () => { saved += 1; },
  });

  assert.equal(result.stage, "pending");
  assert.deepEqual(chat, original);
  assert.equal(rendered, 0);
  assert.equal(saved, 0);
});

test("pending 来源恢复不重复写 pending", async () => {
  const chat = makeChat(1);
  const pending = [makePending(1, "丢失楼层")];
  const plan = createPendingRestorePlan({ chat, chatKey, pending });
  let writes = 0;
  let saves = 0;

  const result = await executeRestorePlan({
    plan,
    readCurrent: async () => ({ ok: true, chat, identity: { chatKey } }),
    readPending: async () => pending,
    writePending: async () => { writes += 1; },
    render: async () => {},
    save: async () => { saves += 1; },
  });

  assert.equal(result.ok, true);
  assert.equal(writes, 0);
  assert.equal(saves, 1);
  assert.equal(chat[1].mes, "丢失楼层");
});

test("确认前冲突 pending 变化会拒绝执行", async () => {
  const chat = makeChat(1);
  const pending = [makePending(1, "旧 pending")];
  const plan = createRecentRestorePlan({
    chat,
    chatKey,
    recent: [makeBackup(1, "最近备份")],
    pending,
    endIndex: 1,
  });
  let saved = 0;

  const result = await executeRestorePlan({
    plan,
    readCurrent: async () => ({ ok: true, chat, identity: { chatKey } }),
    readPending: async () => [makePending(1, "新 pending")],
    writePending: async () => {},
    render: async () => {},
    save: async () => { saved += 1; },
  });

  assert.equal(result.stage, "validate");
  assert.match(result.reason, /未保存变更/);
  assert.equal(saved, 0);
  assert.equal(chat.length, 1);
});

test("保存失败后保留前端恢复内容", async () => {
  const chat = makeChat(1);
  const pending = [makePending(1, "丢失楼层")];
  const plan = createPendingRestorePlan({ chat, chatKey, pending });

  const result = await executeRestorePlan({
    plan,
    readCurrent: async () => ({ ok: true, chat, identity: { chatKey } }),
    readPending: async () => pending,
    writePending: async () => {},
    render: async () => {},
    save: async () => { throw new Error("保存失败"); },
  });

  assert.equal(result.stage, "save");
  assert.equal(result.changed, true);
  assert.equal(chat[1].mes, "丢失楼层");
});

test("保存等待超时后恢复仍视为成功并保留后台核对线索", async () => {
  const chat = makeChat(1);
  const pending = [makePending(1, "丢失楼层")];
  const plan = createPendingRestorePlan({ chat, chatKey, pending });

  const result = await executeRestorePlan({
    plan,
    readCurrent: async () => ({ ok: true, chat, identity: { chatKey } }),
    readPending: async () => pending,
    writePending: async () => {},
    render: async () => {},
    save: async () => ({ ok: true, status: "timeout" }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.saveOutcome.status, "timeout");
  assert.equal(chat[1].mes, "丢失楼层");
});

test("历史楼层恢复按替换、pending、渲染、保存的顺序执行", async () => {
  const chat = makeChat(2);
  const calls = [];
  const plan = createHistoricalRestorePlan({
    chat,
    chatKey,
    historical: [{
      chatKey,
      messageIndex: 0,
      message: makeBackup(0, "历史第 0 层"),
    }],
    pending: [],
    messageIndex: 0,
  });

  const result = await executeRestorePlan({
    plan,
    readCurrent: async () => ({ ok: true, chat, identity: { chatKey } }),
    readPending: async () => [],
    writePending: async (records) => calls.push(["pending", records[0].messageIndex, records[0].message.text]),
    render: async () => calls.push(["render", chat[0].mes]),
    save: async () => calls.push(["save", chat[0].mes]),
  });

  assert.equal(result.ok, true);
  assert.equal(chat[0].mes, "历史第 0 层");
  assert.deepEqual(calls, [
    ["pending", 0, "历史第 0 层"],
    ["render", "历史第 0 层"],
    ["save", "历史第 0 层"],
  ]);
});

test("完整聊天恢复先替换 pending，再修改聊天、重绘和保存", async () => {
  const chat = makeChat(2);
  const calls = [];
  const plan = createFullRestorePlan({
    chat,
    chatKey,
    fullMessages: [{ ...makeBackup(0, "完整第 0 层"), chatKey }],
    pending: [],
  });

  const result = await executeRestorePlan({
    plan,
    readCurrent: async () => ({ ok: true, chat, identity: { chatKey } }),
    readPending: async () => [],
    writePending: async () => { throw new Error("不应调用增量 pending 写入"); },
    replacePending: async (records) => calls.push(["pending", chat.length, records[0].chatLength]),
    render: async () => calls.push(["render", chat.length, chat[0].mes]),
    save: async () => calls.push(["save", chat.length]),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ["pending", 2, 1],
    ["render", 1, "完整第 0 层"],
    ["save", 1],
  ]);
  assert.equal(result.pendingRecords[0].messageIndex, null);
});

test("完整聊天保护写入失败时不修改、不重绘、不保存", async () => {
  const chat = makeChat(2);
  const original = structuredClone(chat);
  let rendered = 0;
  let saved = 0;
  const plan = createFullRestorePlan({
    chat,
    chatKey,
    fullMessages: [{ ...makeBackup(0, "完整第 0 层"), chatKey }],
    pending: [],
  });

  const result = await executeRestorePlan({
    plan,
    readCurrent: async () => ({ ok: true, chat, identity: { chatKey } }),
    readPending: async () => [],
    writePending: async () => {},
    replacePending: async () => { throw new Error("数据库写保护失败"); },
    render: async () => { rendered += 1; },
    save: async () => { saved += 1; },
  });

  assert.equal(result.stage, "pending");
  assert.deepEqual(chat, original);
  assert.equal(rendered, 0);
  assert.equal(saved, 0);
});

function makeChat(length) {
  return Array.from({ length }, (_, index) => ({
    mes: `当前 ${index}`,
    swipes: [`当前 ${index}`],
    swipe_id: 0,
  }));
}

function makeBackup(messageIndex, text) {
  return canonicalizeMessage({
    mes: text,
    swipes: [text],
    swipe_id: 0,
  }, messageIndex, "2026-07-11T00:00:00.000Z");
}

function makePending(messageIndex, text) {
  return createMessageRecord({
    chatKey,
    messageIndex,
    kind: "message_edit",
    message: makeBackup(messageIndex, text).raw,
    now: "2026-07-11T00:00:00.000Z",
  });
}
