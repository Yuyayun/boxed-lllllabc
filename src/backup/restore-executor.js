import {
  applyRestorePlan,
  createRestorePendingRecords,
  rollbackRestorePlan,
  validateRestorePlan,
} from "./restore.js";

export async function executeRestorePlan({
  plan,
  readCurrent,
  readPending,
  writePending,
  replacePending,
  render,
  save,
  now,
  beforeApply = async () => {},
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

  if (plan.source === "full") {
    restoredPending = createRestorePendingRecords({
      plan,
      chat: plan.targetChat,
      chatKey: plan.chatKey,
      now,
    });
    try {
      await replacePending(restoredPending);
    } catch (error) {
      return failure("pending", "整聊恢复保护写入失败，本次恢复已取消。", error);
    }
  }

  let snapshot;
  try {
    await beforeApply({ current, plan });
    snapshot = applyRestorePlan(current.chat, plan);
  } catch (error) {
    if (plan.source === "full") {
      try {
        await replacePending(pending);
      } catch (pendingError) {
        return failure("apply", "聊天恢复失败，且原未保存记录回滚失败。", pendingError);
      }
    }
    return failure("apply", "恢复内容无法应用，聊天保持原样。", error);
  }

  if (plan.source === "recent" || plan.source === "historical") {
    restoredPending = createRestorePendingRecords({
      plan,
      chat: current.chat,
      chatKey: plan.chatKey,
      now,
    });
    try {
      await writePending(restoredPending);
    } catch (error) {
      rollbackRestorePlan(current.chat, snapshot);
      return failure("pending", "未保存变更保护写入失败，本次恢复已取消。", error);
    }
  }

  try {
    await render({ current, plan });
  } catch (error) {
    return failure("render", "聊天已经恢复，但界面更新失败。请先核对酒馆保存状态再刷新页面。", error, true);
  }

  let saveOutcome;
  try {
    saveOutcome = await save({ current, plan });
    if (saveOutcome?.status === "failed") {
      throw saveOutcome.error ?? new Error(saveOutcome.reason || "保存失败");
    }
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
