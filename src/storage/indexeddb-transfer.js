import { openBackupDatabase } from "../db/index.js";
import { TRANSFER_STORES } from "../db/schema.js";
import { DATA_STORES, TRANSFER_PAGE_BYTES, transferId, recordText, digestRow, readTransferManifest, sameManifest } from "./transfer-format.js";
import { encodeStorageValue } from "./protocol.js";
import { ALL_DATASET_STORES, ACTIVE_DATASET_KEY, datasetId } from "./dataset-layout.js";

const request = (value) => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
const cursor = (store, callback, range) => new Promise((resolve, reject) => {
  const read = store.openCursor(range);
  read.onerror = () => reject(read.error);
  read.onsuccess = () => {
    const item = read.result;
    if (!item) return resolve();
    try { if (callback(item) === false) return resolve(); item.continue(); }
    catch (error) { reject(error); }
  };
});

export function createIndexedDbTransfer({ openDatabase = openBackupDatabase } = {}) {
  async function tx(mode, callback, allowUnknown = false) {
    const db = await openDatabase();
    try {
      for (const name of db.objectStoreNames) if (!allowUnknown && ![...ALL_DATASET_STORES, ...Object.values(TRANSFER_STORES)].includes(name)) throw new Error(`发现未知数据仓库 ${name}，未丢弃数据，已停止切换。`);
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction([...DATA_STORES, ...Object.values(TRANSFER_STORES)], mode);
        const meta = transaction.objectStore(TRANSFER_STORES.meta);
        const rows = transaction.objectStore(TRANSFER_STORES.rows);
        let result;
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB 切换事务中止。"));
        Promise.resolve().then(async () => {
          if (datasetId((await request(meta.get(ACTIVE_DATASET_KEY)))?.value) !== 0) throw new Error("当前数据区需要新版分批迁移流程，旧流程未修改任何备份。");
          return callback({ meta, rows, store: (name) => transaction.objectStore(name) });
        })
          .then((value) => { result = value; }).catch((error) => { try { transaction.abort(); } catch {} reject(error); });
      });
    } finally { db.close(); }
  }
  const receipt = (meta, id) => request(meta.get(id));
  async function lock(meta, id) {
    const current = (await request(meta.get("lock")))?.value;
    if (current && current !== id) throw new Error("另一项存储操作尚未完成，请先恢复。");
    await request(meta.put({ key: "lock", value: id }));
  }
  async function requireLock(meta, id) {
    if ((await request(meta.get("lock")))?.value !== id) throw new Error("切换任务未持有数据锁。");
  }
  async function removeRows(rows, id, kind) {
    await cursor(rows, (item) => { if (item.value.id !== id) return false; if (!kind || item.value.kind === kind) item.delete(); }, IDBKeyRange.lowerBound([id]));
  }
  const staged = (id, kind, n, store, key, value) => ({ id, kind, n, store, key, value, keyText: JSON.stringify(encodeStorageValue([store, key])) });
  async function page({ id, after = 0 }) {
    const values = await tx("readonly", async ({ meta, rows }) => {
      await requireLock(meta, id);
      const result = [];
      let bytes = 0;
      await cursor(rows, (item) => {
        const row = item.value;
        if (row.id !== id || row.kind !== "data") return false;
        const size = new TextEncoder().encode(recordText(row)).byteLength;
        if (result.length && (result.length >= 100 || bytes + size > TRANSFER_PAGE_BYTES)) return false;
        result.push({ n: row.n, store: row.store, key: row.key, value: row.value }); bytes += size;
      }, IDBKeyRange.lowerBound([id, "data", after], true));
      return result;
    });
    return Promise.all(values.map(async (row) => ({ ...row, digest: await digestRow(row) })));
  }
  return async function transfer(action, args) {
    const id = transferId(args?.id);
    if (action === "page") return page(args);
    if (action === "check") {
      const batch = await page(args);
      return tx("readonly", async ({ meta, store }) => {
        await requireLock(meta, id);
        const state = await receipt(meta, id);
        if (!(state?.role === "source" && state.phase === "captured" || state?.role === "target" && state.phase === "committed")) throw new Error("正式数据不在可复核阶段。");
        let count = 0;
        for (const name of DATA_STORES) count += await request(store(name).count());
        if (count !== state.written) throw new Error("正式数据数量与校验副本不一致。");
        for (const row of batch) {
          const value = await request(store(row.store).get(row.key));
          if (recordText({ ...row, value }) !== recordText(row)) throw new Error("正式记录与校验副本不一致。");
        }
        return { after: batch.at(-1)?.n ?? args.after, done: batch.length === 0 };
      });
    }
    if (action === "status") return tx("readonly", ({ meta }) => receipt(meta, id).then((value) => value ?? null), true);
    if (action === "source") return tx("readwrite", async ({ meta, rows, store }) => {
      await lock(meta, id);
      const existing = await receipt(meta, id);
      if (existing) { if (existing.role !== "source" || existing.phase !== "captured") throw new Error("切换任务状态冲突。"); return existing; }
      let n = 0;
      for (const name of DATA_STORES) await cursor(store(name), (item) => { rows.put(staged(id, "data", ++n, name, item.primaryKey, item.value)); });
      const value = { key: id, role: "source", phase: "captured", written: n };
      await request(meta.put(value)); return value;
    });
    if (action === "prepare") return tx("readwrite", async ({ meta }) => {
      await lock(meta, id);
      const existing = await receipt(meta, id);
      if (existing) { if (existing.role !== "target" || !sameManifest(existing.expected, args.manifest)) throw new Error("目标暂存任务不匹配。"); return existing; }
      const baseRevision = (await request(meta.get("revision")))?.value ?? 0;
      const value = { key: id, role: "target", phase: "staging", written: 0, expected: args.manifest, baseRevision };
      await request(meta.put(value)); return value;
    });
    if (action === "append") {
      if (!Array.isArray(args.rows) || !args.rows.length || args.rows.length > 100) throw new Error("暂存批次无效。");
      for (const row of args.rows) if (row.digest !== await digestRow(row)) throw new Error("暂存记录摘要不一致。");
      return tx("readwrite", async ({ meta, rows }) => {
        await requireLock(meta, id);
        const value = await receipt(meta, id);
        if (value?.phase !== "staging") throw new Error("目标暂存阶段已经结束。");
        for (const row of args.rows) {
          if (row.n <= value.written) {
            const previous = await request(rows.get([id, "data", row.n]));
            if (!previous || recordText(previous) !== recordText(row)) throw new Error("重复批次内容不一致。");
          } else {
            if (row.n !== value.written + 1) throw new Error("暂存批次不连续。");
            await request(rows.add(staged(id, "data", row.n, row.store, row.key, row.value))); value.written = row.n;
          }
        }
        await request(meta.put(value)); return { written: value.written };
      });
    }
    if (action === "seal") {
      const state = await tx("readwrite", async ({ meta }) => {
        await requireLock(meta, id); const value = await receipt(meta, id);
        if (!value || !["captured", "staging", "checking", "verified"].includes(value.phase)) throw new Error("切换校验状态无效。");
        if (value.role === "target") { value.phase = "checking"; await request(meta.put(value)); }
        return value;
      });
      const manifest = await readTransferManifest((after) => page({ id, after }));
      if (state.role === "target" && !sameManifest(state.expected, manifest)) throw new Error("目标读回与来源清单不一致，未替换正式数据。");
      await tx("readwrite", async ({ meta }) => { await requireLock(meta, id); await request(meta.put({ ...state, manifest, phase: state.role === "source" ? "captured" : "verified" })); });
      return manifest;
    }
    if (action === "commit") return tx("readwrite", async ({ meta, rows, store }) => {
      await requireLock(meta, id); const value = await receipt(meta, id);
      if (value?.phase === "committed") return value;
      if (value?.phase !== "verified" || value.baseRevision !== ((await request(meta.get("revision")))?.value ?? 0)) throw new Error("目标库或保护状态已变化，未提交。");
      let n = 0;
      for (const name of DATA_STORES) { await cursor(store(name), (item) => { rows.put(staged(id, "backup", ++n, name, item.primaryKey, item.value)); }); await request(store(name).clear()); }
      await cursor(rows, (item) => { const row = item.value; if (row.id !== id || row.kind !== "data") return false; store(row.store).put(row.value); }, IDBKeyRange.lowerBound([id, "data"]));
      value.phase = "committed"; await request(meta.put(value)); await request(meta.put({ key: "revision", value: value.baseRevision + 1 })); return value;
    });
    if (["rollback", "finish"].includes(action)) return tx("readwrite", async ({ meta, rows, store }) => {
      const value = await receipt(meta, id);
      if (!value || ["rolled-back", "finished"].includes(value.phase)) return value ?? null;
      await requireLock(meta, id);
      if (action === "rollback" && value.phase === "committed") {
        for (const name of DATA_STORES) await request(store(name).clear());
        await cursor(rows, (item) => { const row = item.value; if (row.id !== id || row.kind !== "backup") return false; store(row.store).put(row.value); }, IDBKeyRange.lowerBound([id, "backup"]));
      }
      if (action === "finish" && value.role === "target" && value.phase !== "committed") throw new Error("未提交目标不能完成切换。");
      await removeRows(rows, id); await request(meta.delete("lock"));
      value.phase = action === "finish" ? "finished" : "rolled-back";
      await request(meta.put(value)); return value;
    }, true);
    throw new Error("未知切换操作。");
  };
}
