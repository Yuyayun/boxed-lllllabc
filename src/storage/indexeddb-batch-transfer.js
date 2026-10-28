import { openBackupDatabase } from "../db/index.js";
import { TRANSFER_STORES } from "../db/schema.js";
import { ACTIVE_DATASET_KEY, ALL_DATASET_STORES, datasetStore } from "./dataset-layout.js";
import { DATA_STORES, recordText } from "./transfer-format.js";
import { validateCursor } from "./transfer-batch-format.js";
import { createBatchTransfer } from "./batch-transfer.js";

const request = value => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error);
});

export function createIndexedDbBatchTransfer({ openDatabase = openBackupDatabase } = {}) {
  const driver = {
    async transaction(mode, callback) {
      const db = await openDatabase();
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction([...ALL_DATASET_STORES, TRANSFER_STORES.meta], mode);
          const meta = tx.objectStore(TRANSFER_STORES.meta);
          let value;
          tx.oncomplete = () => resolve(value);
          tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("分批迁移事务中止。"));
          const get = async key => (await request(meta.get(key)))?.value;
          const put = (key, item) => request(meta.put({ key, value: item }));
          const port = {
            validateLayout() {
              for (const name of db.objectStoreNames) if (![...ALL_DATASET_STORES, ...Object.values(TRANSFER_STORES)].includes(name)) throw new Error("发现未知仓库，未修改原数据。");
            },
            metaGet: get, metaPut: put,
            active: () => get(ACTIVE_DATASET_KEY), revision: async () => await get("revision") ?? 0,
            lockGet: () => get("lock"), lockPut: id => put("lock", id),
            taskGet: id => request(meta.get(id)), taskPut: state => request(meta.put({ ...state, key: state.id })),
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
                await new Promise((resolve, reject) => {
                  const read = tx.objectStore(datasetStore(name, dataset)).openCursor(after === null ? undefined : IDBKeyRange.lowerBound(after, true));
                  read.onerror = () => reject(read.error);
                  read.onsuccess = () => {
                    try {
                      const item = read.result;
                      if (!item) return resolve();
                      const row = { store: name, key: item.primaryKey, value: item.value };
                      const size = new TextEncoder().encode(recordText(row)).byteLength;
                      if (rows.length && (rows.length >= budget.limit || bytes + size > budget.bytes)) { stopped = true; return resolve(); }
                      rows.push(row); bytes += size; cursor = { store: i, after: item.primaryKey }; item.continue();
                    } catch (error) { reject(error); }
                  };
                });
                if (stopped) return { rows, cursor, done: false };
                cursor = { store: i + 1, after: null };
              }
              return { rows, cursor, done: true };
            },
          };
          Promise.resolve().then(() => callback(port)).then(result => { value = result; })
            .catch(error => { try { tx.abort(); } catch {} reject(error); });
        });
      } finally { db.close(); }
    },
  };
  return createBatchTransfer({ driver });
}
