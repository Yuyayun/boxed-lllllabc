import { createFullRestorePlan } from "../backup/restore.js";
import { canonicalizeMessage, stripChatHeader } from "../backup/canonicalize.js";
import { currentSnapshotFingerprint } from "./model.js";
import { stableText } from "../storage/value-digest.js";

export function restoredMetadata(snapshot, current) {
  const metadata = structuredClone(snapshot.header.metadata);
  const currentMetadata = current.context?.chatMetadata ?? {};
  // Never replace or manufacture the native target chat's integrity UUID.
  if (Object.hasOwn(currentMetadata, "integrity")) metadata.integrity = currentMetadata.integrity;
  else delete metadata.integrity;
  if (Object.hasOwn(currentMetadata, "chat_id_hash")) metadata.chat_id_hash = currentMetadata.chat_id_hash;
  else delete metadata.chat_id_hash;
  return metadata;
}
export async function previewSnapshotRestore({ snapshot, current, pending }) {
  if (!current?.ok || snapshot.header.chatKey !== current.identity.chatKey) throw new Error("请先打开此快照所属的聊天，再预览恢复。");
  const plan = createFullRestorePlan({ chat: current.chat, chatKey: current.identity.chatKey,
    fullMessages: snapshot.chat.map((raw, index) => ({ ...canonicalizeMessage(raw, index), chatKey: current.identity.chatKey })), pending });
  // Snapshot restoration also restores metadata and custom message fields that
  // ordinary backup comparisons intentionally omit. Keep the ordinary plan rules.
  if (plan.blockedReason === "当前聊天已经与完整聊天备份一致。") plan.blockedReason = "";
  return { plan, snapshotId: snapshot.header.id, contentHash: snapshot.header.contentHash,
    currentFingerprint: await currentSnapshotFingerprint(current), metadata: restoredMetadata(snapshot, current) };
}
const persisted = value => JSON.parse(JSON.stringify(value));
export function verifyNativeSnapshotSave({ snapshot, metadata, backend }) {
  if (!backend?.ok || !Array.isArray(backend.chat)) return false;
  const header = backend.chat[0];
  return stableText(persisted(stripChatHeader(backend.chat))) === stableText(persisted(snapshot.chat))
    && header?.chat_metadata && stableText(persisted(header.chat_metadata)) === stableText(persisted(metadata));
}
export function validateNativeSnapshotPayload(snapshot, metadata) {
  // Fail before applying values the native JSON chat API cannot persist.
  persisted(snapshot.chat); persisted(metadata);
}
