import { digestValue } from "../storage/value-digest.js";
import { stripChatHeader } from "../backup/canonicalize.js";

function persistedMetadata(metadata) {
  const value = JSON.parse(JSON.stringify(metadata ?? {}));
  delete value.chat_id_hash;
  return value;
}
export async function createSnapshotSaveProof(metadata) {
  return { format: 1, metadataHash: await digestValue(persistedMetadata(metadata)) };
}
async function chatDigest(chat) {
  const hashes = [];
  for (const message of chat) hashes.push(await digestValue(JSON.parse(JSON.stringify(message))));
  return digestValue(hashes);
}
export async function confirmSnapshotPending(pending, backendChat, current) {
  const candidates = pending.filter(record => record?.snapshotSaveProof);
  const confirmed = new Set();
  if (!candidates.length || !current?.ok || !backendChat?.[0]?.chat_metadata) return confirmed;
  if (await chatDigest(stripChatHeader(backendChat)) !== await chatDigest(current.chat)) return confirmed;
  const metadataHash = await digestValue(persistedMetadata(backendChat[0].chat_metadata));
  if (metadataHash !== await digestValue(persistedMetadata(current.context?.chatMetadata))) return confirmed;
  for (const record of candidates) {
    if (record.snapshotSaveProof.format === 1 && record.snapshotSaveProof.metadataHash === metadataHash) confirmed.add(record.id);
  }
  return confirmed;
}
