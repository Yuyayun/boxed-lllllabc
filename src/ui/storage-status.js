import { formatStorageSize } from "../backup/catalog.js";

const WARNING_DIALOG_ID = "boxed-lllllabc-storage-warning-dialog";

export function renderSettingsStorage(snapshot = {}) {
  const presentation = createSettingsStoragePresentation(snapshot);
  setText("#boxed-lllllabc-storage-title", presentation.title);
  setText("#boxed-lllllabc-storage-site-label", presentation.siteLabel);
  setText("#boxed-lllllabc-storage-remaining-label", presentation.remainingLabel);
  setText("#boxed-lllllabc-storage-help", presentation.help);
  setText("#boxed-lllllabc-storage-extension", presentation.extensionText);
  setText("#boxed-lllllabc-storage-site", presentation.siteText);
  setText("#boxed-lllllabc-storage-remaining", presentation.remainingText);

  const state = document.querySelector("#boxed-lllllabc-storage-state");
  if (state) {
    state.dataset.tone = snapshot.pressure || "unavailable";
    state.textContent = presentation.stateText;
  }
  const issue = document.querySelector("#boxed-lllllabc-storage-issue");
  if (issue) {
    issue.textContent = presentation.issue;
    issue.hidden = !presentation.issue;
  }
}

export function createSettingsStoragePresentation(snapshot = {}) {
  const sqlite = snapshot.mode === "sqlite";
  const bytes = (value, missing) => Number.isFinite(value) && value >= 0 ? formatStorageSize(value) : missing;
  const unavailable = snapshot.loading ? "正在读取" : snapshot.failure ? "当前不可读取" : sqlite ? "服务器未提供" : "浏览器未提供";
  const messages = [];
  if (snapshot.invalidRecordCount) messages.push(`已隔离 ${snapshot.invalidRecordCount} 条异常备份记录，没有自动删除。`);
  if (snapshot.failure?.detail) messages.push(snapshot.failure.detail);
  return {
    title: sqlite ? "SQLite 存储状态" : "IndexedDB 存储状态",
    siteLabel: sqlite ? "SQLite 文件占用（含日志）" : "当前酒馆来源已使用",
    remainingLabel: sqlite ? "服务器磁盘可用" : "当前酒馆来源可用（估算）",
    help: sqlite ? "统计来自服务器 SQLite。磁盘可用是所在文件系统的空间，不是 SQLite 配额；文件大小与记录内容大小不同。"
      : "内容为普通备份与已完成快照的估算；浏览器用量和可用空间属于整个酒馆来源，不能视为箱装独占空间。",
    extensionText: snapshot.failure ? unavailable : bytes(snapshot.extensionBytes, unavailable),
    siteText: snapshot.failure ? unavailable : sqlite ? bytes(snapshot.databaseBytes, unavailable)
      : snapshot.estimate?.supported ? bytes(snapshot.estimate.usage, unavailable) : unavailable,
    remainingText: snapshot.failure ? unavailable : sqlite ? bytes(snapshot.availableBytes, unavailable)
      : snapshot.estimate?.supported && Number.isFinite(snapshot.estimate.remaining) ? `约 ${formatStorageSize(snapshot.estimate.remaining)}` : unavailable,
    stateText: storageStateText(snapshot), issue: messages.join(" "),
  };
}

export function createCurrentChatStorageText(snapshot = {}, currentChatBytes = 0) {
  const parts = [`当前聊天约 ${formatStorageSize(currentChatBytes)}`];
  if (snapshot.mode === "sqlite") {
    parts.push(!snapshot.failure && Number.isFinite(snapshot.availableBytes) && snapshot.availableBytes >= 0 ? `服务器磁盘可用 ${formatStorageSize(snapshot.availableBytes)}` : "服务器可用空间未提供");
  } else if (snapshot.estimate?.supported) {
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
  if (snapshot.loading) return `正在读取 ${snapshot.mode === "sqlite" ? "SQLite" : "IndexedDB"}`;
  if (snapshot.failure) return snapshot.failure.shortText;
  if (snapshot.mode === "sqlite") return snapshot.readable === true && snapshot.writable === true ? "SQLite 可读取、可写入"
    : snapshot.readable === true && snapshot.writable === false ? "SQLite 可读取 · 不可写入" : "SQLite 读写状态未确认";
  if (snapshot.checkedAt) {
    if (snapshot.pressure === "critical") return "IndexedDB 可读取 · 空间非常紧张";
    if (snapshot.pressure === "warning") return "IndexedDB 可读取 · 建议留意空间";
    return snapshot.pressure === "normal" ? "IndexedDB 可读取 · 空间充足" : "IndexedDB 可读取 · 配额未提供";
  }
  return "正在读取";
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
