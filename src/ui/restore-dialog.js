import { canonicalizeMessage } from "../backup/canonicalize.js";
import { formatIndexRange } from "../backup/restore.js";
import { formatCandidateSummary, getMessagePreview } from "./presentation.js";

const RESTORE_DIALOG_ID = "boxed-lllllabc-restore-dialog";

export function buildRestoreDialogModel({ plan, chatName, currentChat = [] }) {
  const conflictByIndex = new Map(
    (plan.pendingConflicts ?? []).map((record) => [record.messageIndex, record]),
  );
  const restoredItems = [...plan.replacements, ...plan.appends].map((item) => {
    const backup = item.backup;
    const current = item.messageIndex < currentChat.length
      ? canonicalizeMessage(currentChat[item.messageIndex], item.messageIndex)
      : null;
    const conflict = conflictByIndex.get(item.messageIndex)?.message ?? null;
    return {
      messageIndex: item.messageIndex,
      action: item.messageIndex < plan.baseChatLength ? "替换" : "追加",
      actor: backup.name || renderRole(backup.role),
      candidateSummary: formatCandidateSummary(backup),
      currentPreview: current ? getMessagePreview(current) : "",
      backupPreview: getMessagePreview(backup),
      conflictPreview: conflict ? getMessagePreview(conflict) : "",
    };
  });
  const deletedItems = (plan.deletions ?? []).map((item) => {
    const current = canonicalizeMessage(currentChat[item.messageIndex], item.messageIndex);
    const conflict = conflictByIndex.get(item.messageIndex)?.message ?? null;
    return {
      messageIndex: item.messageIndex,
      action: "删除",
      actor: current.name || renderRole(current.role),
      candidateSummary: formatCandidateSummary(current),
      currentPreview: getMessagePreview(current),
      backupPreview: "该楼层不存在",
      conflictPreview: conflict ? getMessagePreview(conflict) : "",
    };
  });
  const items = [...restoredItems, ...deletedItems]
    .sort((a, b) => a.messageIndex - b.messageIndex);
  const replacementIndexes = plan.replacements.map((item) => item.messageIndex);
  const appendIndexes = plan.appends.map((item) => item.messageIndex);
  const deletionIndexes = (plan.deletions ?? []).map((item) => item.messageIndex);
  const conflictIndexes = plan.pendingConflicts
    .map((record) => record.messageIndex)
    .filter(Number.isInteger);

  return {
    title: "恢复预览",
    chatName: chatName || "当前聊天",
    sourceLabel: renderSourceLabel(plan.source),
    replacementRange: formatIndexRange(replacementIndexes),
    appendRange: formatIndexRange(appendIndexes),
    deletionRange: formatIndexRange(deletionIndexes),
    conflictRange: formatIndexRange(conflictIndexes),
    conflictCount: plan.pendingConflicts.length,
    hasConflicts: plan.pendingConflicts.length > 0,
    replacesAllPending: plan.source === "full",
    totalCount: plan.totalCount,
    items,
  };
}

export function openRestoreDialog({ plan, chatName, currentChat, onConfirm }) {
  closeRestoreDialog();
  const model = buildRestoreDialogModel({ plan, chatName, currentChat });
  const dialog = document.createElement("div");
  dialog.id = RESTORE_DIALOG_ID;
  dialog.className = "boxed-lllllabc-dialog boxed-lllllabc-restore-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "boxed-lllllabc-restore-dialog-title");

  const backdrop = document.createElement("div");
  backdrop.className = "boxed-lllllabc-dialog-backdrop";

  const frame = document.createElement("div");
  frame.className = "boxed-lllllabc-dialog-frame boxed-lllllabc-restore-frame";

  const header = document.createElement("header");
  header.className = "boxed-lllllabc-dialog-header";
  const title = document.createElement("div");
  title.id = "boxed-lllllabc-restore-dialog-title";
  title.className = "boxed-lllllabc-panel-title";
  title.textContent = model.title;
  const closeButton = createIconButton("fa-xmark", "关闭", closeRestoreDialog);
  closeButton.classList.add("boxed-lllllabc-dialog-close");
  header.append(title, closeButton);

  const body = document.createElement("div");
  body.className = "boxed-lllllabc-restore-body";
  body.append(renderSummary(model));
  if (model.hasConflicts) {
    body.append(renderConflictWarning(model));
  }
  body.append(renderRestoreItems(model));

  const error = document.createElement("div");
  error.className = "boxed-lllllabc-restore-error";
  error.hidden = true;
  error.setAttribute("role", "alert");

  const footer = document.createElement("footer");
  footer.className = "boxed-lllllabc-restore-footer";
  const cancel = createTextButton("fa-xmark", "取消");
  cancel.addEventListener("click", closeRestoreDialog);
  const confirm = createTextButton("fa-clock-rotate-left", "确认恢复");
  confirm.classList.add("boxed-lllllabc-restore-confirm");
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    cancel.disabled = true;
    confirm.setAttribute("aria-busy", "true");
    confirm.querySelector("span").textContent = "正在恢复";
    try {
      const result = await onConfirm(plan);
      if (result?.ok) {
        closeRestoreDialog();
        return;
      }
      error.textContent = result?.reason || "恢复失败，请重新预览。";
      error.hidden = false;
      confirm.querySelector("span").textContent = "请重新预览";
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : "恢复失败，请重新预览。";
      error.hidden = false;
      confirm.querySelector("span").textContent = "请重新预览";
    } finally {
      confirm.removeAttribute("aria-busy");
      cancel.disabled = false;
    }
  });
  footer.append(cancel, confirm);

  backdrop.addEventListener("click", closeRestoreDialog);
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeRestoreDialog();
    }
  });

  frame.append(header, body, error, footer);
  dialog.append(backdrop, frame);
  document.body.append(dialog);
  closeButton.focus();
  return dialog;
}

export function closeRestoreDialog() {
  document.getElementById(RESTORE_DIALOG_ID)?.remove();
}

function renderSummary(model) {
  const summary = document.createElement("div");
  summary.className = "boxed-lllllabc-restore-summary";
  summary.append(
    renderSummaryLine("聊天名称", model.chatName),
    renderSummaryLine("恢复来源", model.sourceLabel),
  );
  if (model.replacementRange) {
    summary.append(renderSummaryLine("将替换", model.replacementRange));
  }
  if (model.appendRange) {
    summary.append(renderSummaryLine("将追加", model.appendRange));
  }
  if (model.deletionRange) {
    summary.append(renderSummaryLine("将删除", model.deletionRange));
  }
  summary.append(renderSummaryLine("变更数量", `${model.totalCount} 层`));
  return summary;
}

function renderConflictWarning(model) {
  const warning = document.createElement("section");
  warning.className = "boxed-lllllabc-restore-warning";
  const icon = document.createElement("i");
  icon.className = "fa-solid fa-triangle-exclamation";
  icon.setAttribute("aria-hidden", "true");
  const content = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = "将覆盖现有未保存变更";
  const detail = document.createElement("div");
  detail.textContent = model.replacesAllPending
    ? `全部 ${model.conflictCount} 条未保存记录会由本次整聊恢复保护记录取代。`
    : `${model.conflictRange}与本次恢复重叠；其他未保存变更不会被修改。`;
  content.append(title, detail);
  warning.append(icon, content);
  return warning;
}

function renderRestoreItems(model) {
  const list = document.createElement("div");
  list.className = "boxed-lllllabc-restore-list";
  for (const item of model.items) {
    const row = document.createElement("article");
    row.className = "boxed-lllllabc-restore-item";
    const heading = document.createElement("strong");
    heading.textContent = `第 ${item.messageIndex} 层 · ${item.actor} · ${item.action}`;
    const meta = document.createElement("div");
    meta.className = "boxed-lllllabc-muted";
    meta.textContent = item.candidateSummary;
    row.append(heading, meta);

    if (item.conflictPreview) {
      row.append(renderPreviewLine("现有未保存变更", item.conflictPreview, true));
    } else if (item.currentPreview) {
      row.append(renderPreviewLine("当前内容", item.currentPreview));
    }
    row.append(renderPreviewLine("恢复后", item.backupPreview));
    list.append(row);
  }
  return list;
}

function renderSummaryLine(label, value) {
  const row = document.createElement("div");
  row.className = "boxed-lllllabc-panel-row";
  const term = document.createElement("span");
  term.className = "boxed-lllllabc-panel-label";
  term.textContent = label;
  const detail = document.createElement("span");
  detail.className = "boxed-lllllabc-panel-value";
  detail.textContent = value;
  row.append(term, detail);
  return row;
}

function renderPreviewLine(label, value, conflict = false) {
  const line = document.createElement("div");
  line.className = "boxed-lllllabc-restore-preview";
  if (conflict) {
    line.classList.add("boxed-lllllabc-restore-preview-conflict");
  }
  const term = document.createElement("span");
  term.textContent = label;
  const detail = document.createElement("span");
  detail.textContent = value;
  line.append(term, detail);
  return line;
}

function createIconButton(iconName, label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `menu_button fa-solid ${iconName}`;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.addEventListener("click", onClick);
  return button;
}

function createTextButton(iconName, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "menu_button boxed-lllllabc-action-button";
  const icon = document.createElement("i");
  icon.className = `fa-solid ${iconName}`;
  icon.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.textContent = label;
  button.append(icon, text);
  return button;
}

function renderRole(role) {
  if (role === "user") return "用户";
  if (role === "system") return "系统";
  return "角色";
}

function renderSourceLabel(source) {
  if (source === "pending") return "未保存变更（全部）";
  if (source === "historical") return "历史楼层改动备份";
  if (source === "full") return "完整聊天备份（整份覆盖）";
  return "最近楼层备份";
}
