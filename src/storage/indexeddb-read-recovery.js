import { isIndexedDbFailure } from '../db/idb-errors.js';
const UNKNOWN_KEY = 'boxed-lllllabc:idb-write-unknown';
const transientNames = new Set(['UnknownError', 'InvalidStateError', 'TransactionInactiveError']);
const holdsReads = error => isIndexedDbFailure(error);
function localStore() { try { return globalThis.localStorage; } catch { return undefined; } }
export function isTransientIdbError(error) {
  return transientNames.has(error?.name) || ['backup-connection-closed', 'backup-operation-timeout'].includes(error?.code);
}
const paused = cause => Object.assign(new Error('本地备份暂时暂停，请先重新检查或处理本地备份故障。', { cause }), { code: 'backup-local-paused' });

export function createIndexedDbReadRecovery({ onFailure = () => {}, delays = [100, 300], wait = ms => new Promise(resolve => setTimeout(resolve, ms)), store = localStore() } = {}) {
  const running = new Map(), failed = new Map();
  let writeFailure, unknownFailure, memoryOnly = false, unknown = [];
  const criticalFailure = () => [...failed.values()].find(item => item.critical);
  const syncUnknown = () => {
    if (memoryOnly || typeof store?.getItem !== 'function') return;
    let raw;
    try {
      raw = store.getItem(UNKNOWN_KEY);
      const saved = JSON.parse(raw ?? '[]');
      if (!Array.isArray(saved) || saved.some(item => !item || typeof item.method !== 'string')) throw new Error('invalid marker');
      unknown = saved.slice(0, 20);
    } catch {
      if (raw != null) writeFailure = new Error('本地备份的未知结果保护记录无法核验，请先处理本地备份故障。');
      else memoryOnly = true;
    }
  };
  syncUnknown();
  const persist = () => {
    try {
      if (typeof store?.setItem !== 'function' || typeof store?.removeItem !== 'function') { memoryOnly = true; return; }
      if (unknown.length) store.setItem(UNKNOWN_KEY, JSON.stringify(unknown)); else store.removeItem(UNKNOWN_KEY);
    } catch { memoryOnly = true; }
  };
  const notify = (error, operation, critical) => { try { onFailure({ error, operation, critical }); } catch {} };
  function committed(id) {
    syncUnknown();
    unknown = unknown.filter(item => item.id !== id); persist();
    if (!unknown.length) unknownFailure = undefined;
  }
  return {
    state: () => { syncUnknown(); return { failedReads: failed.size, writePaused: Boolean(writeFailure || criticalFailure() || unknown.length), unknownWrites: [...unknown], error: writeFailure ?? criticalFailure()?.error ?? unknownFailure ?? [...failed.values()][0]?.error }; },
    async read(operation, args, run, invalidate = () => {}) {
      const key = JSON.stringify([operation, args]);
      if (failed.has(key)) throw failed.get(key).error;
      if (running.has(key)) {
        const pending = running.get(key);
        if (operation !== 'open') return pending;
        // Sessions own distinct connections; only wait for the preceding open,
        // never hand the same closeable database to two sessions.
        await pending;
        return this.read(operation, args, run, invalidate);
      }
      const pending = (async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            const result = await run();
            if (operation === 'getBackupWriteStatus' && result?.state === 'committed') committed(args[0]);
            return result;
          } catch (error) {
            if (!holdsReads(error)) throw error;
            invalidate();
            if (isTransientIdbError(error) && attempt < delays.length) { await wait(delays[attempt]); continue; }
            const critical = !['getBackupCatalog', 'getBackupCatalogData', 'getBackupCatalogPage', 'listSnapshots'].includes(operation);
            failed.set(key, { error, critical, operation, args });
            // Bound the noncritical cache without forgetting unresolved guards.
            if (failed.size > 100) { const evict = [...failed].find(([, item]) => !item.critical); if (evict) failed.delete(evict[0]); }
            notify(error, operation, critical); throw error;
          }
        }
      })();
      running.set(key, pending);
      try { return await pending; } finally { running.delete(key); }
    },
    assertWritable() {
      syncUnknown();
      if (writeFailure || criticalFailure() || unknown.length) throw paused(writeFailure ?? criticalFailure()?.error ?? unknownFailure);
    },
    writeFailed(operation, args, error) {
      syncUnknown();
      if (error?.backupTransactionOutcome === 'aborted') {
        if (holdsReads(error)) notify(error, operation, false);
        return;
      }
      const uncertain = error?.backupTransactionOutcome === 'unknown' || error?.backupTransactionOutcome === 'committed' || error?.code === 'outcome-unknown'
        || error?.backupTransactionOutcome === undefined && isIndexedDbFailure(error) && (error instanceof TypeError || ['AbortError', 'TimeoutError', 'UnknownError'].includes(error?.name));
      if (!uncertain && !holdsReads(error)) return;
      if (uncertain) {
        unknownFailure = error;
        const id = operation === 'commitBackupWrite' ? args[0]?.id : undefined;
        if (!unknown.some(item => item.method === operation && item.id === id)) unknown.push({ method: operation, ...(id ? { id } : {}) });
        persist();
      } else writeFailure = error;
      notify(error, operation, true);
    },
    async retry(check) {
      syncUnknown();
      if (running.size) throw paused();
      // This probe checks the current connection/chat, independently of the
      // stored catalog failures. A failed critical probe still stops writes.
      let firstError;
      try { await check(); writeFailure = undefined; }
      catch (error) { firstError = error; if (holdsReads(error)) { writeFailure = error; notify(error, 'retry', true); } }
      for (const [key, item] of [...failed]) {
        try { await check(undefined, item.operation, item.args); failed.delete(key); }
        catch (error) { item.error = error; firstError ??= error; notify(error, item.operation, item.critical); }
      }
      for (const item of [...unknown]) if (item.id) {
        try { const status = await check(item.id); if (status?.state === 'committed') committed(item.id); }
        catch (error) { firstError ??= error; notify(error, 'getBackupWriteStatus', true); }
      }
      if (firstError) throw firstError;
      return this.state();
    },
    block(error) { writeFailure = error; notify(error, 'recovery', true); },
    reset() { failed.clear(); writeFailure = undefined; unknownFailure = undefined; unknown = []; persist(); },
  };
}
