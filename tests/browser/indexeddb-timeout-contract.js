import { idbRequest, iterateCursor, runIdbTransaction } from '../../src/db/idb-helpers.js';

const assert = (value, reason) => { if (!value) throw new Error(reason); };
export async function runIndexedDbTimeoutContract() {
  if (location.hostname !== '127.0.0.1') throw new Error('仅限隔离测试');
  const name = `boxed-timeout-${crypto.randomUUID()}`, request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => request.result.createObjectStore('records');
  const db = await idbRequest(request), timers = new Set(), listeners = { added: 0, removed: 0 };
  const setTimer = (callback, delay) => { const id = setTimeout(() => { timers.delete(id); callback(); }, delay); timers.add(id); return id; };
  const clearTimer = id => { clearTimeout(id); timers.delete(id); };
  const transaction = db.transaction.bind(db);
  db.transaction = (...args) => {
    const tx = transaction(...args), add = tx.addEventListener.bind(tx), remove = tx.removeEventListener.bind(tx);
    tx.addEventListener = (type, ...rest) => { if (type === 'success') listeners.added++; return add(type, ...rest); };
    tx.removeEventListener = (type, ...rest) => { if (type === 'success') listeners.removed++; return remove(type, ...rest); };
    return tx;
  };
  const options = { setTimer, clearTimer };
  let holder;
  try {
    await runIdbTransaction(db, 'records', 'readwrite', async tx => {
      for (let n = 0; n < 64; n++) await idbRequest(tx.objectStore('records').put({ n, body: 'x'.repeat(32768) }, n));
    }, undefined, options);
    // Retain virtual-time coverage, using real native request success events.
    let clock = 0, next = 0, renewals = 0; const virtualTimers = new Map();
    await runIdbTransaction(db, 'records', 'readonly', async tx => {
      for (let n = 0; n < 200; n++) {
        await idbRequest(tx.objectStore('records').get(n % 64)); clock += 1000;
        for (const [id, timer] of [...virtualTimers]) if (timer.at <= clock) { virtualTimers.delete(id); timer.callback(); }
      }
    }, undefined, { setTimer: (callback, delay) => { renewals++; const id = ++next; virtualTimers.set(id, { at: clock + delay, callback }); return id; }, clearTimer: id => virtualTimers.delete(id) });
    assert(virtualTimers.size === 0 && renewals > 200, '虚拟时间未续期或未清理');
    let rows = 0, cycles = 0, ready, stop = false, lastReport = 0;
    const started = new Promise(resolve => { ready = resolve; }), start = performance.now();
    holder = runIdbTransaction(db, 'records', 'readwrite', async tx => {
      while (!stop && performance.now() - start < 124000) {
        await iterateCursor(tx.objectStore('records'), undefined, cursor => { rows++; assert(cursor.value.body.length > 0, '原生记录读取失败'); ready(); });
        await idbRequest(tx.objectStore('records').put({ n: cycles++, body: 'x'.repeat(32768) }, 0));
        if (performance.now() - lastReport > 20000) { lastReport = performance.now(); console.log(`IDB_STRESS 有进展 ${Math.round((performance.now() - start) / 1000)} 秒，读取 ${rows} 条`); }
      }
    }, undefined, options);
    // Register a rejection handler immediately, including if the contender fails.
    holder.catch(() => {});
    await started;
    let requestsSucceeded = 0;
    const waitingStart = performance.now();
    const outcome = await runIdbTransaction(db, 'records', 'readonly', async tx => {
      await idbRequest(tx.objectStore('records').get(0)); requestsSucceeded++;
    }, undefined, options).then(() => ({ unexpectedSuccess: true }), error => ({ code: error.code, outcome: error.backupTransactionOutcome }));
    const waitingMs = performance.now() - waitingStart;
    assert(outcome.code === 'backup-operation-timeout' && outcome.outcome === 'aborted' && requestsSucceeded === 0 && waitingMs >= 120000, '真实排队无进展未正确超时/中止');
    await holder;
    const activeMs = performance.now() - start;
    assert(activeMs >= 124000 && rows > 64 && cycles > 0, '真实有进展事务没有超过 120 秒');
    assert(timers.size === 0 && listeners.added === listeners.removed, '事务结束后残留定时器或成功监听器');
    await runIdbTransaction(db, 'records', 'readwrite', tx => idbRequest(tx.objectStore('records').put({ n: 'after-timeout', body: 'verified' }, 0)), undefined, options);
    const after = await runIdbTransaction(db, 'records', 'readonly', tx => idbRequest(tx.objectStore('records').get(0)), undefined, options);
    assert(after.body === 'verified' && timers.size === 0 && listeners.added === listeners.removed, '超时后不能正常执行新事务');
    return { activeMs, waitingMs, rows, cycles, queuedRequestSuccesses: requestsSucceeded, timeout: outcome, pendingTimers: timers.size, listeners, virtualMs: clock, virtualRenewals: renewals, afterTimeoutReadWrite: true, limitation: '真实排队无进展，不是浏览器存储内核卡死复现' };
  } finally {
    // Only this randomly named test database and its owned connection are used.
    db.close();
    await idbRequest(indexedDB.deleteDatabase(name));
  }
}
