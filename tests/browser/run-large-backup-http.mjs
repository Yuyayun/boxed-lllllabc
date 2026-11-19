import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createSqliteStorage } from '../../src/storage/sqlite-client.js';
import { writeBackupRecords, readBackupRecords } from '../../src/storage/backup-batches.js';
import { canonicalizeMessage } from '../../src/backup/canonicalize.js';
import { encodeStorageValue } from '../../src/storage/protocol.js';
import { createMessageRecord } from '../../src/backup/pending.js';

const base = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(base, 'boxed-large-http-'));
async function fixture(repository, suffix) {
  const { installRoutes } = await import(pathToFileURL(path.join(repository, 'src/router.js')).href);
  const root = path.join(directory, suffix, 'server'), storage = path.join(directory, suffix, 'storage');
  await fs.mkdir(root, { recursive: true }); await fs.mkdir(storage, { recursive: true });
  const handlers = new Map();
  const host = { root, dataRoot: path.join(root, 'data'), defaultHandle: 'default-user', users: async () => [], csrfEnabled: () => true, config: (key, fallback) => key === 'boxedLllllabc.databaseDirectory' ? storage : key === 'enableUserAccounts' ? false : fallback };
  const routes = installRoutes({ get: (name, handler) => handlers.set('GET ' + name, handler), post: (name, handler) => handlers.set('POST ' + name, handler) }, { host });
  let maxRequest = 0, dropOperation = null;
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks); maxRequest = Math.max(maxRequest, raw.byteLength);
      request.body = raw.length ? JSON.parse(raw.toString()) : undefined;
      request.protocol = 'http'; request.get = name => request.headers[name.toLowerCase()];
      request.user = { profile: { handle: 'default-user', enabled: true } }; request.session = { handle: 'default-user' };
      response.set = (key, value) => response.setHeader(key, value); response.status = code => { response.statusCode = code; return response; };
      response.json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
      const originalWrite = response.write.bind(response);
      response.write = (chunk, ...args) => { if (dropOperation && request.body?.operation === dropOperation && String(chunk).includes('"type":"result"')) { dropOperation = null; response.destroy(); return false; } return originalWrite(chunk, ...args); };
      const route = handlers.get(request.method + ' ' + new URL(request.url, 'http://localhost').pathname.replace('/api/plugins/boxed-lllllabc', ''));
      if (!route) { response.writeHead(404).end(); return; } await route(request, response);
    } catch (error) { response.writeHead(500).end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fetchImpl = (url, options) => fetch(`http://127.0.0.1:${server.address().port}${url}`, options);
  return { fetchImpl, get maxRequest() { return maxRequest; }, dropNextCommit() { dropOperation = 'commitBackupWrite'; }, dropNextPatch() { dropOperation = 'applyBackupPatch'; }, async close() { await routes.close(); await new Promise(resolve => server.close(resolve)); } };
}
const fixtures = [];
try {
  const fresh = await fixture(process.env.BOXED_SERVER_REPOSITORY, 'new'); fixtures.push(fresh);
  const session = await createSqliteStorage({ fetchImpl: fresh.fetchImpl }).open();
  assert.equal(session.capabilities.pendingBackupProof, 1);
  const protection = { ...createMessageRecord({ chatKey: 'proof', messageIndex: 0, kind: 'message_edit', message: { is_user: true, mes: 'new user body' } }), backupTargets: ['full_messages', 'historical_changes'] };
  await writeBackupRecords(session, { chatKey: 'proof', store: 'pending_changes', rows: [protection] });
  assert.deepEqual(await session.deletePendingChangesIfUnchanged([protection]), []);
  fresh.dropNextPatch();
  await assert.rejects(writeBackupRecords(session, { chatKey: 'proof', store: 'full_messages', rows: [protection.message] }), { code: 'outcome-unknown' });
  assert.equal((await readBackupRecords(session, 'proof', 'full_messages'))[0].raw.mes, 'new user body');
  assert.deepEqual(await session.deletePendingChangesIfUnchanged([protection]), []);
  await writeBackupRecords(session, { chatKey: 'proof', store: 'historical_changes', rows: [{ chatKey: 'proof', messageIndex: 0, message: protection.message, canonicalHash: protection.canonicalHash }] });
  assert.deepEqual(await session.deletePendingChangesIfUnchanged([protection]), [protection.id]);
  const rows = Array.from({ length: 3000 }, (_, index) => canonicalizeMessage({ mes: 'floor ' + index, extra: Array.from({ length: 25 }, (_, key) => ({ key, value: true, info: '' })) }, index));
  assert.throws(() => encodeStorageValue(rows), /结构超过/);
  await writeBackupRecords(session, { chatKey: 'large', store: 'full_messages', rows, replace: true, meta: { fullBackupMessageCount: 3000 } });
  const read = await readBackupRecords(session, 'large', 'full_messages'); assert.equal(read.length, 3000);
  let pagesDuringVerification = 0;
  const concurrentRead = await readBackupRecords({ ...session, getBackupPage: async options => {
    const page = await session.getBackupPage(options);
    if (++pagesDuringVerification === 1) await session.updateChatMetaSummary('large', { lastBackendStatus: 'saved' });
    return page;
  } }, 'large', 'full_messages');
  assert.equal(concurrentRead.length, 3000); assert.equal(pagesDuringVerification, 60);
  await writeBackupRecords(session, { chatKey: 'large', store: 'full_messages', rows: [canonicalizeMessage({ mes: 'edited' }, 427), canonicalizeMessage({ mes: 'new' }, 3000)], meta: { fullBackupMessageCount: 3001 } });
  assert.equal((await session.getBackupSummary('large')).counts.full_messages, 3001);
  fresh.dropNextCommit();
  const receipt = await writeBackupRecords(session, { chatKey: 'lost-response', store: 'full_messages', rows: rows.slice(0, 3), replace: true });
  assert.equal(receipt.state, 'committed'); assert.equal((await session.getBackupSummary('lost-response')).counts.full_messages, 3);
  const hugeBody = 'x'.repeat(1024 * 1024);
  const hugeRows = Array.from({ length: 129 }, (_, messageIndex) => ({ messageIndex, raw: { mes: hugeBody } }));
  await writeBackupRecords(session, { chatKey: 'over-128MiB', store: 'full_messages', rows: hugeRows, replace: true, meta: { fullBackupMessageCount: 129 } });
  const hugeRead = await readBackupRecords(session, 'over-128MiB', 'full_messages');
  assert.equal(hugeRead.length, 129); assert.equal(hugeRead.at(-1).raw.mes.length, 1024 * 1024);
  const hugeCatalog = (await session.getBackupCatalogPage({})).items.find(item => item.chatKey === 'over-128MiB');
  assert(hugeCatalog.full.storageBytes > 128 * 1024 * 1024);
  assert(fresh.maxRequest < 2 * 1024 * 1024);
  if (process.env.BOXED_OLD_FRONTEND_ROOT) {
    const { createSqliteStorage: oldClient } = await import(pathToFileURL(path.join(process.env.BOXED_OLD_FRONTEND_ROOT, 'src/storage/sqlite-client.js')).href);
    const old = await oldClient({ fetchImpl: fresh.fetchImpl }).open();
    await old.putFullMessages({ chatKey: 'old-client', messages: [rows[0]] }); assert.equal((await old.getFullMessages('old-client')).length, 1); old.close();
  }
  if (process.env.BOXED_OLD_SERVER_REPOSITORY) {
    const legacy = await fixture(process.env.BOXED_OLD_SERVER_REPOSITORY, 'old'); fixtures.push(legacy);
    const oldServer = await createSqliteStorage({ fetchImpl: legacy.fetchImpl }).open();
    await writeBackupRecords(oldServer, { chatKey: 'small', store: 'full_messages', rows: [rows[0]] });
    assert.equal((await oldServer.getFullMessages('small')).length, 1);
    if (oldServer.capabilities.boundedBackup) {
      const oldProof = { ...protection, id: 'old-proof:0', chatKey: 'old-proof' };
      await writeBackupRecords(oldServer, { chatKey: 'old-proof', store: 'pending_changes', rows: [oldProof] });
      await assert.rejects(oldServer.deletePendingChangesIfUnchanged([oldProof]), { code: 'backup-upgrade-required' });
      assert.equal((await readBackupRecords(oldServer, 'old-proof', 'pending_changes')).length, 1);
    } else await assert.rejects(writeBackupRecords(oldServer, { chatKey: 'too-big', store: 'full_messages', rows, replace: true }), { code: 'backup-upgrade-required' });
    oldServer.close();
  }
  session.close(); console.log(JSON.stringify({ newClientNewServer: true, floors: 3001, maxRequestBytes: fresh.maxRequest, hugeChatBytes: hugeCatalog.full.storageBytes, lostCommitResponseRecovered: true, lostPatchResponseRetained: true, conditionalBackupProof: true, pagesDuringVerification, oldClientNewServer: Boolean(process.env.BOXED_OLD_FRONTEND_ROOT), newClientOldServer: Boolean(process.env.BOXED_OLD_SERVER_REPOSITORY) }));
} finally {
  for (const entry of fixtures.reverse()) await entry.close();
  const resolved = await fs.realpath(directory); assert.equal(path.dirname(resolved), base); assert(path.basename(resolved).startsWith('boxed-large-http-')); await fs.rm(resolved, { recursive: true });
}
