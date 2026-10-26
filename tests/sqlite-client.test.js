import test from "node:test";
import assert from "node:assert/strict";
import { createSqliteStorage } from "../src/storage/sqlite-client.js";
import { createBackupStorage } from "../src/storage/service.js";
import { encodeStorageValue, decodeStorageValue } from "../src/storage/protocol.js";
import { createBackendVerifier } from "../src/controllers/backend-verifier.js";
import { createMessageRecord } from "../src/backup/pending.js";

const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test("无后端、协议不兼容、多账户和连接超时均给出不可用状态", async () => {
  for (const [reply, code] of [
    [response({}, 404), "unavailable"],
    [response({ ok: true, protocol: 99 }), "protocol-incompatible"],
    [response({ ok: false, protocol: 1, code: "multi-user", reason: "多个账户" }, 403), "multi-user"],
  ]) {
    const adapter = createSqliteStorage({ fetchImpl: async () => reply });
    assert.equal((await adapter.status()).code, code);
    await assert.rejects(adapter.open());
  }
  const timeout = createSqliteStorage({ timeoutMs: 5, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("连接超时")))) });
  assert.equal((await timeout.status()).ok, false);
});

test("后端连接仅提供可选适配器，不改变默认 IndexedDB 或自动复制记录", async () => {
  const calls = [];
  const defaults = createBackupStorage();
  const sqlite = createSqliteStorage({ fetchImpl: async (url) => { calls.push(url); return response({ ok: true, protocol: 1 }); } });
  assert.equal((await sqlite.status()).ok, true);
  assert.equal(defaults.getMode(), "indexeddb");
  assert.deepEqual(calls, ["/api/plugins/boxed-lllllabc/status"]);
});

test("SQLite 客户端只发同源操作和原生 CSRF 头，无损读回并禁止关闭后的操作", async () => {
  const value = { date: new Date(0), optional: undefined, nested: { swipes: ["甲", "乙"], empty: null } };
  let body;
  const adapter = createSqliteStorage({ getRequestHeaders: () => ({ "X-CSRF-Token": "test-token" }), fetchImpl: async (url, options) => {
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.headers["X-CSRF-Token"], "test-token");
    if (url.endsWith("/status")) return response({ ok: true, protocol: 1 });
    body = JSON.parse(options.body);
    return response({ ok: true, protocol: 1, value: encodeStorageValue(value) });
  } });
  const session = await adapter.open();
  assert.deepEqual(await session.getChatMeta("fictional"), value);
  assert.equal(body.operation, "getChatMeta");
  assert.deepEqual(decodeStorageValue(body.args), ["fictional"]);
  assert.equal(session.deletePendingChanges, undefined);
  session.close();
  await assert.rejects(session.getChatMeta("fictional"), /关闭/);
});

test("SQLite 写入失败不回退；不支持值不会发出写入请求", async () => {
  const calls = [];
  const adapter = createSqliteStorage({ fetchImpl: async (url) => { calls.push(url); return response(url.endsWith("/status") ? { ok: true, protocol: 1 } : { ok: false, protocol: 1, code: "database-unavailable", reason: "只读" }, url.endsWith("/status") ? 200 : 503); } });
  const session = await adapter.open();
  await assert.rejects(session.putChatMeta({ chatKey: "fictional" }), /只读/);
  await assert.rejects(session.putChatMeta({ chatKey: "fictional", fn() {} }), /无法无损/);
  assert.equal(calls.length, 2);
  session.close();
});

test("带任务保护的 pending 删除必须有取消信号，已取消任务不会写入", async () => {
  let requests = 0;
  const adapter = createSqliteStorage({ fetchImpl: async () => { requests += 1; return response({ ok: true, protocol: 1 }); } });
  const session = await adapter.open();
  assert.deepEqual(await session.deletePendingChangesIfUnchanged([], { shouldDelete: () => false }), []);
  await assert.rejects(session.deletePendingChangesIfUnchanged([], { shouldDelete: () => true }), /取消信号/);
  assert.equal(requests, 1);
  session.close();
});

test("新核对任务会中止已进入 pending 删除阶段的网络取消信号", async () => {
  const chat = [{ mes: "虚构内容" }];
  const records = [createMessageRecord({ chatKey: "test", messageIndex: 0, message: chat[0], kind: "message_edit" })];
  let signal;
  let guard;
  let started;
  let finish;
  const entered = new Promise((resolve) => { started = resolve; });
  const blocked = new Promise((resolve) => { finish = resolve; });
  let status = { code: "idle" };
  const verifier = createBackendVerifier({
    getContextReader: () => ({ readCurrentChat: () => ({ ok: true, chat, identity: { chatKey: "test" } }) }),
    getSettings: () => ({ enabled: true }), getLatestStatus: () => status, setStatus: (value) => { status = value; },
    refreshVisiblePanel: async () => {}, prioritizeFullBackupStatus: async (_key, value) => value,
    readCurrentPending: async () => records, updateBackendMeta: async () => {}, createDisplayStatus: (code) => ({ code }),
    readBackend: async () => ({ ok: true, chat }),
    deleteConfirmedPending: async (_records, shouldDelete, abortSignal) => { signal = abortSignal; guard = shouldDelete; started(); await blocked; return []; },
  });
  const run = verifier.verifyBackendNow({ chatKey: "test" });
  await entered;
  assert.equal(signal.aborted, false);
  verifier.clearScheduledVerification();
  assert.equal(signal.aborted, true);
  assert.equal(guard(), false);
  finish();
  assert.notEqual((await run).code, "saved");
});
