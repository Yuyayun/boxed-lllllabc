import { createIndexedDbStorage } from "./indexeddb-adapter.js";

/** One adapter serves all operations. Opening it never tries another backend. */
export function createBackupStorage({ adapter = createIndexedDbStorage() } = {}) {
  return Object.freeze({
    getMode: () => adapter.mode,
    open: () => adapter.open(),
  });
}

export const defaultBackupStorage = createBackupStorage();
