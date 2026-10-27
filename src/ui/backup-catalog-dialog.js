import { formatStorageSize, groupCatalogChats } from "../backup/catalog.js";
import { renderBatchCleanupSection, closeBatchCleanupDialog } from "./batch-cleanup.js";
import { trackCatalogViewport } from "./catalog-viewport.js";

const CATALOG_DIALOG_ID = "boxed-lllllabc-catalog-dialog";
let latestCatalog = null;
let currentQuery = "";
let openCleanupHandler = null;
let batchHandlers = {};
let releaseViewport = () => {};
const collapsedOwnerKeys = new Set();

export function openBackupCatalogDialog({ onRefresh, onOpenCleanup, onPreviewBatch, onExecuteBatch } = {}) {
  closeBackupCatalogDialog();
  latestCatalog = null;
  currentQuery = "";
  openCleanupHandler = onOpenCleanup;
  batchHandlers = { onPreview: onPreviewBatch, onExecute: onExecuteBatch };

  const dialog = document.createElement("div");
  dialog.id = CATALOG_DIALOG_ID;
  dialog.className = "boxed-lllllabc-dialog boxed-lllllabc-catalog-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "boxed-lllllabc-catalog-title");

  const backdrop = document.createElement("div");
  backdrop.className = "boxed-lllllabc-dialog-backdrop";
  backdrop.addEventListener("click", closeBackupCatalogDialog);

  const frame = document.createElement("div");
  frame.className = "boxed-lllllabc-dialog-frame boxed-lllllabc-catalog-frame";

  const header = document.createElement("header");
  header.className = "boxed-lllllabc-dialog-header boxed-lllllabc-catalog-header";
  const heading = document.createElement("div");
  heading.className = "boxed-lllllabc-catalog-heading";
  const kicker = document.createElement("span");
  kicker.className = "boxed-lllllabc-catalog-kicker";
  kicker.textContent = "备份管理";
  const title = document.createElement("strong");
  title.id = "boxed-lllllabc-catalog-title";
  title.textContent = "全部聊天备份";
  heading.append(kicker, title);

  const headerActions = document.createElement("div");
  headerActions.className = "boxed-lllllabc-catalog-header-actions";
  const refresh = createIconButton("fa-rotate", "刷新全部聊天备份", async () => {
    refresh.disabled = true;
    refresh.classList.add("boxed-lllllabc-is-busy");
    try {
      await onRefresh?.();
    } finally {
      if (refresh.isConnected) {
        refresh.disabled = false;
        refresh.classList.remove("boxed-lllllabc-is-busy");
      }
    }
  });
  refresh.classList.add("boxed-lllllabc-catalog-refresh");
  const close = createIconButton("fa-xmark", "关闭", closeBackupCatalogDialog);
  close.classList.add("boxed-lllllabc-dialog-close");
  headerActions.append(refresh, close);
  header.append(heading, headerActions);

  const body = document.createElement("div");
  body.className = "boxed-lllllabc-catalog-body";
  body.setAttribute("aria-live", "polite");

  const mobileFooter = document.createElement("footer");
  mobileFooter.className = "boxed-lllllabc-catalog-mobile-footer";
  const mobileClose = createTextButton("fa-xmark", "关闭", closeBackupCatalogDialog);
  mobileClose.classList.add("boxed-lllllabc-catalog-mobile-close");
  mobileFooter.append(mobileClose);

  frame.append(header, body, mobileFooter);
  dialog.append(backdrop, frame);
  dialog.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") closeBackupCatalogDialog();
    if (event.key === "Tab") {
      const controls = [...dialog.querySelectorAll("button:not(:disabled),input:not(:disabled),select:not(:disabled),summary")]
        .filter(node => node.getClientRects().length && node.checkVisibility?.() !== false);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus();
      }
    }
  });
  dialog.addEventListener("keyup", event => event.stopPropagation());
  document.body.append(dialog);
  releaseViewport = trackCatalogViewport(dialog);
  try {
    close.focus({ preventScroll: true });
  } catch {
    close.focus();
  }
  renderBackupCatalogDialog({ loading: true });
  return dialog;
}

export function renderBackupCatalogDialog({ catalog = null, loading = false, error = "" } = {}) {
  const body = document.querySelector(`#${CATALOG_DIALOG_ID} .boxed-lllllabc-catalog-body`);
  if (!body) return;
  if (catalog) latestCatalog = catalog;
  const containedFocus = body.contains(document.activeElement);
  body.replaceChildren();
  if (containedFocus) body.closest(`#${CATALOG_DIALOG_ID}`).querySelector(".boxed-lllllabc-dialog-close")?.focus({ preventScroll: true });

  if (loading) {
    body.append(renderState("fa-box-archive", "正在整理备份列表…", "会读取当前备份位置，不会访问或修改酒馆聊天文件。"));
    return;
  }
  if (error) {
    body.append(renderState("fa-triangle-exclamation", "无法读取全部聊天备份", error, true));
    return;
  }
  if (!latestCatalog) {
    body.append(renderState("fa-box-open", "还没有聊天备份", "打开聊天并启用备份后，这里会显示备份列表。"));
    return;
  }

  body.append(renderCatalogSummary(latestCatalog));
  if (!latestCatalog.chatCount) {
    body.append(renderState("fa-box-open", "还没有聊天备份", "打开聊天并启用备份后，这里会显示备份列表。"));
    return;
  }

  const search = document.createElement("label");
  search.className = "boxed-lllllabc-catalog-search";
  const searchIcon = document.createElement("i");
  searchIcon.className = "fa-solid fa-magnifying-glass";
  searchIcon.setAttribute("aria-hidden", "true");
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "搜索聊天名称或角色";
  input.setAttribute("aria-label", "搜索全部聊天备份");
  input.value = currentQuery;
  search.append(searchIcon, input);

  const result = document.createElement("div");
  result.className = "boxed-lllllabc-catalog-results";
  const renderResults = () => {
    currentQuery = input.value.trim();
    const chats = filterChats(latestCatalog.chats, currentQuery);
    result.replaceChildren();
    if (!chats.length) {
      result.append(renderState("fa-magnifying-glass", "没有匹配的聊天", "换一个聊天名称或角色名试试。"));
      return;
    }
    for (const group of groupCatalogChats(chats)) {
      result.append(renderCatalogGroup(group, Boolean(currentQuery)));
    }
  };
  input.addEventListener("input", renderResults);
  renderResults();
  body.append(search);
  if (typeof batchHandlers.onPreview === "function") body.append(renderBatchCleanupSection({ catalog: latestCatalog, ...batchHandlers }));
  body.append(result);
}

function renderCatalogGroup(group, forceOpen = false) {
  const section = document.createElement("details");
  section.className = "boxed-lllllabc-catalog-group";
  section.open = forceOpen || !collapsedOwnerKeys.has(group.ownerKey);

  const summary = document.createElement("summary");
  summary.className = "boxed-lllllabc-catalog-group-summary";
  const heading = document.createElement("div");
  heading.className = "boxed-lllllabc-catalog-group-heading";
  const icon = document.createElement("i");
  icon.className = group.ownerTypeLabel === "群聊"
    ? "fa-solid fa-user-group"
    : group.ownerTypeLabel === "角色"
      ? "fa-solid fa-user"
      : "fa-solid fa-box-archive";
  icon.setAttribute("aria-hidden", "true");
  const copy = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = group.ownerName;
  const meta = document.createElement("span");
  meta.textContent = [
    group.ownerTypeLabel,
    `${group.chatCount} 个聊天`,
    `${group.recordCount} 条备份`,
    formatStorageSize(group.storageBytes),
  ].join(" · ");
  copy.append(title, meta);
  heading.append(icon, copy);
  const chevron = document.createElement("i");
  chevron.className = "fa-solid fa-chevron-right boxed-lllllabc-catalog-group-chevron";
  chevron.setAttribute("aria-hidden", "true");
  summary.append(heading, chevron);

  const entries = document.createElement("div");
  entries.className = "boxed-lllllabc-catalog-group-entries";
  for (const chat of group.chats) entries.append(renderCatalogEntry(chat));
  section.append(summary, entries);
  section.addEventListener("toggle", () => {
    if (currentQuery) return;
    if (section.open) collapsedOwnerKeys.delete(group.ownerKey);
    else collapsedOwnerKeys.add(group.ownerKey);
  });
  return section;
}

export function closeBackupCatalogDialog() {
  releaseViewport(); releaseViewport = () => {};
  closeBatchCleanupDialog();
  document.getElementById(CATALOG_DIALOG_ID)?.remove();
}

function renderCatalogSummary(catalog) {
  const summary = document.createElement("section");
  summary.className = "boxed-lllllabc-catalog-summary";
  summary.setAttribute("aria-label", "全部备份摘要");
  summary.append(
    renderMetric("聊天", catalog.chatCount),
    renderMetric("备份记录", catalog.recordCount),
    renderMetric("估算占用", formatStorageSize(catalog.storageBytes)),
    renderMetric("待确认", catalog.pendingChatCount, catalog.pendingChatCount > 0),
  );
  if (catalog.frozenChatCount > 0) {
    const warning = document.createElement("div");
    warning.className = "boxed-lllllabc-catalog-summary-warning";
    warning.textContent = `${catalog.frozenChatCount} 个聊天的完整备份已暂停更新并保留`;
    summary.append(warning);
  }
  return summary;
}

function renderMetric(label, value, warning = false) {
  const metric = document.createElement("div");
  metric.className = "boxed-lllllabc-catalog-metric";
  if (warning) metric.dataset.warning = "true";
  const number = document.createElement("strong");
  number.textContent = String(value);
  const text = document.createElement("span");
  text.textContent = label;
  metric.append(number, text);
  return metric;
}

function renderCatalogEntry(chat) {
  const entry = document.createElement("article");
  entry.className = "boxed-lllllabc-catalog-entry";
  if (chat.pending.count) entry.dataset.pending = "true";
  if (chat.isFrozen) entry.dataset.frozen = "true";
  if (chat.isAwaitingConfirmation) entry.dataset.pending = "true";

  const header = document.createElement("header");
  header.className = "boxed-lllllabc-catalog-entry-header";
  const identity = document.createElement("div");
  identity.className = "boxed-lllllabc-catalog-identity";
  const title = document.createElement("strong");
  title.textContent = chat.displayName;
  const meta = document.createElement("span");
  meta.textContent = [chat.typeLabel, formatDate(chat.lastUpdatedAt)]
    .filter(Boolean)
    .join(" · ");
  identity.append(title, meta);
  const size = document.createElement("span");
  size.className = "boxed-lllllabc-catalog-size";
  size.textContent = formatStorageSize(chat.storageBytes);
  size.title = "序列化后的估算占用";
  header.append(identity, size);

  const inventory = document.createElement("div");
  inventory.className = "boxed-lllllabc-catalog-inventory";
  inventory.append(
    renderInventoryItem("最近", chat.recent),
    renderInventoryItem("完整", chat.full),
    renderInventoryItem("历史", chat.historical),
    renderInventoryItem("未保存", chat.pending, chat.pending.count > 0),
  );
  entry.append(header, inventory);

  if (chat.isFrozen || chat.isAwaitingConfirmation || chat.pending.count) {
    const flags = document.createElement("div");
    flags.className = "boxed-lllllabc-catalog-flags";
    if (chat.isFrozen) flags.append(renderFlag("完整备份已暂停更新并保留", "danger"));
    if (chat.isAwaitingConfirmation) flags.append(renderFlag("完整备份待酒馆确认", "warning"));
    if (chat.pending.count) flags.append(renderFlag(`${chat.pending.count} 条改动等待酒馆保存确认`, "warning"));
    entry.append(flags);
  }
  if (typeof openCleanupHandler === "function") {
    const actions = document.createElement("footer");
    actions.className = "boxed-lllllabc-catalog-entry-actions";
    const cleanup = createTextButton("fa-broom", "管理清理", () => openCleanupHandler(chat));
    cleanup.disabled = chat.recordCount === 0;
    if (cleanup.disabled) cleanup.title = "当前聊天没有可管理的备份记录。";
    actions.append(cleanup);
    entry.append(actions);
  }
  return entry;
}

function renderInventoryItem(label, summary, warning = false) {
  const item = document.createElement("div");
  item.className = "boxed-lllllabc-catalog-inventory-item";
  if (warning) item.dataset.warning = "true";
  const top = document.createElement("span");
  top.textContent = label;
  const count = document.createElement("strong");
  count.textContent = String(summary.count);
  const range = document.createElement("small");
  range.textContent = formatRange(summary);
  item.append(top, count, range);
  return item;
}

function renderFlag(text, tone) {
  const flag = document.createElement("span");
  flag.className = "boxed-lllllabc-catalog-flag";
  flag.dataset.tone = tone;
  flag.textContent = text;
  return flag;
}

function renderState(iconName, titleText, detailText, error = false) {
  const state = document.createElement("section");
  state.className = "boxed-lllllabc-catalog-state";
  if (error) state.dataset.error = "true";
  const icon = document.createElement("i");
  icon.className = `fa-solid ${iconName}`;
  icon.setAttribute("aria-hidden", "true");
  const copy = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = titleText;
  const detail = document.createElement("span");
  detail.textContent = detailText;
  copy.append(title, detail);
  state.append(icon, copy);
  return state;
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
  button.className = "menu_button boxed-lllllabc-action-button boxed-lllllabc-catalog-cleanup";
  const icon = document.createElement("i");
  icon.className = `fa-solid ${iconName}`;
  icon.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.textContent = label;
  button.append(icon, text);
  button.addEventListener("click", onClick);
  return button;
}

function filterChats(chats, query) {
  const normalized = query.toLocaleLowerCase("zh-CN");
  if (!normalized) return chats;
  return chats.filter((chat) => [chat.displayName, chat.ownerName, chat.typeLabel]
    .some((value) => String(value || "").toLocaleLowerCase("zh-CN").includes(normalized)));
}

function formatRange(summary) {
  if (!summary.count) return "无";
  if (!Number.isInteger(summary.firstIndex)) return summary.hasStructural ? "结构变更" : "无楼层";
  const range = summary.firstIndex === summary.lastIndex
    ? `第 ${summary.firstIndex} 层`
    : `第 ${summary.firstIndex}－${summary.lastIndex} 层`;
  return summary.hasStructural ? `${range} + 结构` : range;
}

function formatDate(value) {
  if (!value) return "时间未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString();
}
