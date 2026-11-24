import {
  applyRestorePlan,
  validateRestorePlan,
  validateRestorePendingRecords,
} from "./restore.js";
import { createRestoreJournal } from './pending-journal.js';
import { nativeChatHash,warmNativeChat } from './native-content.js';

export async function executeRestorePlan({
  plan,
  readCurrent,
  readPending,
  writePending,
  render,
  save,
  beforeApply = async () => {},
  afterApply = ()=>{},
}) {
  const current = await readCurrent();
  if (!current?.ok) {
    return failure("validate", current?.reason || "无法读取当前聊天。");
  }

  const pending = await readPending(plan.chatKey);
  const validation = validateRestorePlan({
    plan,
    chat: current.chat,
    chatKey: current.identity.chatKey,
    pending,
  });
  if (!validation.ok) {
    return failure("validate", validation.reason);
  }

  let restoredPending = [];

  try {
    await beforeApply({ current, plan });
    const latest = await readCurrent();
    const latestPending=await readPending(plan.chatKey);
    const rechecked = validateRestorePlan({ plan, chat: latest?.chat, chatKey: latest?.identity?.chatKey, pending:latestPending });
    if (!latest?.ok || latest.chat !== current.chat || !rechecked.ok) throw new Error(rechecked.reason || '来源聊天在恢复准备期间发生变化。');
  } catch (error) {
    return failure("apply", "恢复内容无法应用，聊天保持原样。", error);
  }
  const target=structuredClone(current.chat);
  try {applyRestorePlan(target,plan);}catch(error){return failure('apply','恢复目标无法组成，聊天保持原样。',error);}
  await warmNativeChat(target);
  restoredPending=createRestoreJournal({chat:current.chat,targetChat:target,chatKey:plan.chatKey,chatIntegrity:current.identity.meta?.chatIntegrity,pending,
    coveredIds:plan.source==='full'?pending.map(row=>row.id):plan.source==='pending'?plan.coveredPendingIds??pending.map(row=>row.id):plan.pendingConflicts.map(row=>row.id)});
  if(plan.targetMetadata)for(const row of restoredPending)if(row.pendingType==='operation') {
    row.restoreMetadata=structuredClone(plan.targetMetadata);row.snapshotSaveProof=structuredClone(plan.targetSnapshotSaveProof);
  }
  try {await writePending(restoredPending);}
  catch(error){return failure('pending','恢复保护写入失败，本次恢复已取消，原记录已保留。',error);}
  try {
    const latest=await readCurrent(),ownIds=new Set(restoredPending.map(row=>row.id));
    const latestPending=(await readPending(plan.chatKey)).filter(row=>!ownIds.has(row.id));
    const checked=validateRestorePlan({plan,chat:latest?.chat,chatKey:latest?.identity?.chatKey,pending:latestPending});
    if(!latest?.ok||latest.chat!==current.chat||!checked.ok)throw new Error(checked.reason||'聊天已经切换。');
    applyRestorePlan(current.chat,plan);
    afterApply({current,plan});
  } catch(error) {
    return failure('apply','恢复准备期间聊天或保护记录变化，原记录已保留，请重新预览。',error);
  }

  try {
    await render({ current, plan });
  } catch (error) {
    return failure("render", "聊天已经恢复，但界面更新失败。请先核对酒馆保存状态再刷新页面。", error, true);
  }

  let saveOutcome;
  try {
    const latest=await readCurrent();
    if(!latest?.ok||latest.identity.chatKey!==plan.chatKey||latest.chat!==current.chat||nativeChatHash(latest.chat)!==nativeChatHash(target))throw new Error('恢复期间聊天已经切换或内容发生变化，已停止保存，保护记录仍保留。');
    const ownIds=new Set(restoredPending.map(row=>row.id));
    if(!validateRestorePendingRecords(plan,(await readPending(plan.chatKey)).filter(row=>!ownIds.has(row.id))))throw new Error('恢复期间保护记录发生变化，已停止保存，请重新预览。');
    saveOutcome = await save({ current, plan });
    if (saveOutcome?.status === "failed") {
      throw saveOutcome.error ?? new Error(saveOutcome.reason || "保存失败");
    }
    const afterSave=await readCurrent();
    if(!afterSave?.ok||afterSave.identity.chatKey!==plan.chatKey||afterSave.chat!==current.chat)throw new Error('保存等待期间聊天或备份位置已经变化，保护记录仍保留，等待核对原聊天。');
  } catch (error) {
    return failure("save", "聊天已经恢复，但酒馆保存尚未确认。", error, true);
  }

  return {
    ok: true,
    stage: "complete",
    changed: true,
    pendingRecords: restoredPending,
    saveOutcome: saveOutcome ?? { ok: true, status: "completed" },
  };
}

function failure(stage, reason, error = null, changed = false) {
  return {
    ok: false,
    stage,
    reason,
    error,
    changed,
    pendingRecords: [],
  };
}
