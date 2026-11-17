// Cursor callbacks only await IDB requests, keeping the owning transaction live.
export function mutationDriver(store) {
  if (typeof store.openCursor !== 'function') return store;
  const request = value => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
  const index = () => store.index(store.name.endsWith('snapshot_messages') ? 'by_snapshot' : 'by_chat');
  const eachForChat = (key, callback) => new Promise((resolve, reject) => {
    const read = index().openCursor(IDBKeyRange.only(key));
    read.onerror = () => reject(read.error);
    read.onsuccess = () => {
      const cursor = read.result; if (!cursor) return resolve();
      try { Promise.resolve(callback(cursor.value, cursor)).then(() => cursor.continue(), reject); } catch (error) { reject(error); }
    };
  });
  return {
    name: store.name, get: store.get.bind(store), put: store.put.bind(store), delete: store.delete.bind(store), index: store.index.bind(store),
    count: store.count.bind(store), getAll: store.getAll.bind(store), getAllKeys: store.getAllKeys.bind(store),
    getForMutation: key => request(store.get(key)), countForChat: key => request(index().count(key)), eachForChat,
    deleteForChat: key => eachForChat(key, (_value, cursor) => request(cursor.delete())),
    async verifySnapshotKeys(id, expected) { let count = 0; await eachForChat(id, row => { if (row.messageIndex !== count++) throw new Error('聊天快照楼层索引不完整。'); }); return count === expected; },
  };
}
