import test from "node:test";
import assert from "node:assert/strict";
import { commitDataset, rollbackDataset, datasetId, datasetStore } from "../src/storage/dataset-layout.js";

const manifest = { count: 4551, bytes: 479200000, digest: "verified-content" };
const task = () => ({ version: 3, id: "dataset-test-123", role: "target", phase: "verified", dataset: 1, previousDataset: 0, baseRevision: 5, manifest });

test("旧布局默认保留，非法活动标记与仓库名不能被猜测或插入 SQL", () => {
  assert.equal(datasetId(), 0);
  assert.equal(datasetStore("chat_meta"), "chat_meta");
  assert.equal(datasetStore("chat_meta", 1), "__boxed_next_chat_meta");
  for (const value of [null, "1", 2, -1, {}, NaN]) assert.throws(() => datasetId(value), /标记无效/);
  assert.throws(() => datasetStore("unknown"));
});

test("只有已验收且来源代号和修订号相符的目标才能提交；重复提交需核对真实状态", () => {
  const state = commitDataset(task(), { active: 0, revision: 5, expectedManifest: manifest });
  assert.equal(state.phase, "committed");
  assert.equal(state.commitRevision, 6);
  assert.deepEqual(commitDataset(task(), { active: 0, revision: 5, expectedManifest: { digest: manifest.digest, bytes: manifest.bytes, count: manifest.count } }), state);
  assert.deepEqual(commitDataset(state, { active: 1, revision: 6 }), state);
  for (const change of [{ active: 1 }, { revision: 6 }, { expectedManifest: { ...manifest, digest: "tampered" } }]) {
    assert.throws(() => commitDataset(task(), { active: 0, revision: 5, expectedManifest: manifest, ...change }));
  }
  assert.throws(() => commitDataset({ ...task(), phase: "staging" }, { active: 0, revision: 5, expectedManifest: manifest }));
  assert.throws(() => commitDataset(state, { active: 0, revision: 6 }));
});

test("回退只针对本任务的未激活目标，提交后修订变化时不覆盖新写入", () => {
  const state = commitDataset(task(), { active: 0, revision: 5, expectedManifest: manifest });
  assert.equal(rollbackDataset(state, { active: 1, revision: 6 }).phase, "rolling-back");
  assert.throws(() => rollbackDataset(state, { active: 1, revision: 7 }));
  assert.throws(() => rollbackDataset({ ...state, phase: "activated" }, { active: 1, revision: 6 }));
});
