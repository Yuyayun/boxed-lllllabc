import test from 'node:test';
import assert from 'node:assert/strict';
import { batchPacket, initialSummary, advanceSummary, pageBudget } from '../src/storage/transfer-batch-format.js';

const rows = () => [{ n: 1, store: 'chat_meta', key: 'test', value: { chatKey: 'test', date: new Date(0), optional: undefined } }, { n: 2, store: 'full_messages', key: ['test', 0], value: { chatKey: 'test', messageIndex: 0, raw: { mes: '你好', swipes: ['a', 'b'] } } }];

test('批次身份绑定任务、批号和完整内容；累积摘要可以持久化后继续计算', async () => {
  const packet = await batchPacket('batch-format-123', 1, rows());
  assert.equal(packet.first, 1); assert.equal(packet.last, 2);
  const first = await advanceSummary(await initialSummary(), [packet.rows[0]]);
  const resumed = await advanceSummary(structuredClone(first), [packet.rows[1]]);
  assert.deepEqual(resumed, await advanceSummary(await initialSummary(), packet.rows));
  assert.deepEqual(resumed, await advanceSummary(await initialSummary(), packet.rows, packet.bytes));
  assert.notEqual((await batchPacket('another-task-123', 1, rows())).fingerprint, packet.fingerprint);
  assert.notEqual((await batchPacket('batch-format-123', 2, rows())).fingerprint, packet.fingerprint);
  const changed = structuredClone(packet.rows); changed[1].value.raw.mes = '篡改';
  await assert.rejects(batchPacket('batch-format-123', 1, changed), /摘要/);
});

test('乱序、超额批次和不可控分页预算拒绝处理', async () => {
  const input = rows(); input[1].n = 3;
  await assert.rejects(batchPacket('batch-format-123', 1, input), /不连续/);
  await assert.rejects(batchPacket('batch-format-123', 0, rows()));
  await assert.rejects(batchPacket('batch-format-123', 1, Array.from({ length: 101 }, () => rows()[0])));
  for (const value of [{ limit: 101 }, { bytes: 2 ** 22 }, { limit: -1 }, { bytes: NaN }]) assert.throws(() => pageBudget(value));
  assert.deepEqual(pageBudget({ limit: 3, bytes: 512 }), { limit: 3, bytes: 512 });
});
