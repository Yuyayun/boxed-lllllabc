import { createIndexedDbStorage } from '../../src/storage/indexeddb-adapter.js';
import { createBackupCoordinator } from '../../src/controllers/backup-coordinator.js';
import { createBackendVerifier } from '../../src/controllers/backend-verifier.js';
import { registerBackupEvents } from '../../src/events.js';
import { readBackupRecords, writeBackupRecords } from '../../src/storage/backup-batches.js';
import { captureSnapshot } from '../../src/snapshots/model.js';
import { readSnapshot, snapshotBatches } from '../../src/snapshots/service.js';
import { createIndexedDbBatchTransfer } from '../../src/storage/indexeddb-batch-transfer.js';
import { migrateDatabase } from '../../src/db/migration.js';
import { DB_VERSION, TRANSFER_STORES } from '../../src/db/schema.js';
import { idbRequest, runIdbTransaction } from '../../src/db/idb-helpers.js';
import { createOperationGate } from '../../src/storage/managed.js';
import { createLocalRecoveryUi } from '../../src/ui/local-recovery.js';
import { runPendingJournalContract } from './pending-journal-contract.js';
import { stableText } from '../../src/storage/value-digest.js';

const assert = (value, reason) => { if (!value) throw new Error(reason); };
const rejects = async fn => { try { await fn(); } catch { return; } throw new Error('本应拒绝'); };
const waitUntil = async fn => { const end = performance.now() + 10000; while (!fn()) { if (performance.now() > end) throw new Error('等待界面结果超时'); await new Promise(resolve => setTimeout(resolve, 20)); } };

export async function runIndexedDbBusinessContract() {
  if (location.hostname !== '127.0.0.1') throw new Error('仅限隔离 origin');
  const checks = [], add = name => { checks.push(name); console.log(`IDB_BUSINESS ${name}`); };
  const adapter = createIndexedDbStorage({ recoveryOptions: { delays: [] } }), storage = { getMode: () => 'indexeddb', open: () => adapter.open() };
  const use = async fn => { const session = await storage.open(); try { return await fn(session); } finally { session.close(); } };
  const makeCurrent = name => ({ ok: true, identity: { chatKey: `character:review.png:${name}`, meta: { chatType: 'character', characterAvatar: 'review.png', chatId: name, chatIntegrity: name } }, chat: [{ mes: 'greeting', is_user: false }], context: { chatMetadata: { integrity: name } } });
  let current = makeCurrent('one'), status, verifier;
  const disks = new Map(), settings = { enabled: true, fullBackupEnabled: true, recentBackupEnabled: true, historicalBackupEnabled: true, recentLimit: 3, backendVerifyDelayMs: 0 };
  const reader = () => ({ readCurrentChat: () => current }), read = store => use(session => readBackupRecords(session, current.identity.chatKey, store));
  const coordinator = createBackupCoordinator({ storage, getContextReader: reader, getSettings: () => settings, getLatestStatus: () => status, setStatus: next => { status = next; }, refreshVisiblePanel: async () => {},
    prepareBackup: async () => { verifier?.clearScheduledVerification(); await verifier?.whenIdle(); }, clearScheduledVerification() {}, scheduleBackendVerification() {}, scheduleBackendSnapshotVerification() {}, readChatCatalog: async () => ({ ok: true, entries: [] }) });
  verifier = createBackendVerifier({ storage, getContextReader: reader, getSettings: () => settings, getLatestStatus: () => status, setStatus: next => { status = next; }, refreshVisiblePanel: async () => {},
    readCurrentPending: coordinator.readCurrentPending, updateBackendMeta: coordinator.updateBackendMeta, createDisplayStatus: coordinator.createDisplayStatus, prioritizeFullBackupStatus: coordinator.prioritizeFullBackupStatus,
    needsFullBackupConfirmation: coordinator.needsFullBackupConfirmation, confirmFullBackup: coordinator.confirmFullBackupAfterBackendVerification, ensurePendingBackups: coordinator.ensurePendingBackups,
    preparePendingVerification: coordinator.preparePendingVerification, readBackend: async () => ({ ok: true, chat: [{ chat_metadata: current.context.chatMetadata }, ...structuredClone(disks.get(current.identity.chatKey) ?? [])] }), retryDelays: [] });
  const handlers = new Map(), eventTypes = { MESSAGE_SENT: 'message_sent', MESSAGE_RECEIVED: 'message_received', GENERATION_ENDED: 'generation_ended' };
  const events = registerBackupEvents({ eventSource: { on: (name, fn) => handlers.set(name, fn), off() {} }, eventTypes, debounceMs: 100000,
    captureTrigger: coordinator.captureTrigger, onObserved: () => { coordinator.noteSourceChange(); verifier.clearScheduledVerification(); }, onBackupNeeded: coordinator.runBackupNow });
  const emit = (name, ...args) => handlers.get(name)(...args);
  const green = async () => { disks.set(current.identity.chatKey, structuredClone(current.chat)); await verifier.verifyBackendNow({ chatKey: current.identity.chatKey }); assert(status.code === 'saved' && !(await read('pending_changes')).length, `未收尾: ${status.code}`); };
  const turn = async n => {
    current.chat.push({ mes: `user ${n}`, is_user: true, extra: { isSmallSys: false } }); emit('message_sent', current.chat.length - 1);
    current.chat.push({ mes: `answer ${n}`, is_user: false, extra: { reasoning: '' } }); emit('message_received', current.chat.length - 1); emit('generation_ended', current.chat.length);
    await events.flush(); assert((await read('pending_changes')).length > 0, '未保存操作没有持久保护'); await green();
  };
  let ui;
  try {
    await coordinator.runBackupNow({ eventName: 'extension-loaded', args: [] }); await green();
    for (let n = 0; n < 4; n++) await turn(n);
    assert((await read('full_messages')).length === current.chat.length && (await read('recent_messages')).length === settings.recentLimit, '正常完整/最近备份没有更新');
    add('连续四轮收发经过事件、协调器、真实 IndexedDB、保存核对，pending 清零并恢复 saved');
    const first = current, firstFull = await read('full_messages'); current = makeCurrent('two'); coordinator.resetObservation();
    await coordinator.runBackupNow({ eventName: 'chat-changed', args: [] }); await green(); await turn('other');
    assert((await read('full_messages')).length === 3, '切换聊天串用了完整副本');
    current = first; coordinator.resetObservation(); assert((await read('full_messages')).length === firstFull.length, '另一聊天覆盖了原聊天');
    add('聊天切换后独立备份与状态收尾，原聊天副本保留');
    const cursor = IDBIndex.prototype.openKeyCursor, count = IDBIndex.prototype.count;
    try {
      IDBIndex.prototype.openKeyCursor = function (...args) { if (this.name === 'by_chat') throw new DOMException('synthetic catalog failure', 'UnknownError'); return cursor.apply(this, args); };
      await rejects(() => use(session => session.getBackupCatalogPage()));
      await rejects(() => adapter.retryLocalReads(current.identity.chatKey));
      assert(adapter.getRecoveryState().failedReads === 1 && !adapter.getRecoveryState().writePaused, '目录重查失败错误停写');
      // Add a genuinely critical read fault, then resolve only that fault.
      IDBIndex.prototype.count = function (...args) { if (this.objectStore.name === 'full_messages') throw new DOMException('synthetic summary failure', 'UnknownError'); return count.apply(this, args); };
      await rejects(() => use(session => session.getBackupSummary(current.identity.chatKey))); assert(adapter.getRecoveryState().writePaused, '关键读取未停写');
      IDBIndex.prototype.count = count;
      await rejects(() => adapter.retryLocalReads(current.identity.chatKey));
      assert(!adapter.getRecoveryState().writePaused && adapter.getRecoveryState().failedReads === 1, '部分恢复没有分别清理故障');
      const notice = document.createElement('div'); notice.id = 'boxed-lllllabc-local-recovery'; document.body.append(notice);
      ui = createLocalRecoveryUi({ coordinator: { state: () => ({ busy: false }), retry: () => adapter.retryLocalReads(current.identity.chatKey) } });
      ui.showFault(new Error('catalog')); ui.open();
      [...document.querySelectorAll('dialog button')].find(node => node.textContent === '重新检查').click();
      await waitUntil(() => document.querySelector('dialog p')?.textContent.startsWith('本次处理未完成'));
      assert(!notice.hidden && !adapter.getRecoveryState().writePaused, '界面隐藏了非关键故障或错误停写'); ui.close();
      await turn('during-catalog-fault');
      add('目录持续失败和关键读取部分恢复期间，当前聊天真实备份仍收尾；故障 UI 保留');
      IDBIndex.prototype.openKeyCursor = cursor;
      await adapter.retryLocalReads(current.identity.chatKey); assert(adapter.getRecoveryState().failedReads === 0, '目录恢复后未清除');
      ui.open(); [...document.querySelectorAll('dialog button')].find(node => node.textContent === '重新检查').click(); await waitUntil(() => notice.hidden); notice.remove();
    } finally { IDBIndex.prototype.openKeyCursor = cursor; IDBIndex.prototype.count = count; ui?.close(); }
    const snapshot = await captureSnapshot(current, { name: 'review snapshot' });
    await use(session => session.beginSnapshot({ header: snapshot.header, identityMeta: current.identity.meta ? { ...current.identity.meta, chatKey: current.identity.chatKey } : current.identity }));
    for (const messages of snapshotBatches(snapshot.messages)) await use(session => session.appendSnapshotMessages({ id: snapshot.header.id, messages }));
    await use(session => session.publishSnapshot({ id: snapshot.header.id }));
    const saved = await use(session => readSnapshot(session, snapshot.header.id)); assert(JSON.stringify(saved.chat) === JSON.stringify(current.chat), '快照内容或索引丢失');
    const incomplete = await captureSnapshot(current, { name: 'incomplete' }); await use(session => session.beginSnapshot({ header: incomplete.header, identityMeta: { chatKey: current.identity.chatKey } }));
    await rejects(() => use(session => session.publishSnapshot({ id: incomplete.header.id })));
    assert((await use(session => session.getSnapshotHeader(incomplete.header.id))).state === 'draft', '缺层快照错误发布');
    add('快照真实创建、追加、发布、分页读回；缺层快照拒绝发布且保留 draft');
    const legacyId = crypto.randomUUID(); await adapter.transfer('source', { id: legacyId });
    try { assert((await adapter.transfer('seal', { id: legacyId })).count > 0, '旧迁移路径漏读'); } finally { await adapter.transfer('rollback', { id: legacyId }); }
    const gate = createOperationGate(); await events.pause(); await gate.pause('storage'); await gate.pause('local-recovery'); gate.resume('local-recovery');
    await rejects(() => gate.run(() => coordinator.runBackupNow({ eventName: 'paused', args: [] }))); assert(gate.isPaused(), '解除一个原因清掉了其他暂停');
    gate.resume('storage'); events.resume(); await turn('after-pause'); add('多原因暂停互不解除，解除全部暂停后真实事件备份恢复');
  } finally { events.unregister(); verifier.clearScheduledVerification(); ui?.close(); }
  // Existing structural restore contract executes the actual coordinator,
  // verifier, restore executor and IDB adapter, with synthetic host save/render.
  const structural = await runPendingJournalContract(); add('结构删除/编辑/恢复与保存后核销：既有真实存储合同再次通过');
  const migration = await migrationContract(); add('真实 IndexedDB 源/目标分批迁移，中断重开、重复批次、验货回滚及启用收尾');
  return { checks, structural, migration, hostBoundary: '宿主事件与保存文件读回使用合成夹具；未调用模型或日常酒馆' };
}

async function migrationContract() {
  const names = [0, 1].map(() => `boxed-migration-review-${crypto.randomUUID()}`);
  const opens = names.map(name => async () => { const request = indexedDB.open(name, DB_VERSION); request.onupgradeneeded = () => migrateDatabase(request.result, request.transaction); return idbRequest(request); });
  const adapters = opens.map(openDatabase => createIndexedDbStorage({ openDatabase }));
  const use = async (index, fn) => { const session = await adapters[index].open(); try { return await fn(session); } finally { session.close(); } };
  let source = createIndexedDbBatchTransfer({ openDatabase: opens[0] }), target = createIndexedDbBatchTransfer({ openDatabase: opens[1] });
  const key = 'character:migrate.png:synthetic', id = crypto.randomUUID(), job = { id, from: 'indexeddb', to: 'sqlite' }, budget = { limit: 2, bytes: 2048 };
  // Both logical roles are backed by independently named native IDB databases;
  // this verifies the IDB migration driver, not an external SQLite service.
  try {
    await use(0, session => session.putChatMeta({ chatKey: key, chatType: 'character', characterAvatar: 'migrate.png', chatId: 'synthetic' }));
    await use(0, session => session.putFullMessages({ chatKey: key, messages: Array.from({ length: 8 }, (_, messageIndex) => ({ chatKey: key, messageIndex, raw: { mes: `migration ${messageIndex}` } })) }));
    await use(0, session => session.putHistoricalChanges([{ chatKey: key, messageIndex: 0, raw: { mes: 'historical' }, firstCapturedAt: '2026-11-26T00:00:00Z' }]));
    await use(1, session => session.putChatMeta({ chatKey: 'old-target', marker: 'keep-until-commit' }));
    await source.begin({ ...job, role: 'source' }); await target.begin({ ...job, role: 'target' });
    while ((await target.prepareStep(id, budget)).phase === 'preparing') {}
    await rejects(() => use(0, session => session.putChatMeta({ chatKey: 'forbidden' })));
    let after = 0, batches = 0, summary, checkpointRolledBack = false;
    while (true) {
      const packet = await source.sourceNext(id, after, budget); if (packet.done) { summary = packet.summary; break; }
      await target.append(id, packet);
      if (!after) {
        assert((await target.status(id)).verified === 0, '写入错误记为验货');
        source = createIndexedDbBatchTransfer({ openDatabase: opens[0] }); target = createIndexedDbBatchTransfer({ openDatabase: opens[1] });
        const retry = await source.sourceNext(id, 0, budget); assert(stableText(retry) === stableText(packet), '重开后重发内容不一致'); await target.append(id, retry);
        const put = IDBObjectStore.prototype.put; let injected = false;
        IDBObjectStore.prototype.put = function (value, ...args) { if (this.transaction.db.name === names[1] && this.name === TRANSFER_STORES.meta && value.id === id && value.verifiedBatch === 1 && !injected) { injected = true; throw new DOMException('checkpoint failure', 'UnknownError'); } return put.call(this, value, ...args); };
        try { await rejects(() => target.verifyBatch(id, packet.index)); } finally { IDBObjectStore.prototype.put = put; }
        checkpointRolledBack = injected && (await target.status(id)).verified === 0; assert(checkpointRolledBack, '验货失败未回滚检查点');
      }
      await target.verifyBatch(id, packet.index); const verified = (await target.status(id)).verified; await target.verifyBatch(id, packet.index); assert((await target.status(id)).verified === verified, '重复验货重复累计');
      after = packet.index; batches++;
    }
    const old = await opens[1](); try { assert((await runIdbTransaction(old, 'chat_meta', 'readonly', tx => idbRequest(tx.objectStore('chat_meta').get('old-target')))).marker === 'keep-until-commit', '提前替换旧目标'); } finally { old.close(); }
    await target.startSeal(id, summary); while ((await target.sealStep(id, budget)).phase === 'checking') {}
    await target.commit(id, summary); await target.startSeal(id, summary, true); while (!(await target.sealStep(id, budget)).auditDone) {}
    await target.activate(id);
    for (const engine of [target, source]) { let limit = 0; while ((await engine.finishStep(id, budget)).phase !== 'finished') assert(++limit < 100, '收尾不结束'); await engine.release(id); }
    assert((await use(1, session => session.getFullMessages(key))).length === 8 && (await use(1, session => session.getHistoricalChanges(key))).length === 1, '迁移后正文或历史记录不一致');
    await use(1, session => session.putChatMeta({ chatKey: key, afterResume: true }));
    return { batches, records: summary.count, checkpointRolledBack, reopened: true, normalWritesAfterRelease: true, driver: 'two isolated native IndexedDB databases' };
  } finally { for (const name of names) await idbRequest(indexedDB.deleteDatabase(name)); }
}
