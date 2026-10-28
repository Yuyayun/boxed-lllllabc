import { openBackupDatabase } from "../db/index.js";
import { TRANSFER_STORES } from "../db/schema.js";
import { ACTIVE_DATASET_KEY, datasetId, commitDataset, rollbackDataset } from "./dataset-layout.js";
import { transferId } from "./transfer-format.js";

const request = value => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error);
});

// Internal target-commit primitive. It deliberately has no HTTP/UI entry point
// until the resumable batch verifier can produce the durable verified receipt.
export function createIndexedDbDatasetControl({ openDatabase = openBackupDatabase } = {}) {
  async function change(action, id, expectedManifest) {
    transferId(id);
    const db = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction([TRANSFER_STORES.meta], "readwrite");
        const meta = tx.objectStore(TRANSFER_STORES.meta);
        let result;
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("数据区切换事务中止。"));
        (async () => {
          if ((await request(meta.get("lock")))?.value !== id) throw new Error("任务未持有持久数据锁。");
          const state = await request(meta.get(id));
          if (state?.id !== id) throw new Error("目标任务身份与登记簿不一致。");
          const active = datasetId((await request(meta.get(ACTIVE_DATASET_KEY)))?.value);
          const revision = (await request(meta.get("revision")))?.value ?? 0;
          result = action === "commit" ? commitDataset(state, { active, revision, expectedManifest }) : rollbackDataset(state, { active, revision });
          if ((action === "commit" && state.phase !== "committed") || (action === "rollback" && state.phase === "committed")) {
            await request(meta.put({ key: ACTIVE_DATASET_KEY, value: action === "commit" ? result.dataset : result.previousDataset }));
            await request(meta.put({ key: "revision", value: revision + 1 }));
          }
          await request(meta.put({ ...result, key: id }));
        })().catch(error => { try { tx.abort(); } catch {} reject(error); });
      });
    } finally { db.close(); }
  }
  return { commit: (id, manifest) => change("commit", id, manifest), rollback: id => change("rollback", id) };
}
