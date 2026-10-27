const UPDATE_DIALOG_ID = "boxed-lllllabc-update-dialog";
const INFO_DIALOG_ID = "boxed-lllllabc-info-dialog";
const CHANGELOG_PANEL_ID = "boxed-lllllabc-info-changelog";
const USAGE_NOTICE = "本扩展可免费使用，禁止任何形式的商业用途。";

let extensionInfo = {
  name: "箱装辣白菜",
  version: "未知",
  author: "辣白菜 / labaicai0969",
  homePage: "",
  changelogUrl: "",
  fetchImpl: null,
};
let changelogRelease = null;
let changelogRequest = null;

export async function loadAndRenderExtensionInfo({ manifestUrl, fetchImpl = globalThis.fetch?.bind(globalThis) }) {
  let manifest = {};
  try {
    if (typeof fetchImpl === "function") {
      const response = await fetchImpl(manifestUrl);
      if (response.ok) manifest = await response.json();
    }
  } catch (error) {
    console.debug("[boxed-lllllabc] 读取扩展信息失败", error);
  }

  extensionInfo = {
    name: manifest.display_name || manifest.name || "箱装辣白菜",
    version: manifest.version || "未知",
    author: manifest.author || "辣白菜 / labaicai0969",
    homePage: manifest.homePage || "",
    changelogUrl: resolveSiblingAssetUrl(manifestUrl, "CHANGELOG.md"),
    fetchImpl: typeof fetchImpl === "function" ? fetchImpl : null,
  };
  changelogRelease = null;
  changelogRequest = null;
  setText("#boxed-lllllabc-version", `Ver ${extensionInfo.version}`);
  bindInfoToggle();
  return manifest;
}

export function resolveSiblingAssetUrl(sourceUrl, fileName) {
  const source = String(sourceUrl ?? "").split(/[?#]/, 1)[0];
  const lastSlash = source.lastIndexOf("/");
  return lastSlash >= 0 ? `${source.slice(0, lastSlash + 1)}${fileName}` : fileName;
}

export function parseVersionChangelog(markdown, version) {
  const targetVersion = String(version ?? "").trim();
  if (!targetVersion) return null;

  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  let start = -1;
  let date = "";

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^##\s+(.+?)\s*$/.exec(lines[index]);
    if (!match) continue;
    const heading = splitChangelogHeading(match[1]);
    if (heading.version === targetVersion) {
      start = index + 1;
      date = heading.date;
      break;
    }
  }

  if (start < 0) return null;

  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }

  const blocks = [];
  let paragraph = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };

  for (const sourceLine of lines.slice(start, end)) {
    const line = sourceLine.trim();
    if (!line) {
      flushParagraph();
      continue;
    }

    const section = /^###\s+(.+?)\s*$/.exec(line);
    if (section) {
      flushParagraph();
      blocks.push({ type: "heading", text: section[1] });
      continue;
    }

    const item = /^-\s+(.+?)\s*$/.exec(line);
    if (item) {
      flushParagraph();
      const previous = blocks.at(-1);
      if (previous?.type === "list") previous.items.push(item[1]);
      else blocks.push({ type: "list", items: [item[1]] });
      continue;
    }

    paragraph.push(line);
  }
  flushParagraph();

  return { version: targetVersion, date, blocks };
}

function splitChangelogHeading(value) {
  const match = /^(.+?)\s+[—–-]\s+(.+)$/.exec(value.trim());
  return match
    ? { version: match[1].trim(), date: match[2].trim() }
    : { version: value.trim(), date: "" };
}

export function renderUpdateState(state) {
  const hint = document.querySelector("#boxed-lllllabc-update-hint");
  if (hint) hint.hidden = state !== "available";

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
    message.textContent = "酒馆已经检测到远程仓库有新版本。更新由 SillyTavern 扩展管理接口执行，不会修改酒馆聊天文件或备份。";
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
  const heading = document.createElement("div");
  heading.className = "boxed-lllllabc-info-heading";
  const title = document.createElement("strong");
  title.id = "boxed-lllllabc-info-title";
  title.textContent = extensionInfo.name;
  const version = document.createElement("span");
  version.textContent = `版本 ${extensionInfo.version}`;
  heading.append(title, version);
  identity.append(heading);
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
  const changelogAction = createChangelogAction();
  footer.append(repositoryAction, changelogAction);

  const changelog = document.createElement("section");
  changelog.id = CHANGELOG_PANEL_ID;
  changelog.className = "boxed-lllllabc-info-changelog";
  changelog.hidden = true;
  changelog.tabIndex = 0;
  changelog.setAttribute("role", "region");
  changelog.setAttribute("aria-label", "当前版本更新日志");

  frame.append(header, body, footer, changelog);
  dialog.append(backdrop, frame);
  document.body.append(dialog);

  changelogAction.addEventListener("click", () => toggleChangelog(changelogAction, changelog));

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
  action.className = "menu_button boxed-lllllabc-info-action boxed-lllllabc-info-repository";
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

function createChangelogAction() {
  const action = createButton(
    "fa-file-lines",
    "",
    "menu_button boxed-lllllabc-info-action boxed-lllllabc-info-changelog-toggle",
  );
  action.title = "展开更新日志";
  action.setAttribute("aria-label", "展开更新日志");
  action.setAttribute("aria-expanded", "false");
  action.setAttribute("aria-controls", CHANGELOG_PANEL_ID);
  return action;
}

async function toggleChangelog(action, panel) {
  const willOpen = panel.hidden;
  panel.hidden = !willOpen;
  action.setAttribute("aria-expanded", String(willOpen));
  action.title = willOpen ? "收起更新日志" : "展开更新日志";
  action.setAttribute("aria-label", action.title);
  if (!willOpen || panel.dataset.state === "ready" || panel.dataset.state === "loading") return;

  panel.dataset.state = "loading";
  panel.setAttribute("aria-busy", "true");
  renderChangelogMessage(panel, "正在读取当前版本的更新日志……");

  try {
    const release = await loadCurrentChangelog();
    renderChangelogRelease(panel, release);
    panel.dataset.state = "ready";
  } catch (error) {
    console.debug("[boxed-lllllabc] 读取更新日志失败", error);
    renderChangelogMessage(
      panel,
      "暂时无法读取当前版本的更新日志，请使用旁边的 GitHub 按钮查看仓库中的 CHANGELOG.md。",
      "error",
    );
    panel.dataset.state = "error";
  } finally {
    panel.removeAttribute("aria-busy");
  }
}

async function loadCurrentChangelog() {
  if (changelogRelease) return changelogRelease;
  if (changelogRequest) return changelogRequest;

  changelogRequest = (async () => {
    if (!extensionInfo.fetchImpl || !extensionInfo.changelogUrl) {
      throw new Error("更新日志读取功能不可用");
    }

    const response = await extensionInfo.fetchImpl(extensionInfo.changelogUrl);
    if (!response.ok) throw new Error(`更新日志请求失败：${response.status}`);
    const release = parseVersionChangelog(await response.text(), extensionInfo.version);
    if (!release) throw new Error(`更新日志中没有版本 ${extensionInfo.version}`);
    changelogRelease = release;
    return release;
  })();

  try {
    return await changelogRequest;
  } finally {
    if (!changelogRelease) changelogRequest = null;
  }
}

function renderChangelogMessage(panel, message, tone = "loading") {
  const text = document.createElement("p");
  text.className = "boxed-lllllabc-info-changelog-message";
  text.dataset.tone = tone;
  text.setAttribute("role", tone === "error" ? "alert" : "status");
  text.textContent = message;
  panel.replaceChildren(text);
}

function renderChangelogRelease(panel, release) {
  const heading = document.createElement("div");
  heading.className = "boxed-lllllabc-info-changelog-heading";
  const title = document.createElement("strong");
  title.textContent = `版本 ${release.version}`;
  heading.append(title);
  if (release.date) {
    const date = document.createElement("span");
    date.textContent = release.date;
    heading.append(date);
  }

  const content = document.createDocumentFragment();
  content.append(heading);
  for (const block of release.blocks) {
    if (block.type === "heading") {
      const sectionTitle = document.createElement("h3");
      sectionTitle.textContent = block.text;
      content.append(sectionTitle);
      continue;
    }

    if (block.type === "list") {
      const list = document.createElement("ul");
      for (const item of block.items) {
        const listItem = document.createElement("li");
        listItem.textContent = item;
        list.append(listItem);
      }
      content.append(list);
      continue;
    }

    const paragraph = document.createElement("p");
    paragraph.textContent = block.text;
    content.append(paragraph);
  }

  if (!release.blocks.length) {
    const empty = document.createElement("p");
    empty.textContent = "这个版本没有记录具体变更。";
    content.append(empty);
  }
  panel.replaceChildren(content);
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
