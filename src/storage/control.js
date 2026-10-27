const NAME = "boxed-lllllabc-control";
const DEFAULT = Object.freeze({ active: "indexeddb", previous: null, lastTransfer: null, journal: null });
export function createStorageControl({ indexedDB = globalThis.indexedDB } = {}) {
  async function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("存储控制记录被其他页面阻塞。"));
      request.onsuccess = () => resolve(request.result);
    });
  }
  async function transaction(update) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("state", update ? "readwrite" : "readonly");
        const store = tx.objectStore("state");
        let value;
        const read = store.get("current");
        read.onsuccess = () => {
          try {
            const current = read.result ?? structuredClone(DEFAULT);
            if (!["indexeddb", "sqlite"].includes(current.active)) throw new Error("活动存储记录无效，不能自动选择数据库。");
            if (current.previous !== null && (!["indexeddb", "sqlite"].includes(current.previous) || current.previous === current.active) || current.lastTransfer !== null && (typeof current.lastTransfer !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(current.lastTransfer))) throw new Error("原存储位置的确认记录无效，请保留两个位置的备份。");
            const journal = current.journal;
            if (journal && (!/^[a-zA-Z0-9_-]{8,80}$/.test(journal.id) || !["switch", "clear"].includes(journal.kind) || !["working", "activated"].includes(journal.phase) || !["indexeddb", "sqlite"].includes(journal.from) || !["indexeddb", "sqlite"].includes(journal.to) || journal.from === journal.to || current.active !== (journal.phase === "activated" && journal.kind === "switch" ? journal.to : journal.from))) throw new Error("存储恢复记录无效，请保留两端数据。");
            value = update ? update(current) : current;
            if (update) store.put(value, "current");
          } catch (error) { tx.abort(); reject(error); }
        };
        tx.oncomplete = () => resolve(value);
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("存储控制记录未写入。"));
      });
    } finally { db.close(); }
  }
  return { read: () => transaction(), update: (callback) => transaction(callback) };
}
