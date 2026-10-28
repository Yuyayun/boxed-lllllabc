import { openBackupDatabase } from "../db/index.js";
import { TRANSFER_STORES } from "../db/schema.js";
import { ACTIVE_DATASET_KEY, ALL_DATASET_STORES, datasetStore } from "./dataset-layout.js";
import { DATA_STORES, recordText } from "./transfer-format.js";
import { validateCursor } from "./transfer-batch-format.js";
import { createBatchTransfer } from "./batch-transfer.js";
import {createLegacyRecovery} from './legacy-recovery.js';

const request = value => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error);
});

export function createIndexedDbBatchTransfer({ openDatabase = openBackupDatabase,onLegacyProgress=()=>{} } = {}) {
  const driver = {
    async transaction(mode, callback) {
      const db = await openDatabase();
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction([...ALL_DATASET_STORES, ...Object.values(TRANSFER_STORES)], mode, mode === "readwrite" ? { durability: "strict" } : undefined);
          const meta = tx.objectStore(TRANSFER_STORES.meta);
          const legacy=tx.objectStore(TRANSFER_STORES.rows);
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
            metaDelete: key => request(meta.delete(key)),
            metaKeys(prefix, after = "", limit = 100) {
              return new Promise((resolve, reject) => {
                const keys = [], read = meta.openKeyCursor(IDBKeyRange.lowerBound(after || prefix, !!after));
                read.onerror = () => reject(read.error);
                read.onsuccess = () => {
                  const item = read.result;
                  if (!item || typeof item.key !== "string" || !item.key.startsWith(prefix) || keys.length >= limit) return resolve(keys);
                  keys.push(item.key); item.continue();
                };
              });
            },
            active: () => get(ACTIVE_DATASET_KEY), revision: async () => await get("revision") ?? 0,
            activePut: value => put(ACTIVE_DATASET_KEY, value), revisionPut: value => put("revision", value),
            lockGet: () => get("lock"), lockPut: id => put("lock", id),
            lockDelete: () => request(meta.delete("lock")),
            taskGet: id => request(meta.get(id)), taskPut: state => request(meta.put({ ...state, key: state.id })),
            legacyRow:(id,kind,n)=>request(legacy.get([id,kind,n])),
            legacyDelete:(_id,key)=>request(legacy.delete(key)),
            legacyKeys(id,limit){return new Promise((resolve,reject)=>{const keys=[],read=legacy.openKeyCursor(IDBKeyRange.lowerBound([id]));read.onerror=()=>reject(read.error);read.onsuccess=()=>{const item=read.result;if(!item||item.key[0]!==id||keys.length===limit)return resolve(keys);keys.push(item.primaryKey);item.continue();};});},
            legacyPage(id,kind,after,budget){return new Promise((resolve,reject)=>{const rows=[];let bytes=0;const read=legacy.openCursor(IDBKeyRange.lowerBound([id,kind,after],true));read.onerror=()=>reject(read.error);read.onsuccess=()=>{try{const item=read.result;if(!item||item.value.id!==id||item.value.kind!==kind)return resolve(rows);const row={n:item.value.n,store:item.value.store,key:item.value.key,value:item.value.value},size=new TextEncoder().encode(recordText(row)).byteLength;if(rows.length&&(rows.length===budget.limit||bytes+size>budget.bytes))return resolve(rows);rows.push(row);bytes+=size;item.continue();}catch(error){reject(error);}};});},
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
  return Object.freeze({...createBatchTransfer({driver}),legacyRecovery:createLegacyRecovery({driver,onProgress:onLegacyProgress})});
}
