import { getStatusMessageAlignment } from "./presentation.js";

const STATUS_LINE_ID = "boxed-lllllabc-status-line";
const STATUS_PANEL_ID = "boxed-lllllabc-status-panel";
const STATUS_DIALOG_ID = "boxed-lllllabc-status-dialog";

let readDisplayMode = () => "message";
let readMessageCentered = () => false;
let openPanelHandler = () => {};
let latestStatus = null;
let chatObserver = null;
let rootObserver = null;
let observedChat = null;
let placementFrame = 0;
let observeRetryTimer = 0;

export function ensureStatusLine({ onOpenPanel, getDisplayMode, getMessageCentered } = {}) {
  if (typeof onOpenPanel === "function") {
    openPanelHandler = onOpenPanel;
  }

  if (typeof getDisplayMode === "function") {
    readDisplayMode = getDisplayMode;
  }

  if (typeof getMessageCentered === "function") {
    readMessageCentered = getMessageCentered;
  }

  ensureStatusElements();
  ensureStatusDialog();
  applyLatestStatus();
  syncStatusLinePlacement();
  observeChatChanges();
  observeRootChanges();
}

export function updateStatusLine(status) {
  latestStatus = status;
  ensureStatusLine();
}

export function syncStatusLinePlacement() {
  const { statusLine, panel } = ensureStatusElements();
  ensureStatusDialog();
  applyLatestStatus();
  observeChatChanges();
  observeRootChanges();

  const mode = readDisplayMode() === "top" ? "top" : "message";
  if (mode === "top") {
    placeAtChatTop(statusLine, panel);
    return;
  }

  panel.hidden = true;
  placeInsideLatestMessage(statusLine, panel);
}

export function openStatusDialog() {
  const dialog = ensureStatusDialog();
  dialog.hidden = false;
  dialog.setAttribute("aria-hidden", "false");
  dialog.querySelector(".boxed-lllllabc-dialog-close")?.focus();
}

export function closeStatusDialog() {
  const dialog = document.getElementById(STATUS_DIALOG_ID);
  if (!dialog) {
    return;
  }

  dialog.hidden = true;
  dialog.setAttribute("aria-hidden", "true");
  dialog.querySelector(".boxed-lllllabc-dialog-body")?.removeAttribute("data-recent-expanded");
}

function ensureStatusElements() {
  const statusLine = document.getElementById(STATUS_LINE_ID) ?? createStatusLine();
  const panel = document.getElementById(STATUS_PANEL_ID) ?? createInlinePanel();

  if (!statusLine.isConnected || !panel.isConnected) {
    const fallback = document.querySelector("#extensions_settings") ?? document.body;
    fallback?.append(statusLine, panel);
  }

  return { statusLine, panel };
}

function createStatusLine() {
  const statusLine = document.createElement("div");
  statusLine.id = STATUS_LINE_ID;
  statusLine.className = "boxed-lllllabc-status-line";
  statusLine.setAttribute("role", "button");
  statusLine.tabIndex = 0;

  const signal = document.createElement("span");
  signal.className = "boxed-lllllabc-status-signal";
  signal.setAttribute("aria-hidden", "true");

  const text = document.createElement("span");
  text.id = "boxed-lllllabc-status-text";
  text.textContent = "未初始化";

  statusLine.addEventListener("click", () => openPanelHandler());
  statusLine.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    openPanelHandler();
  });

  statusLine.append(signal, text);
  return statusLine;
}

function createInlinePanel() {
  const panel = document.createElement("div");
  panel.id = STATUS_PANEL_ID;
  panel.className = "boxed-lllllabc-panel";
  panel.hidden = true;

  const panelTitle = document.createElement("div");
  panelTitle.className = "boxed-lllllabc-panel-title";
  panelTitle.textContent = "当前聊天备份";

  const panelBody = document.createElement("div");
  panelBody.id = "boxed-lllllabc-status-panel-body";
  panelBody.className = "boxed-lllllabc-panel-body";
  panelBody.textContent = "暂无数据。";

  panel.append(panelTitle, panelBody);
  return panel;
}

function applyLatestStatus() {
  const statusLine = document.getElementById(STATUS_LINE_ID);
  const text = document.getElementById("boxed-lllllabc-status-text");
  if (!statusLine || !text || !latestStatus) {
    return;
  }

  if (text.textContent !== latestStatus.shortText) {
    text.textContent = latestStatus.shortText;
  }
  statusLine.dataset.status = getVisualStatus(latestStatus.code);
  statusLine.setAttribute("aria-label", `${latestStatus.shortText}，查看当前聊天备份`);
  statusLine.title = "查看当前聊天备份";
}

function ensureStatusDialog() {
  const dialog = document.getElementById(STATUS_DIALOG_ID);
  if (dialog) {
    return dialog;
  }

  const nextDialog = createStatusDialog();
  document.body?.append(nextDialog);
  return nextDialog;
}

function placeAtChatTop(statusLine, panel) {
  statusLine.dataset.placement = "top";
  delete statusLine.dataset.messageAlign;
  delete statusLine.dataset.host;
  const target = document.querySelector("#chat") ?? document.querySelector("#chat_container");
  if (target?.parentElement) {
    const parent = target.parentElement;
    if (statusLine.parentElement !== parent || statusLine.nextElementSibling !== panel || panel.nextElementSibling !== target) {
      parent.insertBefore(panel, target);
      parent.insertBefore(statusLine, panel);
    }
    return;
  }

  document.querySelector("#extensions_settings")?.append(statusLine, panel);
}

function placeInsideLatestMessage(statusLine, panel) {
  const chat = document.querySelector("#chat");
  const messages = chat ? Array.from(chat.querySelectorAll(".mes")) : [];
  const latestMessage = messages.at(-1);

  if (latestMessage) {
    statusLine.dataset.placement = "message";
    statusLine.dataset.messageAlign = getStatusMessageAlignment(readMessageCentered());

    const directMessageBlock = Array.from(latestMessage.children)
      .find((element) => element.classList.contains("mes_block"));
    const textContainer = latestMessage.querySelector(".mes_text")?.parentElement;
    const target = directMessageBlock
      ?? (textContainer && textContainer !== latestMessage ? textContainer : latestMessage);

    statusLine.dataset.host = target === latestMessage ? "message" : "content";
    if (statusLine.parentElement !== target || statusLine.nextElementSibling !== panel) {
      target.append(statusLine, panel);
    }
    return;
  }

  placeAtChatTop(statusLine, panel);
}

function observeChatChanges() {
  const chat = document.querySelector("#chat");
  if (!chat) {
    scheduleObserveRetry();
    return;
  }

  if (observedChat === chat) {
    return;
  }

  chatObserver?.disconnect();
  observedChat = chat;
  chatObserver = new MutationObserver(() => requestStatusLinePlacement());
  chatObserver.observe(chat, {
    childList: true,
    subtree: true,
  });
}

function getVisualStatus(code) {
  if (code === "checking") {
    return "checking";
  }

  if (code === "unconfirmed") {
    return "checking";
  }

  if (code === "saved" || code === "ok") {
    return "saved";
  }

  if (code === "failed" || code === "verify-unavailable" || code === "db-error" || code === "full-frozen") {
    return "failed";
  }

  return "disabled";
}

function observeRootChanges() {
  if (rootObserver || !document.body) {
    return;
  }

  rootObserver = new MutationObserver(() => {
    const currentChat = document.querySelector("#chat");
    const statusLine = document.getElementById(STATUS_LINE_ID);
    const panel = document.getElementById(STATUS_PANEL_ID);

    if (currentChat !== observedChat || !statusLine || !panel) {
      requestStatusLinePlacement();
    }
  });

  rootObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

function scheduleObserveRetry() {
  if (observeRetryTimer) {
    return;
  }

  observeRetryTimer = setTimeout(() => {
    observeRetryTimer = 0;
    observeChatChanges();
    requestStatusLinePlacement();
  }, 500);
}

function requestStatusLinePlacement() {
  if (placementFrame) {
    cancelAnimationFrame(placementFrame);
  }

  placementFrame = requestAnimationFrame(() => {
    placementFrame = 0;
    syncStatusLinePlacement();
  });
}

function createStatusDialog() {
  const dialog = document.createElement("div");
  dialog.id = STATUS_DIALOG_ID;
  dialog.className = "boxed-lllllabc-dialog";
  dialog.hidden = true;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-hidden", "true");
  dialog.setAttribute("aria-labelledby", "boxed-lllllabc-status-dialog-title");

  const backdrop = document.createElement("div");
  backdrop.className = "boxed-lllllabc-dialog-backdrop";
  backdrop.addEventListener("click", closeStatusDialog);

  const frame = document.createElement("div");
  frame.className = "boxed-lllllabc-dialog-frame";

  const header = document.createElement("div");
  header.className = "boxed-lllllabc-dialog-header";

  const title = document.createElement("div");
  title.id = "boxed-lllllabc-status-dialog-title";
  title.className = "boxed-lllllabc-panel-title";
  title.textContent = "当前聊天备份";

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "menu_button fa-solid fa-xmark boxed-lllllabc-dialog-close";
  closeButton.setAttribute("aria-label", "关闭");
  closeButton.title = "关闭";
  closeButton.addEventListener("click", closeStatusDialog);

  const body = document.createElement("div");
  body.id = "boxed-lllllabc-status-dialog-body";
  body.className = "boxed-lllllabc-dialog-body boxed-lllllabc-panel-body";
  body.textContent = "暂无数据。";

  header.append(title, closeButton);
  frame.append(header, body);
  dialog.append(backdrop, frame);

  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeStatusDialog();
    }
  });

  return dialog;
}
