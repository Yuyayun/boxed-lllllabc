import { formatStorageSize } from "../backup/catalog.js";

const WARNING_DIALOG_ID = "boxed-lllllabc-storage-warning-dialog";

export function renderSettingsStorage(snapshot = {}) {
  setText("#boxed-lllllabc-storage-extension", formatStorageSize(snapshot.extensionBytes));
  setText(
    "#boxed-lllllabc-storage-site",
    snapshot.estimate?.supported ? formatStorageSize(snapshot.estimate.usage) : "浏览器未提供",
  );
  setText(
    "#boxed-lllllabc-storage-remaining",
    snapshot.estimate?.supported ? `约 ${formatStorageSize(snapshot.estimate.remaining)}` : "无法估算",
  );

  const state = document.querySelector("#boxed-lllllabc-storage-state");
  if (state) {
    state.dataset.tone = snapshot.pressure || "unavailable";
    state.textContent = storageStateText(snapshot);
  }
  const issue = document.querySelector("#boxed-lllllabc-storage-issue");
  if (issue) {
    const messages = [];
    if (snapshot.invalidRecordCount) {
      messages.push(`已隔离 ${snapshot.invalidRecordCount} 条异常本地记录，没有自动删除。`);
    }
    if (snapshot.failure?.detail) messages.push(snapshot.failure.detail);
    issue.textContent = messages.join(" ");
    issue.hidden = messages.length === 0;
  }
}

export function createCurrentChatStorageText(snapshot = {}, currentChatBytes = 0) {
  const parts = [`当前聊天约 ${formatStorageSize(currentChatBytes)}`];
  if (snapshot.estimate?.supported) {
    parts.push(`预计还可使用 ${formatStorageSize(snapshot.estimate.remaining)}`);
  } else {
    parts.push("暂时无法估算剩余空间");
  }
  return parts.join(" · ");
}

export function openStorageWarningDialog({ snapshot = {}, onManage } = {}) {
  document.getElementById(WARNING_DIALOG_ID)?.remove();
  const dialog = document.createElement("div");
  dialog.id = WARNING_DIALOG_ID;
  dialog.className = "boxed-lllllabc-dialog boxed-lllllabc-storage-warning-dialog";
  dialog.setAttribute("role", "alertdialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "boxed-lllllabc-storage-warning-title");

  const backdrop = document.createElement("div");
  backdrop.className = "boxed-lllllabc-dialog-backdrop";
  const frame = document.createElement("div");
  frame.className = "boxed-lllllabc-dialog-frame boxed-lllllabc-storage-warning-frame";
  const header = document.createElement("header");
  header.className = "boxed-lllllabc-dialog-header";
  const title = document.createElement("strong");
  title.id = "boxed-lllllabc-storage-warning-title";
  title.textContent = snapshot.pressure === "error" ? "本次备份没有写入成功" : "本地存储空间偏紧";
  const close = createButton("", "fa-solid fa-xmark", "关闭");
  header.append(title, close);

  const body = document.createElement("div");
  body.className = "boxed-lllllabc-storage-warning-body";
  const message = document.createElement("p");
  message.textContent = snapshot.failure?.detail || pressureMessage(snapshot);
  const reassurance = document.createElement("p");
  reassurance.textContent = "扩展不会自动删除已有备份。你可以进入管理清理，逐个聊天、逐种类型确认处理。";
  body.append(message, reassurance);

  const footer = document.createElement("footer");
  footer.className = "boxed-lllllabc-storage-warning-footer";
  const later = createButton("稍后处理", "menu_button boxed-lllllabc-action-button");
  const manage = createButton("管理清理", "menu_button boxed-lllllabc-action-button");
  footer.append(later, manage);
  frame.append(header, body, footer);
  dialog.append(backdrop, frame);
  document.body.append(dialog);

  const finish = () => dialog.remove();
  close.addEventListener("click", finish);
  later.addEventListener("click", finish);
  backdrop.addEventListener("click", finish);
  manage.addEventListener("click", () => {
    finish();
    onManage?.();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") finish();
  });
  later.focus();
}

function storageStateText(snapshot) {
  if (snapshot.failure) return snapshot.failure.shortText;
  if (snapshot.pressure === "critical") return "空间非常紧张";
  if (snapshot.pressure === "warning") return "建议留意空间";
  if (snapshot.pressure === "normal") return "空间充足";
  return "无法估算配额";
}

function pressureMessage(snapshot) {
  if (snapshot.estimate?.supported) {
    return `浏览器估算可用空间只剩约 ${formatStorageSize(snapshot.estimate.remaining)}，继续增加备份可能导致后续写入失败。`;
  }
  return "浏览器没有提供可靠的剩余空间估算，请留意设备可用空间。";
}

function createButton(text, className, label = text) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  if (text) button.textContent = text;
  if (label) {
    button.title = label;
    button.setAttribute("aria-label", label);
  }
  return button;
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}
