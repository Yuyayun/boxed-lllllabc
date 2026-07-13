import { summarizePendingChanges } from "../backup/pending.js";

const SAVE_DIALOG_ID = "boxed-lllllabc-save-request-dialog";

export function buildSaveRequestDialogModel({ chatName, pending }) {
  const summary = summarizePendingChanges(pending);
  const hasPending = summary.count > 0;
  return {
    title: hasPending ? "重新请求保存" : "请求保存当前聊天",
    chatName: chatName || "当前聊天",
    pendingCount: summary.count,
    pendingRange: summary.rangeText || "当前没有待确认变更",
    hasPending,
    explanation: hasPending
      ? "不会恢复、覆盖或删除任何备份，也不会立即清除未保存变更。后端核对一致后才会自动清除。"
      : "不会恢复、覆盖或删除任何备份。保存请求完成后，会用当前整聊内容核对后端是否一致。",
  };
}

export function openSaveRequestDialog({ plan, chatName, pending, onConfirm }) {
  closeSaveRequestDialog();
  const model = buildSaveRequestDialogModel({ chatName, pending });
  const dialog = document.createElement("div");
  dialog.id = SAVE_DIALOG_ID;
  dialog.className = "boxed-lllllabc-dialog boxed-lllllabc-restore-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "boxed-lllllabc-save-request-dialog-title");

  const backdrop = document.createElement("div");
  backdrop.className = "boxed-lllllabc-dialog-backdrop";

  const frame = document.createElement("div");
  frame.className = "boxed-lllllabc-dialog-frame boxed-lllllabc-restore-frame";

  const header = document.createElement("header");
  header.className = "boxed-lllllabc-dialog-header";
  const title = document.createElement("div");
  title.id = "boxed-lllllabc-save-request-dialog-title";
  title.className = "boxed-lllllabc-panel-title";
  title.textContent = model.title;
  const closeButton = createIconButton("fa-xmark", "关闭", closeSaveRequestDialog);
  closeButton.classList.add("boxed-lllllabc-dialog-close");
  header.append(title, closeButton);

  const body = document.createElement("div");
  body.className = "boxed-lllllabc-restore-body";
  const summary = document.createElement("div");
  summary.className = "boxed-lllllabc-restore-summary";
  summary.append(
    renderSummaryLine("聊天名称", model.chatName),
    renderSummaryLine("未保存变更", `${model.pendingRange} · 共 ${model.pendingCount} 项`),
  );

  const explanation = document.createElement("section");
  explanation.className = "boxed-lllllabc-save-explanation";
  const icon = document.createElement("i");
  icon.className = "fa-solid fa-floppy-disk";
  icon.setAttribute("aria-hidden", "true");
  const explanationText = document.createElement("div");
  const explanationTitle = document.createElement("strong");
  explanationTitle.textContent = "只重新请求酒馆保存当前前端聊天";
  const explanationDetail = document.createElement("div");
  explanationDetail.textContent = model.explanation;
  explanationText.append(explanationTitle, explanationDetail);
  explanation.append(icon, explanationText);
  body.append(summary, explanation);

  const error = document.createElement("div");
  error.className = "boxed-lllllabc-restore-error";
  error.hidden = true;
  error.setAttribute("role", "alert");

  const footer = document.createElement("footer");
  footer.className = "boxed-lllllabc-restore-footer";
  const cancel = createTextButton("fa-xmark", "取消");
  cancel.addEventListener("click", closeSaveRequestDialog);
  const confirm = createTextButton("fa-floppy-disk", "确认重新保存");
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    cancel.disabled = true;
    confirm.setAttribute("aria-busy", "true");
    confirm.querySelector("span").textContent = "正在请求保存";
    try {
      const result = await onConfirm(plan);
      if (result?.ok) {
        closeSaveRequestDialog();
        return;
      }
      error.textContent = result?.reason || "请求保存失败，未保存变更仍会保留。";
      error.hidden = false;
      confirm.querySelector("span").textContent = "请重新确认";
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : "请求保存失败，未保存变更仍会保留。";
      error.hidden = false;
      confirm.querySelector("span").textContent = "请重新确认";
    } finally {
      confirm.removeAttribute("aria-busy");
      cancel.disabled = false;
    }
  });
  footer.append(cancel, confirm);

  backdrop.addEventListener("click", closeSaveRequestDialog);
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeSaveRequestDialog();
    }
  });

  frame.append(header, body, error, footer);
  dialog.append(backdrop, frame);
  document.body.append(dialog);
  closeButton.focus();
  return dialog;
}

export function closeSaveRequestDialog() {
  document.getElementById(SAVE_DIALOG_ID)?.remove();
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
