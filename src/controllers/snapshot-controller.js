import { captureSnapshot, currentSnapshotFingerprint } from "../snapshots/model.js";
import { readSnapshot, snapshotBatches } from "../snapshots/service.js";
import { previewSnapshotRestore, restoredMetadata, verifyNativeSnapshotSave, validateNativeSnapshotPayload } from "../snapshots/restore.js";
import { executeRestorePlan } from "../backup/restore-executor.js";
import { renderRestoredMessages } from "./restore-controller.js";
import { waitForSaveRequest } from "../backup/save-request.js";
import { readBackendChat } from "../verifier/backend-reader.js";
import { stableText } from "../storage/value-digest.js";
import { createSnapshotSaveProof } from "../snapshots/confirmation.js";

export function createSnapshotController({ storage, getContextReader, runGuard = operation => operation(),
  isGenerating = () => false, beforeRestore = async () => {}, afterRestore = async () => {},
  readBackend = readBackendChat, render = renderRestoredMessages, waitForSave = waitForSaveRequest } = {}) {
  let busy = false;
  const current = () => getContextReader().readCurrentChat();
  async function sessionUse(operation) { const session = await storage.open(); try { return await operation(session); } finally { session.close(); } }
  async function guarded(operation) {
    if (busy) throw new Error("已有聊天快照操作正在执行。");
    busy = true;
    try { return await runGuard(operation); } finally { busy = false; }
  }
  const ensureStopped = () => { if (isGenerating()) throw new Error("请先停止生成，再操作聊天快照。"); };
  return {
    async create({ name } = {}) {
      return guarded(async () => {
        ensureStopped(); const source = current();
        const snapshot = await captureSnapshot(source, { name });
        const batches = snapshotBatches(snapshot.messages);
        return sessionUse(async session => {
          try {
            const identity = await session.reconcileChatIdentity(source.identity);
            if (["ambiguous", "conflict", "invalid"].includes(identity.status)) throw new Error("聊天身份存在歧义，未创建快照。");
            await session.beginSnapshot({ header: snapshot.header, identityMeta: { ...source.identity.meta, chatKey: snapshot.header.chatKey } });
            for (const messages of batches) await session.appendSnapshotMessages({ id: snapshot.header.id, messages });
            await session.publishSnapshot({ id: snapshot.header.id });
            const verified = await readSnapshot(session, snapshot.header.id);
            return { ok: true, header: verified.header };
          } catch (error) {
            try { await session.deleteSnapshot({ id: snapshot.header.id, expectedHash: snapshot.header.contentHash, draftOnly: true }); }
            catch { /* A lost response keeps the draft/receipt; never claim success. */ }
            throw error;
          }
        });
      });
    },
    list: options => sessionUse(session => session.listSnapshots({ ...options, includeDrafts: true })),
    preview: id => sessionUse(async session => {
      const snapshot = await readSnapshot(session, id), source = current();
      const pending = source.ok ? await session.getPendingChanges(source.identity.chatKey) : [];
      const meta = await session.getChatMeta(snapshot.header.chatKey);
      let restore = null, reason = "";
      try { ensureStopped(); restore = await previewSnapshotRestore({ snapshot, current: source, pending }); }
      catch (error) { reason = error.message; }
      return { snapshot, restore: restore && { ...restore, mode: storage.getMode() }, meta, reason };
    }),
    rename: ({ id, name, expectedName }) => guarded(() => sessionUse(session => session.renameSnapshot({ id, name, expectedName }))),
    delete: ({ id, expectedHash, confirmed = false }) => guarded(() => {
      if (!confirmed) throw new Error("请明确确认删除此聊天快照。");
      return sessionUse(session => session.deleteSnapshot({ id, expectedHash }));
    }),
    async restore(preview, { confirmed = false } = {}) {
      return guarded(async () => {
        if (!confirmed || !preview) throw new Error("请预览并确认覆盖当前聊天。");
        ensureStopped();
        try {
          await beforeRestore();
          return await sessionUse(async session => {
            if (storage.getMode() !== preview.mode) throw new Error("活动存储方式已变化，请重新预览。");
            const snapshot = await readSnapshot(session, preview.snapshotId), source = current();
            if (snapshot.header.contentHash !== preview.contentHash || snapshot.header.chatKey !== source.identity?.chatKey
              || await currentSnapshotFingerprint(source) !== preview.currentFingerprint) throw new Error("快照或当前聊天已变化，请重新预览。");
            const metadata = restoredMetadata(snapshot, source);
            const saveProof = await createSnapshotSaveProof(metadata);
            let firstPendingWrite = true;
            let writtenProtection = [];
            validateNativeSnapshotPayload(snapshot, metadata);
            for (const method of ["updateChatMetadata", "saveChat", "clearChat", "printMessages"]) if (typeof source.context?.[method] !== "function") throw new Error("当前酒馆缺少安全恢复接口，聊天保持原样。");
            const result = await executeRestorePlan({
              plan: preview.plan,
              readCurrent: current,
              readPending: key => session.getPendingChanges(key),
              replacePending: records => {
                if (firstPendingWrite) {
                  for (const record of records) { record.id = `${preview.plan.chatKey}:snapshot-restore`; record.snapshotSaveProof = saveProof; }
                  writtenProtection = records;
                  firstPendingWrite = false;
                }
                return session.replacePendingChanges({ chatKey: preview.plan.chatKey, records });
              },
              beforeApply: async () => {
                ensureStopped();
                if (await currentSnapshotFingerprint(current()) !== preview.currentFingerprint) throw new Error("确认后聊天已变化，已取消恢复。");
              },
              render: async options => {
                options.current.context.updateChatMetadata(structuredClone(metadata), true);
                await render(options);
                // SillyTavern may populate its per-target token/prompt cache ID
                // while redrawing. This is host identity state, not snapshot content.
                const latestMetadata = current().context?.chatMetadata;
                if (Object.hasOwn(latestMetadata ?? {}, "chat_id_hash")) metadata.chat_id_hash = latestMetadata.chat_id_hash;
              },
              save: ({ current: target }) => waitForSave({ save: () => {
                const latest = current();
                if (!latest.ok || latest.identity.chatKey !== preview.plan.chatKey || stableText([latest.chat, latest.context.chatMetadata ?? {}]) !== stableText([snapshot.chat, metadata])) throw new Error("保存前目标聊天已变化，已停止请求酒馆保存。");
                return target.context.saveChat();
              } }),
            });
            if (!result.changed) return result;
            const target = current();
            let backend;
            try { backend = await readBackend({ current: target }); }
            catch (error) { backend = { ok: false, reason: error.message }; }
            const expected = stableText([snapshot.chat, metadata]);
            const stillCurrent = () => {
              const value = current();
              return value.ok && value.identity.chatKey === preview.plan.chatKey && stableText([value.chat, value.context.chatMetadata ?? {}]) === expected;
            };
            const confirmedSave = result.stage !== "render" && verifyNativeSnapshotSave({ snapshot, metadata, backend }) && stillCurrent();
            if (confirmedSave && writtenProtection.length) await session.deletePendingChangesIfUnchanged(writtenProtection, { shouldDelete: stillCurrent, signal: new AbortController().signal });
            return { ...result, ok: confirmedSave, confirmed: confirmedSave, reason: confirmedSave ? "聊天快照已恢复，酒馆保存数据核对一致；源快照仍保留。" : result.stage === "render" ? result.reason : "聊天内容已应用，但酒馆保存尚未确认。未保存保护仍保留，请重新预览恢复或核对保存状态。" };
          });
        } finally { await afterRestore(); }
      });
    },
  };
}
