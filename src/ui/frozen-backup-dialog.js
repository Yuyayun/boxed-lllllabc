import { FROZEN_FULL_BACKUP_ACTIONS } from "../backup/frozen-resolution.js";

const FROZEN_DIALOG_ID = "boxed-lllllabc-frozen-dialog";

export function buildFrozenBackupDialogModel({ plan, fullBackupEnabled = true } = {}) {
  return {
    title: "处理冻结的完整备份",
    chatName: plan?.chatName || "当前聊天",
    incidentText: plan?.incidentText || "扩展曾检测到可能影响完整备份安全的异常变化。",
    backupText: `${plan?.backupRange || "范围未知"} · ${plan?.backupCount ?? 0} 层`,
    currentText: `${plan?.currentRange || "范围未知"} · ${plan?.currentCount ?? 0} 层`,
    detectedAt: formatDate(plan?.detectedAt),
    adoptDetail: fullBackupEnabled
      ? "用现在的聊天内容替换冻结副本，解除保护并继续自动更新完整备份。"
      : "用现在的聊天内容替换冻结副本并解除保护；完整备份开关仍保持关闭。",
    deleteDetail: "只删除这份冻结的完整备份，不影响最近楼层、历史改动、未保存变更或酒馆聊天。",
  };
}

export function openFrozenBackupDialog({
  plan,
  fullBackupEnabled = true,
  onConfirm,
} = {}) {
  closeFrozenBackupDialog();
  const model = buildFrozenBackupDialogModel({ plan, fullBackupEnabled });
  const dialog = document.createElement("div");
  dialog.id = FROZEN_DIALOG_ID;
  dialog.className = "boxed-lllllabc-dialog boxed-lllllabc-frozen-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "boxed-lllllabc-frozen-title");

  const backdrop = document.createElement("div");
  backdrop.className = "boxed-lllllabc-dialog-backdrop";
  const frame = document.createElement("div");
  frame.className = "boxed-lllllabc-dialog-frame boxed-lllllabc-cleanup-frame boxed-lllllabc-frozen-frame";
  const header = document.createElement("header");
  header.className = "boxed-lllllabc-dialog-header";
  const heading = document.createElement("div");
  heading.className = "boxed-lllllabc-cleanup-heading";
  const kicker = document.createElement("span");
  kicker.textContent = "完整备份保护";
  const title = document.createElement("strong");
  title.id = "boxed-lllllabc-frozen-title";
  title.textContent = model.title;
  const subtitle = document.createElement("span");
  subtitle.textContent = model.chatName;
  heading.append(kicker, title, subtitle);
  const close = createIconButton("fa-xmark", "关闭", closeFrozenBackupDialog);
  close.classList.add("boxed-lllllabc-dialog-close");
  header.append(heading, close);
  const body = document.createElement("div");
  body.className = "boxed-lllllabc-cleanup-body boxed-lllllabc-frozen-body";
  frame.append(header, body);
  dialog.append(backdrop, frame);
  document.body.append(dialog);

  let busy = false;
  const requestClose = () => {
    if (!busy) closeFrozenBackupDialog();
  };
  backdrop.addEventListener("click", requestClose);
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") requestClose();
  });

  const renderFirstConfirmation = () => {
    body.replaceChildren();
    const warning = renderNotice({
      icon: "fa-triangle-exclamation",
      title: "请先核对现在打开的聊天",
      detail: model.incidentText,
      warning: true,
    });
    const impact = document.createElement("dl");
    impact.className = "boxed-lllllabc-cleanup-impact";
    appendImpact(impact, "聊天", model.chatName);
    appendImpact(impact, "冻结备份", model.backupText);
    appendImpact(impact, "当前聊天", model.currentText);
    appendImpact(impact, "检测时间", model.detectedAt);
    const safety = document.createElement("p");
    safety.className = "boxed-lllllabc-cleanup-regeneration";
    safety.textContent = "这里只处理当前备份位置中的完整备份，不会修改酒馆聊天文件。";
    const footer = document.createElement("footer");
    footer.className = "boxed-lllllabc-cleanup-footer";
    const cancel = createTextButton("fa-xmark", "暂不处理", closeFrozenBackupDialog);
    const continueButton = createTextButton("fa-shield-halved", "我已检查，继续确认", renderFinalConfirmation);
    continueButton.classList.add("boxed-lllllabc-frozen-continue");
    footer.append(cancel, continueButton);
    body.append(warning, impact, safety, footer);
    continueButton.focus();
  };

  const renderFinalConfirmation = () => {
    body.replaceChildren();
    const warning = renderNotice({
      icon: "fa-triangle-exclamation",
      title: "最后确认：下面两种处理都无法撤销",
      detail: "只有确认当前聊天内容正确时才应继续。若仍有疑问，请关闭窗口并先预览冻结备份。",
      warning: true,
    });
    const acknowledgement = document.createElement("label");
    acknowledgement.className = "boxed-lllllabc-frozen-acknowledgement";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const copy = document.createElement("span");
    copy.textContent = "我已检查当前聊天，确认现在显示的内容是正确的。";
    acknowledgement.append(checkbox, copy);

    const error = document.createElement("div");
    error.className = "boxed-lllllabc-restore-error";
    error.hidden = true;
    error.setAttribute("role", "alert");
    error.setAttribute("aria-live", "assertive");

    const choices = document.createElement("div");
    choices.className = "boxed-lllllabc-frozen-choices";
    const adopt = renderChoice({
      icon: "fa-check",
      title: "采用当前聊天并恢复更新",
      detail: model.adoptDetail,
      recommended: true,
    });
    const remove = renderChoice({
      icon: "fa-trash-can",
      title: "删除冻结完整备份",
      detail: model.deleteDetail,
      destructive: true,
    });
    adopt.button.disabled = true;
    remove.button.disabled = true;
    choices.append(adopt.element, remove.element);

    const footer = document.createElement("footer");
    footer.className = "boxed-lllllabc-cleanup-footer";
    const back = createTextButton("fa-arrow-left", "返回上一步", renderFirstConfirmation);
    footer.append(back);

    checkbox.addEventListener("change", () => {
      adopt.button.disabled = !checkbox.checked;
      remove.button.disabled = !checkbox.checked;
    });

    const confirmAction = async (action) => {
      busy = true;
      close.disabled = true;
      back.disabled = true;
      checkbox.disabled = true;
      adopt.button.disabled = true;
      remove.button.disabled = true;
      error.hidden = true;
      const active = action === FROZEN_FULL_BACKUP_ACTIONS.adoptCurrent ? adopt.button : remove.button;
      active.setAttribute("aria-busy", "true");
      try {
        const result = await onConfirm?.(action, plan);
        if (!result?.ok) {
          error.textContent = result?.reason || "处理失败，请重新打开后再试。";
          error.hidden = false;
          return;
        }
        const message = action === FROZEN_FULL_BACKUP_ACTIONS.adoptCurrent
          ? "已采用当前聊天，完整备份已解除冻结。"
          : "已删除冻结的完整备份。";
        globalThis.toastr?.success?.(message, "箱装辣白菜");
        closeFrozenBackupDialog();
      } catch (cause) {
        error.textContent = cause instanceof Error ? cause.message : "处理失败，请重新打开后再试。";
        error.hidden = false;
      } finally {
        busy = false;
        active.removeAttribute("aria-busy");
        if (dialog.isConnected) {
          close.disabled = false;
          back.disabled = false;
          checkbox.disabled = false;
          adopt.button.disabled = !checkbox.checked;
          remove.button.disabled = !checkbox.checked;
        }
      }
    };
    adopt.button.addEventListener("click", () => confirmAction(FROZEN_FULL_BACKUP_ACTIONS.adoptCurrent));
    remove.button.addEventListener("click", () => confirmAction(FROZEN_FULL_BACKUP_ACTIONS.deleteFrozen));

    body.append(warning, acknowledgement, choices, error, footer);
    checkbox.focus();
  };

  renderFirstConfirmation();
  return dialog;
}

export function closeFrozenBackupDialog() {
  document.getElementById(FROZEN_DIALOG_ID)?.remove();
}

function renderNotice({ icon, title, detail, warning = false }) {
  const notice = document.createElement("section");
  notice.className = warning
    ? "boxed-lllllabc-cleanup-warning"
    : "boxed-lllllabc-cleanup-safety";
  const symbol = document.createElement("i");
  symbol.className = `fa-solid ${icon}`;
  symbol.setAttribute("aria-hidden", "true");
  const content = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = title;
  const copy = document.createElement("span");
  copy.textContent = detail;
  content.append(heading, copy);
  notice.append(symbol, content);
  return notice;
}

function renderChoice({ icon, title, detail, recommended = false, destructive = false }) {
  const element = document.createElement("article");
  element.className = "boxed-lllllabc-frozen-choice";
  if (recommended) element.dataset.recommended = "true";
  if (destructive) element.dataset.destructive = "true";
  const copy = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = title;
  const description = document.createElement("span");
  description.textContent = detail;
  copy.append(heading, description);
  const button = createTextButton(icon, title);
  if (destructive) button.classList.add("boxed-lllllabc-frozen-delete");
  element.append(copy, button);
  return { element, button };
}

function appendImpact(list, labelText, valueText) {
  const label = document.createElement("dt");
  label.textContent = labelText;
  const value = document.createElement("dd");
  value.textContent = valueText;
  list.append(label, value);
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

function createTextButton(iconName, label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "menu_button boxed-lllllabc-action-button";
  const icon = document.createElement("i");
  icon.className = `fa-solid ${iconName}`;
  icon.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.textContent = label;
  button.append(icon, text);
  if (onClick) button.addEventListener("click", onClick);
  return button;
}

function formatDate(value) {
  if (!value) return "时间未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString();
}
