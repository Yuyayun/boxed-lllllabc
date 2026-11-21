import { createIndexedDbStorage } from '../../src/storage/indexeddb-adapter.js';
import { createBackupCoordinator } from '../../src/controllers/backup-coordinator.js';
import { createBackendVerifier } from '../../src/controllers/backend-verifier.js';
import { createRestoreController } from '../../src/controllers/restore-controller.js';
import { readBackupRecords } from '../../src/storage/backup-batches.js';
import { createFullRestorePlan, createHistoricalRestorePlan } from '../../src/backup/restore.js';
import { executeRestorePlan } from '../../src/backup/restore-executor.js';

export async function runHistoricalRepairContract({ adapter = createIndexedDbStorage(), mode = 'indexeddb' } = {}) {
  if (location.hostname !== '127.0.0.1') throw new Error('仅在隔离测试 origin 执行');
  const checks = [], assert = (condition, message) => { if (!condition) throw new Error(message); };
  const wait = async predicate => { const deadline = Date.now() + 5000; while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('等待测试操作完成超时'); };
  let sequence = 0;
  const runId = crypto.randomUUID();
  async function fixture(index = 26) {
    const key = `character:repair-test.png:${runId}-${++sequence}`, timers = new Map();
    const current = { ok: true, identity: { ok: true, chatKey: key, meta: { chatKey: key } }, chat: Array.from({ length: 1136 }, (_, i) => ({ mes: i === index ? '旧 user 正文' : `正文 ${i}`, is_user: i === index })) };
    const settings = { enabled: true, fullBackupEnabled: true, recentBackupEnabled: true, historicalBackupEnabled: true, recentLimit: 10, backendVerifyDelayMs: 2000 };
    let hook, latest = { code: 'idle' }, coordinator, verifier, nextTimer = 0;
    const setStatus = value => { latest = value; };
    const storage = { getMode: () => mode, async open() {
      const session = await adapter.open(), wrapped = { ...session };
      for (const [name, method] of Object.entries(session)) if (typeof method === 'function' && name !== 'close') wrapped[name] = async (...args) => { await hook?.(name, args); return method(...args); };
      return wrapped;
    } };
    function initialize() {
      coordinator = createBackupCoordinator({ storage, getContextReader: () => ({ readCurrentChat: () => current }), getSettings: () => settings,
        getLatestStatus: () => latest, setStatus, refreshVisiblePanel: async () => {}, readChatCatalog: async () => ({ ok: true, entries: [] }),
        prepareBackup: async () => { verifier?.clearScheduledVerification(); await verifier?.whenIdle(); },
        clearScheduledVerification: () => verifier?.clearScheduledVerification(), scheduleBackendVerification: (...args) => verifier.scheduleBackendVerification(...args), scheduleBackendSnapshotVerification: (...args) => verifier.scheduleBackendSnapshotVerification(...args) });
      verifier = createBackendVerifier({ storage, getContextReader: () => ({ readCurrentChat: () => current }), getSettings: () => settings, getLatestStatus: () => latest, setStatus, refreshVisiblePanel: async () => {},
        readCurrentPending: coordinator.readCurrentPending, updateBackendMeta: coordinator.updateBackendMeta, createDisplayStatus: coordinator.createDisplayStatus, prioritizeFullBackupStatus: coordinator.prioritizeFullBackupStatus,
        needsFullBackupConfirmation: coordinator.needsFullBackupConfirmation, confirmFullBackup: coordinator.confirmFullBackupAfterBackendVerification, ensurePendingBackups: coordinator.ensurePendingBackups, onPendingBackupsConfirmed: coordinator.onPendingBackupsConfirmed, hasBackupProblem: coordinator.hasBackupProblem,
        readBackend: async () => ({ ok: true, chat: structuredClone(current.chat) }), retryDelays: [], setTimer: callback => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimer: id => timers.delete(id) });
    }
    initialize(); await coordinator.runBackupNow({ eventName: 'extension-loaded', args: [] });
    const read = async store => { const session = await storage.open(); try { return await readBackupRecords(session, key, store); } finally { session.close(); } };
    return { storage, current, settings, key, setStatus, get latest() { return latest; }, get coordinator() { return coordinator; }, get verifier() { return verifier; }, setHook: value => { hook = value; }, read,
      restart() { verifier.clearScheduledVerification(); initialize(); }, close() { verifier.clearScheduledVerification(); },
      edit() { current.chat[index].mes = '新 user 正文'; coordinator.noteSourceChange(); return coordinator.runBackupNow({ eventName: 'message_edited', args: [index] }); },
      next() { const n = current.chat.length; current.chat.push({ mes: '下一条新消息' }); coordinator.noteSourceChange(); return coordinator.runBackupNow({ eventName: 'message_received', args: [n] }); },
      verify: () => verifier.verifyBackendNow({ chatKey: key }),
      async recover(source) {
        const chat = structuredClone(current.chat); chat[index].mes = '损坏内容'; const pending = await read('pending_changes');
        const plan = source === 'full' ? createFullRestorePlan({ chat, chatKey: key, fullMessages: await read('full_messages'), pending }) : createHistoricalRestorePlan({ chat, chatKey: key, historical: await read('historical_changes'), pending, messageIndex: index });
        const result = await executeRestorePlan({ plan, readCurrent: () => ({ ok: true, chat, identity: { chatKey: key } }), readPending: async () => pending, replacePending: async () => {}, writePending: async () => {}, render: async () => {}, save: async () => {} });
        assert(result.ok && chat[index].mes === '新 user 正文' && chat[index].is_user, `${source} 恢复未得到新 user 正文`);
      },
    };
  }

  for (const index of [26, 1116]) {
    const f = await fixture(index); let queued, cleanups = 0;
    try {
      f.setHook(async name => { if (name === 'cleanupBackupWrites' && ++cleanups === 4) { f.setHook(null); queued = f.next(); } });
      const interrupted = await f.edit(); assert(interrupted.storageErrorCode === 'backup-source-changed', `未触发预期来源中断: ${JSON.stringify(interrupted)}; cleanup=${cleanups}`);
      await queued; await f.verify(); assert(f.latest.code === 'saved' && !(await f.read('pending_changes')).length, '补写后不能确认保存');
      await f.recover('full'); await f.recover('historical'); checks.push(`user-${index}:source-interruption-and-restore`);
    } finally { f.close(); }
  }
  if (mode === 'indexeddb') {
    const f = await fixture(), original = IDBObjectStore.prototype.put, failures = new Set(['full_messages', 'historical_changes']);
    try {
      IDBObjectStore.prototype.put = function (...args) { if (failures.delete(this.name)) throw new DOMException('test quota failure', 'QuotaExceededError'); return original.apply(this, args); };
      const failed = await f.edit(); IDBObjectStore.prototype.put = original;
      assert(failed.code === 'backup-update-failed', '未触发预期事务失败');
      const pending = await f.read('pending_changes'), session = await f.storage.open();
      try { assert(!(await session.deletePendingChangesIfUnchanged(pending)).length, '备份未补齐就清除了 pending'); } finally { session.close(); }
      f.restart(); await f.coordinator.runBackupNow({ eventName: 'extension-loaded', args: [] }); await f.verify();
      assert(f.latest.code === 'saved' && !(await f.read('pending_changes')).length, '新控制器未接续持久补写记录');
      await f.recover('full'); await f.recover('historical'); checks.push('real-idb-abort-and-controller-restart');
    } finally { IDBObjectStore.prototype.put = original; f.close(); }
  }
  {
    const f = await fixture();
    try {
      await f.edit(); let pages = 0;
      f.setHook(async (name, [options]) => { if (name === 'getBackupPage' && options.store === 'full_messages' && ++pages === 2) await f.verify(); });
      assert((await f.read('full_messages')).length === 1136 && pages === 23, 'pending/meta 核对打断了 full 分页');
      checks.push('full-paging-during-verification');
    } finally { f.setHook(null); f.close(); }
  }
  {
    const f = await fixture();
    try {
      await f.edit(); await f.verify();
      f.setHook(async (name, [options]) => { if (name === 'getBackupPage' && options.store === 'full_messages') throw new Error('预览测试读取失败'); });
      const controller = createRestoreController({ storage: f.storage, getContextReader: () => ({ readCurrentChat: () => f.current }), getSettings: () => f.settings, setStatus: f.setStatus });
      const session = await adapter.open(); let summary; try { summary = await session.getBackupSummary(f.key); } finally { session.close(); }
      const result = await controller.createRestoreUiState({ current: f.current, messages: [], summary }).onPreviewFull();
      assert(!result.ok && f.latest.code === 'saved', '预览读取失败污染了保存状态'); checks.push('preview-failure-preserves-saved');
    } finally { f.setHook(null); f.close(); }
  }
  for (const phase of ['loading', 'dialog-open']) {
    const f = await fixture(); let saveCalls = 0;
    try {
      f.current.context = { saveChat: async () => { saveCalls++; } }; await f.edit();
      const controller = createRestoreController({ storage: f.storage, getContextReader: () => ({ readCurrentChat: () => f.current }), getSettings: () => f.settings, setStatus: f.setStatus,
        readCurrentPending: f.coordinator.readCurrentPending, createDisplayStatus: f.coordinator.createDisplayStatus, scheduleBackendVerification: (...args) => f.verifier.scheduleBackendVerification(...args), scheduleBackendSnapshotVerification: (...args) => f.verifier.scheduleBackendSnapshotVerification(...args), refreshVisiblePanel: async () => {} });
      const session = await adapter.open(); let summary; try { summary = await session.getBackupSummary(f.key); } finally { session.close(); }
      if (phase === 'loading') f.setHook(async (name, [options]) => { if (name === 'getBackupPage' && options.store === 'pending_changes') { f.setHook(null); await f.verify(); } });
      await controller.createRestoreUiState({ current: f.current, messages: [], summary }).onRequestSave();
      const dialog = document.getElementById('boxed-lllllabc-save-request-dialog'); assert(dialog, '未打开保存确认');
      if (phase === 'dialog-open') await f.verify();
      assert(f.latest.code === 'saved', '自动核对未完成');
      dialog.querySelector('footer button:last-child').click(); await wait(() => saveCalls === 1 && !document.getElementById('boxed-lllllabc-save-request-dialog'));
      await f.verify(); assert(f.latest.code === 'saved', '确认保存后未重新核对成功'); checks.push(`request-save:${phase}:real-dialog-and-confirm`);
    } finally { f.setHook(null); f.close(); document.getElementById('boxed-lllllabc-save-request-dialog')?.remove(); }
  }
  return checks;
}
