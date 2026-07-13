const UPDATE_DIALOG_ID = "boxed-lllllabc-update-dialog";
const INFO_DIALOG_ID = "boxed-lllllabc-info-dialog";
const USAGE_NOTICE = "本扩展可免费使用，禁止任何形式的商业用途。";

let extensionInfo = {
  name: "箱装辣白菜",
  version: "未知",
  author: "辣白菜 / labaicai0969",
  homePage: "",
};

export async function loadAndRenderExtensionInfo({ manifestUrl, fetchImpl = globalThis.fetch?.bind(globalThis) }) {
  let manifest = {};
  try {
    const response = await fetchImpl(manifestUrl);
    if (response.ok) manifest = await response.json();
  } catch (error) {
    console.debug("[boxed-lllllabc] 读取扩展信息失败", error);
  }

  extensionInfo = {
    name: manifest.display_name || manifest.name || "箱装辣白菜",
    version: manifest.version || "未知",
    author: manifest.author || "辣白菜 / labaicai0969",
    homePage: manifest.homePage || "",
  };
  setText("#boxed-lllllabc-version", `Ver ${extensionInfo.version}`);
  bindInfoToggle();
  return manifest;
}

export function renderUpdateState(state) {
  const button = document.querySelector("#boxed-lllllabc-update-available");
  if (!button) return;
  const visible = state !== "hidden";
  button.hidden = !visible;
  button.disabled = state === "updating" || state === "updated";
  button.setAttribute("aria-busy", String(state === "updating"));
  button.classList.toggle("boxed-lllllabc-is-busy", state === "updating");
  const label = button.querySelector("span");
  if (label) {
    label.textContent = state === "updating"
      ? "正在更新"
      : state === "updated"
        ? "更新完成，即将刷新"
        : "发现新版本";
  }
}

export function bindUpdateAction(onUpdate) {
  document.querySelector("#boxed-lllllabc-update-available")
    ?.addEventListener("click", () => onUpdate?.());
}

export function confirmExtensionUpdate() {
  document.getElementById(UPDATE_DIALOG_ID)?.remove();
  return new Promise((resolve) => {
    const dialog = document.createElement("div");
    dialog.id = UPDATE_DIALOG_ID;
    dialog.className = "boxed-lllllabc-dialog boxed-lllllabc-update-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "boxed-lllllabc-update-title");

    const backdrop = document.createElement("div");
    backdrop.className = "boxed-lllllabc-dialog-backdrop";
    const frame = document.createElement("div");
    frame.className = "boxed-lllllabc-dialog-frame boxed-lllllabc-update-frame";
    const header = document.createElement("header");
    header.className = "boxed-lllllabc-dialog-header";
    const title = document.createElement("strong");
    title.id = "boxed-lllllabc-update-title";
    title.textContent = "更新箱装辣白菜";
    const close = createButton("fa-xmark", "", "menu_button boxed-lllllabc-dialog-close");
    close.title = "关闭";
    close.setAttribute("aria-label", "关闭");
    header.append(title, close);

    const body = document.createElement("div");
    body.className = "boxed-lllllabc-update-body";
    const message = document.createElement("p");
    message.textContent = "酒馆已经检测到远程仓库有新版本。更新由 SillyTavern 扩展管理接口执行，不会修改聊天或本地备份。";
    const detail = document.createElement("p");
    detail.textContent = "更新完成后酒馆会自动刷新。请先等待当前回复生成结束，并完成手头操作。";
    body.append(message, detail);

    const footer = document.createElement("footer");
    footer.className = "boxed-lllllabc-update-footer";
    const later = createButton("", "暂不更新", "menu_button boxed-lllllabc-action-button");
    const confirm = createButton("fa-download", "开始更新", "menu_button boxed-lllllabc-action-button");
    footer.append(later, confirm);
    frame.append(header, body, footer);
    dialog.append(backdrop, frame);
    document.body.append(dialog);

    const finish = (accepted) => {
      dialog.remove();
      resolve(accepted);
    };
    backdrop.addEventListener("click", () => finish(false));
    close.addEventListener("click", () => finish(false));
    later.addEventListener("click", () => finish(false));
    confirm.addEventListener("click", () => finish(true));
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") finish(false);
    });
    confirm.focus();
  });
}

function bindInfoToggle() {
  const button = document.querySelector("#boxed-lllllabc-info-toggle");
  if (!button || button.dataset.bound === "true") return;
  button.dataset.bound = "true";
  button.addEventListener("click", () => openExtensionInfoDialog({ returnFocusTo: button }));
}

export function openExtensionInfoDialog({ returnFocusTo } = {}) {
  document.getElementById(INFO_DIALOG_ID)?.remove();
  const dialog = document.createElement("div");
  dialog.id = INFO_DIALOG_ID;
  dialog.className = "boxed-lllllabc-dialog boxed-lllllabc-info-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "boxed-lllllabc-info-title");

  const backdrop = document.createElement("div");
  backdrop.className = "boxed-lllllabc-dialog-backdrop";
  const frame = document.createElement("div");
  frame.className = "boxed-lllllabc-dialog-frame boxed-lllllabc-info-frame";
  const header = document.createElement("header");
  header.className = "boxed-lllllabc-dialog-header boxed-lllllabc-info-header";
  const identity = document.createElement("div");
  identity.className = "boxed-lllllabc-info-identity";
  const mark = document.createElement("span");
  mark.className = "boxed-lllllabc-info-mark";
  mark.setAttribute("aria-hidden", "true");
  const markIcon = document.createElement("i");
  markIcon.className = "fa-solid fa-box-archive";
  mark.append(markIcon);
  const heading = document.createElement("div");
  heading.className = "boxed-lllllabc-info-heading";
  const title = document.createElement("strong");
  title.id = "boxed-lllllabc-info-title";
  title.textContent = extensionInfo.name;
  const version = document.createElement("span");
  version.textContent = `版本 ${extensionInfo.version}`;
  heading.append(title, version);
  identity.append(mark, heading);
  const close = createButton("fa-xmark", "", "menu_button boxed-lllllabc-dialog-close");
  close.title = "关闭";
  close.setAttribute("aria-label", "关闭扩展信息");
  header.append(identity, close);

  const body = document.createElement("div");
  body.className = "boxed-lllllabc-info-body";
  const author = document.createElement("p");
  author.className = "boxed-lllllabc-info-author";
  const authorLabel = document.createElement("span");
  authorLabel.textContent = "作者";
  const authorName = document.createElement("strong");
  authorName.textContent = extensionInfo.author;
  author.append(authorLabel, authorName);
  const notice = document.createElement("div");
  notice.className = "boxed-lllllabc-info-notice";
  const noticeTitle = document.createElement("strong");
  noticeTitle.textContent = "使用说明";
  const noticeText = document.createElement("span");
  noticeText.textContent = USAGE_NOTICE;
  notice.append(noticeTitle, noticeText);
  body.append(author, notice);

  const footer = document.createElement("footer");
  footer.className = "boxed-lllllabc-info-footer";
  const repositoryAction = createRepositoryAction(extensionInfo.homePage);
  const repositoryState = document.createElement("span");
  repositoryState.textContent = extensionInfo.homePage ? "GitHub 仓库" : "GitHub 仓库尚未发布";
  footer.append(repositoryAction, repositoryState);

  frame.append(header, body, footer);
  dialog.append(backdrop, frame);
  document.body.append(dialog);

  const finish = () => {
    dialog.remove();
    setTimeout(() => returnFocusTo?.focus?.(), 0);
  };
  close.addEventListener("click", finish);
  backdrop.addEventListener("click", finish);
  dialog.addEventListener("keyup", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      finish();
    }
  });
  close.focus();
}

function createRepositoryAction(value) {
  const action = document.createElement(value ? "a" : "button");
  action.className = "menu_button boxed-lllllabc-info-repository";
  const label = value ? "打开 GitHub 仓库" : "GitHub 仓库尚未发布";
  action.title = label;
  action.setAttribute("aria-label", label);
  if (value) {
    action.href = value;
    action.target = "_blank";
    action.rel = "noopener noreferrer";
  } else {
    action.type = "button";
    action.disabled = true;
  }
  const icon = document.createElement("i");
  icon.className = "fa-brands fa-github";
  icon.setAttribute("aria-hidden", "true");
  action.append(icon);
  return action;
}

function createButton(iconName, text, className) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  if (iconName) {
    const icon = document.createElement("i");
    icon.className = `fa-solid ${iconName}`;
    icon.setAttribute("aria-hidden", "true");
    button.append(icon);
  }
  if (text) {
    const label = document.createElement("span");
    label.textContent = text;
    button.append(label);
  }
  return button;
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}
