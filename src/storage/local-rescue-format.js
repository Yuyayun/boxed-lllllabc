import { encodeStorageValue, decodeStorageValue } from './protocol.js';
import { sha256 } from './value-digest.js';

export const LOCAL_RESCUE_FORMAT = 'boxed-local-rescue';
export const LOCAL_RESCUE_VERSION = 1;
export async function sealRescueVolume(header, records) {
  const payload = { ...header, format: LOCAL_RESCUE_FORMAT, version: LOCAL_RESCUE_VERSION, type: 'records', records };
  return { ...payload, digest: await sha256(JSON.stringify(payload)) };
}
export function encodeRescueRecord(store, key, value) { return encodeStorageValue({ store, key, value }); }
export async function readRescueVolume(volume) {
  if (volume?.format !== LOCAL_RESCUE_FORMAT || volume.version !== LOCAL_RESCUE_VERSION || volume.type !== 'records' || !Array.isArray(volume.records) || volume.records.length > 10000) throw new Error('不是支持的箱装只读救援数据卷。');
  const { digest, ...payload } = volume;
  if (digest !== await sha256(JSON.stringify(payload))) throw new Error('救援数据卷校验不符。');
  return volume.records.map(encoded => {
    const row = decodeStorageValue(encoded);
    if (!row || typeof row.store !== 'string' || !Object.hasOwn(row, 'key') || !Object.hasOwn(row, 'value')) throw new Error('救援记录缺少仓库、主键或原值。');
    return row;
  });
}
