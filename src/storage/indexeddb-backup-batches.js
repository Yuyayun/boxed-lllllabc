import { TRANSFER_STORES } from '../db/schema.js';
import { ALL_DATASET_STORES, ACTIVE_DATASET_KEY, datasetStore, datasetId } from './dataset-layout.js';
import { createLargeBackupOperations } from './large-backup-operations.js';
import { BACKUP_STORES, BACKUP_BUDGET, boundedRecordSize, backupFailure, measureBackupValue } from './backup-batches.js';
import { storedChatSummary } from './backup-catalog-summary.js';
import { idbRequest as request, iterateCursor as iterate, distinctIndexKeys, runIdbTransaction } from '../db/idb-helpers.js';

export function createIndexedDbBackupBatches({ openDatabase }) {
  return createLargeBackupOperations({
    mode: 'indexeddb',
    async transaction(mode, callback) {
      const db = await openDatabase();
      try {
        return await runIdbTransaction(db, [...ALL_DATASET_STORES, ...Object.values(TRANSFER_STORES)], mode, async tx => {
          const meta = tx.objectStore(TRANSFER_STORES.meta), staged = tx.objectStore(TRANSFER_STORES.rows);
          const getMeta = async key => (await request(meta.get(key)))?.value;
          const putMeta = (key, value) => request(meta.put({ key, value }));
          const run = async () => {
            const area = datasetId(await getMeta(ACTIVE_DATASET_KEY));
            const store = name => tx.objectStore(datasetStore(name, area));
            const stageRange = id => IDBKeyRange.bound([id, 'backup-v1', 0], [id, 'backup-v1', Number.MAX_SAFE_INTEGER]);
            const stats = async chatKey => {
              const output = {};
              for (const name of BACKUP_STORES) {
                const stat = { count: 0, bytes: 0, firstIndex: null, lastIndex: null, structural: false };
                await iterate(store(name).index('by_chat'), IDBKeyRange.only(chatKey), cursor => {
                  const row = cursor.value; stat.count++; stat.bytes += measureBackupValue(row).bytes;
                  if (Number.isInteger(row.messageIndex)) { stat.firstIndex = stat.firstIndex === null ? row.messageIndex : Math.min(stat.firstIndex, row.messageIndex); stat.lastIndex = Math.max(stat.lastIndex ?? 0, row.messageIndex); } else stat.structural = true;
                }); output[name] = stat;
              }
              return output;
            };
            const port = {
              async checkLock() { if (await getMeta('lock')) throw backupFailure('正在切换备份位置，请稍后重试。'); },
              area: () => area, revision: async () => Number(await getMeta('revision') ?? 0),
              async bumpRevision() { await putMeta('revision', await port.revision() + 1); },
              metaGet: getMeta, metaPut: putMeta, metaDelete: key => request(meta.delete(key)),
              async jobs() { const result = []; await iterate(meta, IDBKeyRange.bound('backup-write:', 'backup-write:\uffff'), cursor => { result.push(cursor.value.value); if (result.length >= 20) return false; }); return result; },
              get: (name, key) => request(store(name).get(key)), put: (name, value) => request(store(name).put(value)),
              async counts(chatKey) { const values = {}; for (const name of BACKUP_STORES) values[name] = await request(store(name).index('by_chat').count(chatKey)); return values; },
              async deleteChat(name, chatKey) {
                let count = 0;
                await iterate(store(name).index('by_chat'), IDBKeyRange.only(chatKey), async cursor => { await request(cursor.delete()); count++; });
                return count;
              },
              async page(name, chatKey, after, hashesOnly) {
                const rows = []; let bytes = 1024, nodes = 100, last = null, more = false;
                const source = name === 'pending_changes' ? store(name).index('by_chat') : store(name);
                const range = name === 'pending_changes' ? IDBKeyRange.only(chatKey) : IDBKeyRange.bound(after ?? [chatKey, 0], [chatKey, Infinity], after !== null);
                await iterate(source, range, cursor => {
                  if (name === 'pending_changes' && after !== null && indexedDB.cmp(cursor.primaryKey, after) <= 0) {
                    if (indexedDB.cmp(cursor.primaryKey, after) < 0) { cursor.continuePrimaryKey(chatKey, after); return 'jumped'; }
                    return;
                  }
                  const row = cursor.value, value = hashesOnly ? { messageIndex: row.messageIndex, canonicalHash: row.canonicalHash, hashVersion: row.hashVersion, nativeHash: row.nativeHash } : row;
                  const size = boundedRecordSize(value); if (!size.fits) throw backupFailure('单条备份超过安全上限。', 'backup-limit');
                  if (rows.length && (rows.length >= BACKUP_BUDGET.rows || bytes + size.bytes > BACKUP_BUDGET.bytes || nodes + size.nodes > BACKUP_BUDGET.nodes)) { more = true; return false; }
                  rows.push(value); last = cursor.primaryKey; bytes += size.bytes; nodes += size.nodes;
                }); return { rows, after: more ? last : null };
              },
              async stageGet(id, n) { return (await request(staged.get([id, 'backup-v1', n])))?.value; },
              stagePut(job, n, value) { const key = job.store === 'pending_changes' ? value.id : [job.chatKey, value.messageIndex]; return request(staged.add({ id: job.id, kind: 'backup-v1', n, store: job.store, key, keyText: JSON.stringify(key), value })); },
              stageCount: id => request(staged.count(stageRange(id))),
              stageDelete: (id, limit = Infinity) => { let count = 0; return iterate(staged, stageRange(id), async cursor => { if (count++ >= limit) return false; await request(cursor.delete()); }); },
              eachStage: (id, callback) => iterate(staged, stageRange(id), cursor => callback(cursor.value.value)),
              async catalog(after) {
                const keys = new Set();
                const range = after === null ? undefined : IDBKeyRange.lowerBound(after, true);
                // Jump over duplicate index keys without reading message values.
                for (const name of BACKUP_STORES) {
                  for (const key of await distinctIndexKeys(store(name).index('by_chat'), range, 21)) keys.add(key);
                }
                const sorted = [...keys].sort((a, b) => indexedDB.cmp(a, b)), items = [];
                for (const key of sorted.slice(0, 20)) {
                  const chatMeta = await port.get('chat_meta', key);
                  const entry = storedChatSummary(key, chatMeta, await stats(key), await port.revision()); if (entry) items.push(entry);
                }
                return { items, after: sorted.length > 20 ? sorted[19] : null };
              },
            };
            return callback(port);
          };
          return run();
        });
      } finally { db.close(); }
    },
  });
}
