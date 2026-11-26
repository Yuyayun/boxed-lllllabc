import { idbRequest as request, iterateCursor } from './idb-helpers.js';

// Cursor callbacks only await IDB requests, keeping the owning transaction live.
export function mutationDriver(store, onMutation) {
  if (typeof store.openCursor !== 'function') return store;
  const track = value => {
    if (onMutation) value.addEventListener('success', onMutation, { once: true });
    return value;
  };
  const deleteKey = key => {
    if (!onMutation) return store.delete(key);
    // Queue the existence check before the delete in the same transaction.
    // Deleting an absent key must not invalidate a stable backup reader.
    const count = store.count(key), deletion = store.delete(key);
    deletion.addEventListener('success', () => { if (count.result > 0) onMutation(); }, { once: true });
    return deletion;
  };
  const index = () => store.index(store.name.endsWith('snapshot_messages') ? 'by_snapshot' : 'by_chat');
  const eachForChat = (key, callback) => iterateCursor(index(), IDBKeyRange.only(key), cursor => {
    const trackedCursor = onMutation ? new Proxy(cursor, { get(target, key) {
      if (key === 'delete' || key === 'update') return (...args) => track(target[key](...args));
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) : cursor;
    return Promise.resolve(callback(cursor.value, trackedCursor)).then(() => undefined);
  });
  return {
    name: store.name, get: store.get.bind(store), put: value => track(store.put(value)), delete: deleteKey, index: store.index.bind(store),
    count: store.count.bind(store), getAll: store.getAll.bind(store), getAllKeys: store.getAllKeys.bind(store),
    getForMutation: key => request(store.get(key)), countForChat: key => request(index().count(key)), eachForChat,
    deleteForChat: key => eachForChat(key, (_value, cursor) => request(cursor.delete())),
    async verifySnapshotKeys(id, expected) { let count = 0; await eachForChat(id, row => { if (row.messageIndex !== count++) throw new Error('聊天快照楼层索引不完整。'); }); return count === expected; },
  };
}
