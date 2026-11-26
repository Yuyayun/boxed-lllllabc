import { createIndexedDbStorage as createCurrent } from '../../src/storage/indexeddb-adapter.js';
import { createIndexedDbStorage as createBaseline } from '/baseline/src/storage/indexeddb-adapter.js';
import { openBackupDatabase } from '../../src/db/index.js';
import { runIdbTransaction } from '../../src/db/idb-helpers.js';

export async function measureIndexedDbRecoveryPerformance() {
  if (location.hostname !== '127.0.0.1') throw new Error('仅允许隔离性能测试');
  const scenarios = [];
  for (const input of [{ chats: 1, rows: 1000, bodyBytes: 4096 }, { chats: 3, rows: 1000, bodyBytes: 4096 }, { chats: 1, rows: 10000, bodyBytes: 128 }]) {
    await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase('boxed-lllllabc'); request.onsuccess = resolve; request.onerror = () => reject(request.error); });
    const db = await openBackupDatabase();
    await runIdbTransaction(db, ['chat_meta', 'full_messages'], 'readwrite', tx => {
      for (let n = 0; n < input.chats; n++) {
        const chatKey = `character:performance-only.png:chat-${n}`;
        tx.objectStore('chat_meta').put({ chatKey, chatType: 'character', characterAvatar: 'performance-only.png', chatId: `chat-${n}` });
        for (let i = 0; i < input.rows; i++) tx.objectStore('full_messages').put({ chatKey, messageIndex: i, raw: { mes: `${i}:` + 'x'.repeat(input.bodyBytes) } });
      }
    }); db.close();
    const samples = { baseline: [], current: [] };
    for (let trial = 0; trial < 3; trial++) for (const name of trial % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
      const session = await (name === 'baseline' ? createBaseline() : createCurrent()).open();
      let requests = 0, maxHeap = performance.memory?.usedJSHeapSize ?? null;
      const oldKey = IDBIndex.prototype.openKeyCursor, oldValue = IDBIndex.prototype.openCursor;
      const record = original => function (...args) { requests++; if (performance.memory) maxHeap = Math.max(maxHeap, performance.memory.usedJSHeapSize); return original.apply(this, args); };
      IDBIndex.prototype.openKeyCursor = record(oldKey); IDBIndex.prototype.openCursor = record(oldValue);
      const start = performance.now();
      try {
        const page = await session.getBackupCatalogPage();
        if (page.items.length !== input.chats) throw new Error('性能夹具目录数量不符');
        samples[name].push({ ms: Math.round((performance.now() - start) * 10) / 10, indexCursorRequests: requests, sampledJSHeapBytes: maxHeap });
      } finally { session.close(); IDBIndex.prototype.openKeyCursor = oldKey; IDBIndex.prototype.openCursor = oldValue; }
    }
    const median = name => samples[name].map(item => item.ms).sort((a, b) => a - b)[1];
    scenarios.push({ ...input, samples, medianMs: { baseline: median('baseline'), current: median('current') }, ratio: Math.round(median('current') / median('baseline') * 100) / 100 });
  }
  return { baseline: 'ab7339ef02da588b5cbbff10bf0143f11e53018c', scenarios, note: '三个交替样本；JS 堆为浏览器近似采样，不是进程峰值或 iOS 内存保证。目录摘要仍读取正文。' };
}
