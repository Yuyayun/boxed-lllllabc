import { openBackupDatabase } from "../db/index.js";
import { TRANSFER_STORES } from "../db/schema.js";
import { ACTIVE_DATASET_KEY, ALL_DATASET_STORES, datasetStore } from "./dataset-layout.js";
import { DATA_STORES, recordText } from "./transfer-format.js";
import { validateCursor } from "./transfer-batch-format.js";
import { createBatchTransfer } from "./batch-transfer.js";
import {createLegacyRecovery} from './legacy-recovery.js';
import { idbRequest as request, iterateCursor, runIdbTransaction } from '../db/idb-helpers.js';


export function createIndexedDbBatchTransfer({ openDatabase = openBackupDatabase,onLegacyProgress=()=>{} } = {}) {
  const driver = {
    async transaction(mode, callback) {
      const db = await openDatabase();
      try {
        return await runIdbTransaction(db, [...ALL_DATASET_STORES, ...Object.values(TRANSFER_STORES)], mode, async tx => {
          const meta = tx.objectStore(TRANSFER_STORES.meta);
          const legacy=tx.objectStore(TRANSFER_STORES.rows);
          const get = async key => (await request(meta.get(key)))?.value;
          const put = (key, item) => request(meta.put({ key, value: item }));
          const port = {
            validateLayout() {
              for (const name of db.objectStoreNames) if (![...ALL_DATASET_STORES, ...Object.values(TRANSFER_STORES)].includes(name)) throw new Error("发现未知仓库，未修改原数据。");
            },
            metaGet: get, metaPut: put,
            metaDelete: key => request(meta.delete(key)),
            async metaKeys(prefix, after = "", limit = 100) {
              const keys = [];
              await iterateCursor(meta, IDBKeyRange.lowerBound(after || prefix, !!after), item => {
                if (typeof item.key !== 'string' || !item.key.startsWith(prefix) || keys.length >= limit) return false;
                keys.push(item.key);
              }, { keyOnly: true });
              return keys;
            },
            active: () => get(ACTIVE_DATASET_KEY), revision: async () => await get("revision") ?? 0,
            activePut: async value => { await put(ACTIVE_DATASET_KEY, value); await put('backup-scope-epoch', (await get('backup-scope-epoch') ?? 0) + 1); }, revisionPut: value => put("revision", value),
            lockGet: () => get("lock"), lockPut: id => put("lock", id),
            lockDelete: () => request(meta.delete("lock")),
            taskGet: id => request(meta.get(id)), taskPut: state => request(meta.put({ ...state, key: state.id })),
            legacyRow:(id,kind,n)=>request(legacy.get([id,kind,n])),
            legacyDelete:(_id,key)=>request(legacy.delete(key)),
            async legacyKeys(id, limit) {
              const keys = [];
              await iterateCursor(legacy, IDBKeyRange.lowerBound([id]), item => {
                if (item.key[0] !== id || keys.length === limit) return false;
                keys.push(item.primaryKey);
              }, { keyOnly: true });
              return keys;
            },
            async legacyPage(id, kind, after, budget) {
              const rows = []; let bytes = 0;
              await iterateCursor(legacy, IDBKeyRange.lowerBound([id, kind, after], true), item => {
                if (item.value.id !== id || item.value.kind !== kind) return false;
                const row = { n: item.value.n, store: item.value.store, key: item.value.key, value: item.value.value };
                const size = new TextEncoder().encode(recordText(row)).byteLength;
                if (rows.length && (rows.length === budget.limit || bytes + size > budget.bytes)) return false;
                rows.push(row); bytes += size;
              });
              return rows;
            },
            get: (dataset, name, key) => request(tx.objectStore(datasetStore(name, dataset)).get(key)),
            has: async (dataset, name, key) => (await request(tx.objectStore(datasetStore(name, dataset)).count(key))) > 0,
            add: (dataset, name, _key, item) => request(tx.objectStore(datasetStore(name, dataset)).add(item)),
            remove: (dataset, name, key) => request(tx.objectStore(datasetStore(name, dataset)).delete(key)),
            async page(dataset, input, budget) {
              validateCursor(input);
              const rows = []; let bytes = 0, cursor = structuredClone(input);
              for (let i = input.store; i < DATA_STORES.length; i++) {
                const name = DATA_STORES[i], after = i === input.store ? input.after : null;
                let stopped = false;
                await iterateCursor(tx.objectStore(datasetStore(name, dataset)), after === null ? undefined : IDBKeyRange.lowerBound(after, true), item => {
                      const row = { store: name, key: item.primaryKey, value: item.value };
                      const size = new TextEncoder().encode(recordText(row)).byteLength;
                      if (rows.length && (rows.length >= budget.limit || bytes + size > budget.bytes)) { stopped = true; return false; }
                      rows.push(row); bytes += size; cursor = { store: i, after: item.primaryKey };
                });
                if (stopped) return { rows, cursor, done: false };
                cursor = { store: i + 1, after: null };
              }
              return { rows, cursor, done: true };
            },
          };
          return callback(port);
        }, mode === "readwrite" ? { durability: "strict" } : undefined);
      } finally { db.close(); }
    },
  };
  return Object.freeze({...createBatchTransfer({driver}),legacyRecovery:createLegacyRecovery({driver,onProgress:onLegacyProgress})});
}
