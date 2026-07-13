import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalizeMessage,
  canonicalizeRecentMessages,
  hashCanonicalMessage,
} from "../src/backup/canonicalize.js";

test("消息规范化会保存所有 swipe", () => {
  const record = canonicalizeMessage({
    name: "角色",
    mes: "第二个回复",
    swipe_id: 1,
    swipes: ["第一个回复", "第二个回复", "第三个回复"],
  }, 3, "2026-07-09T00:00:00.000Z");

  assert.equal(record.messageIndex, 3);
  assert.equal(record.swipes.length, 3);
  assert.equal(record.swipes[0].text, "第一个回复");
  assert.equal(record.swipes[1].text, "第二个回复");
  assert.equal(record.swipeIndex, 1);
  assert.equal(record.normalized.hasAllKnownSwipes, true);
});

test("消息规范化保留完整原始消息", () => {
  const record = canonicalizeMessage({
    mes: "正文",
    extra: { reasoning: "思考", media: ["image.png"] },
    swipe_info: [{ extra: { token_count: 10 } }],
  }, 0);

  assert.deepEqual(record.raw.extra, {
    reasoning: "思考",
    media: ["image.png"],
  });
  assert.deepEqual(record.raw.swipe_info, [{ extra: { token_count: 10 } }]);
});

test("前端 Date 与 JSONL 日期字符串生成相同哈希", () => {
  const started = new Date("2026-07-10T13:30:00.000Z");
  const finished = new Date("2026-07-10T13:31:00.000Z");
  const frontendMessage = {
    mes: "生成内容",
    gen_started: started,
    gen_finished: finished,
    swipes: ["生成内容"],
    swipe_id: 0,
    swipe_info: [{
      gen_started: started,
      gen_finished: finished,
      extra: {},
    }],
  };
  const backendMessage = JSON.parse(JSON.stringify(frontendMessage));

  assert.equal(
    hashCanonicalMessage(frontendMessage),
    hashCanonicalMessage(backendMessage),
  );
});

test("没有 swipes 字段时降级保存正文", () => {
  const record = canonicalizeMessage({
    is_user: true,
    mes: "用户消息",
  }, 0);

  assert.equal(record.role, "user");
  assert.equal(record.swipes.length, 1);
  assert.equal(record.swipes[0].text, "用户消息");
  assert.deepEqual(record.normalized.warnings, ["swipes_missing"]);
});

test("最近消息只取最新 N 层并保留原始楼层编号", () => {
  const messages = [
    { mes: "0" },
    { mes: "1" },
    { mes: "2" },
    { mes: "3" },
  ];

  const records = canonicalizeRecentMessages(messages, 2, "2026-07-09T00:00:00.000Z");

  assert.equal(records.length, 2);
  assert.equal(records[0].messageIndex, 2);
  assert.equal(records[1].messageIndex, 3);
});
