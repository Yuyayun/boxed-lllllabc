import { formatStorageSize } from "../backup/catalog.js";

const CLEANUP_DIALOG_ID = "boxed-lllllabc-cleanup-dialog";

export function openBackupCleanupDialog({ chat, plans = [], onConfirm } = {}) {
  closeBackupCleanupDialog();
  const dialog = document.createElement("div");
  dialog.id = CLEANUP_DIALOG_ID;
  dialog.className = "boxed-lllllabc-dialog boxed-lllllabc-cleanup-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "boxed-lllllabc-cleanup-title");

  const backdrop = document.createElement("div");
  backdrop.className = "boxed-lllllabc-dialog-backdrop";
  backdrop.addEventListener("click", closeBackupCleanupDialog);
  const frame = document.createElement("div");
  frame.className = "boxed-lllllabc-dialog-frame boxed-lllllabc-cleanup-frame";
  const header = document.createElement("header");
  header.className = "boxed-lllllabc-dialog-header";
  const heading = document.createElement("div");
  heading.className = "boxed-lllllabc-cleanup-heading";
  const kicker = document.createElement("span");
  kicker.textContent = "本地数据管理";
  const title = document.createElement("strong");
  title.id = "boxed-lllllabc-cleanup-title";
  title.textContent = "清理聊天备份";
  const subtitle = document.createElement("span");
  subtitle.textContent = chat?.displayName || "未命名聊天";
  heading.append(kicker, title, subtitle);
  const close = createIconButton("fa-xmark", "关闭", closeBackupCleanupDialog);
  close.classList.add("boxed-lllllabc-dialog-close");
  header.append(heading, close);
  const body = document.createElement("div");
  body.className = "boxed-lllllabc-cleanup-body";
  frame.append(header, body);
  dialog.append(backdrop, frame);
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeBackupCleanupDialog();
  });
  document.body.append(dialog);

  const renderChooser = () => renderCleanupChooser(body, plans, renderConfirmation);
  const renderConfirmation = (plan) => renderCleanupConfirmation({
    body,
    plan,
    onBack: renderChooser,
    onConfirm,
  });
  renderChooser();
  close.focus();
  return dialog;
}

export function closeBackupCleanupDialog() {
  document.getElementById(CLEANUP_DIALOG_ID)?.remove();
}

function renderCleanupChooser(body, plans, onPreview) {
  body.replaceChildren();
  const safety = document.createElement("section");
  safety.className = "boxed-lllllabc-cleanup-safety";
  const icon = document.createElement("i");
  icon.className = "fa-solid fa-shield-halved";
  icon.setAttribute("aria-hidden", "true");
  const copy = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = "只清理扩展当前活动存储的数据";
  const detail = document.createElement("span");
  detail.textContent = "不会删除或修改 SillyTavern 聊天文件。每次只能清理一种备份，确认前会再次校验数据。";
  copy.append(title, detail);
  safety.append(icon, copy);

  const list = document.createElement("div");
  list.className = "boxed-lllllabc-cleanup-list";
  for (const plan of plans) {
    list.append(renderCleanupOption(plan, onPreview));
  }
  body.append(safety, list);
}

function renderCleanupOption(plan, onPreview) {
  const row = document.createElement("article");
  row.className = "boxed-lllllabc-cleanup-option";
  row.dataset.available = String(Boolean(plan.canConfirm));
  const copy = document.createElement("div");
  copy.className = "boxed-lllllabc-cleanup-option-copy";
  const title = document.createElement("strong");
  title.textContent = plan.typeLabel;
  const meta = document.createElement("span");
  meta.textContent = `${plan.rangeText} · ${plan.count} 条 · ${formatStorageSize(plan.storageBytes)}`;
  const reason = document.createElement("small");
  reason.textContent = plan.blockedReason || "可预览清理影响；对应备份开关不会改变。";
  copy.append(title, meta, reason);
  const action = createTextButton("fa-magnifying-glass", plan.canConfirm ? "预览清理" : "不可清理", () => onPreview(plan));
  action.disabled = !plan.canConfirm;
  if (plan.blockedReason) action.title = plan.blockedReason;
  row.append(copy, action);
  return row;
}

function renderCleanupConfirmation({ body, plan, onBack, onConfirm }) {
  body.replaceChildren();
  const warning = document.createElement("section");
  warning.className = "boxed-lllllabc-cleanup-warning";
  const icon = document.createElement("i");
  icon.className = "fa-solid fa-trash-can";
  icon.setAttribute("aria-hidden", "true");
  const copy = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = `将清理${plan.typeLabel}`;
  const detail = document.createElement("span");
  detail.textContent = plan.notice;
  copy.append(title, detail);
  warning.append(icon, copy);

  const impact = document.createElement("dl");
  impact.className = "boxed-lllllabc-cleanup-impact";
  appendImpact(impact, "聊天", plan.chatName);
  appendImpact(impact, "备份类型", plan.typeLabel);
  appendImpact(impact, "删除范围", plan.rangeText);
  appendImpact(impact, "本地记录", `${plan.count} 条`);
  appendImpact(impact, "估算占用", formatStorageSize(plan.storageBytes));

  const regeneration = document.createElement("p");
  regeneration.className = "boxed-lllllabc-cleanup-regeneration";
  regeneration.textContent = "如果相应备份开关仍然开启，之后的聊天操作可能重新生成这类备份。";
  const error = document.createElement("div");
  error.className = "boxed-lllllabc-restore-error";
  error.hidden = true;

  const footer = document.createElement("footer");
  footer.className = "boxed-lllllabc-cleanup-footer";
  const back = createTextButton("fa-arrow-left", "返回", onBack);
  const confirm = createTextButton("fa-trash-can", "确认清理本地备份", async () => {
    confirm.disabled = true;
    back.disabled = true;
    error.hidden = true;
    try {
      const result = await onConfirm?.(plan);
      if (!result?.ok) {
        error.textContent = result?.reason || "清理失败，请重新打开后再试。";
        error.hidden = false;
        return;
      }
      globalThis.toastr?.success?.(`已清理${plan.typeLabel}。`, "箱装辣白菜");
      closeBackupCleanupDialog();
    } finally {
      if (confirm.isConnected) {
        confirm.disabled = false;
        back.disabled = false;
      }
    }
  });
  confirm.classList.add("boxed-lllllabc-cleanup-confirm");
  footer.append(back, confirm);
  body.append(warning, impact, regeneration, error, footer);
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
  button.addEventListener("click", onClick);
  return button;
}
