import {
  buildVisibleChatSummary,
  formatBackupRange,
  formatCandidateSummary,
  getMessagePreview,
} from "./presentation.js";
import { renderBackupManagement, renderPrimaryActions } from "./current-chat-actions.js";

export function renderCurrentChatPanel(container, {
  status,
  meta,
  messages,
  fullMessages = [],
  historicalChanges = [],
  pending = [],
  settings = {},
  restore = {},
  management = {},
  onVerify,
}) {
  const recentExpanded = container.dataset.recentExpanded === "true";
  container.replaceChildren();

  const summary = document.createElement("div");
  summary.className = "boxed-lllllabc-panel-summary";
  summary.append(
    renderLine("后端状态", status.shortText),
    renderLine("上次核对", formatDate(status.updatedAt)),
  );

  for (const row of buildVisibleChatSummary(meta)) {
    summary.append(renderLine(row.label, row.value));
  }

  container.append(summary);
  container.append(renderPrimaryActions({ restore, onVerify }));
  container.append(renderRecentSection(messages, settings, {
    expanded: recentExpanded,
    onToggle(expanded) {
      container.dataset.recentExpanded = String(expanded);
    },
  }, restore));
  container.append(renderFullSection(fullMessages, meta, settings, restore));
  const historicalSection = renderHistoricalSection(historicalChanges, restore);
  if (historicalSection) {
    container.append(historicalSection);
  }
  container.append(renderPendingSection(pending, restore));
  container.append(renderBackupManagement(management));

}

function renderFullSection(messages, meta = {}, settings = {}, restore = {}) {
  const section = document.createElement("section");
  section.className = "boxed-lllllabc-panel-section";
  const title = document.createElement("div");
  title.className = "boxed-lllllabc-panel-title";
  title.textContent = "完整聊天备份";
  section.append(title);

  if (!messages.length) {
    section.append(renderEmpty(settings.fullBackupEnabled ? "还没有完整聊天备份" : "完整聊天备份未启用"));
    return section;
  }

  const file = document.createElement("article");
  file.className = "boxed-lllllabc-pending-file";
  const main = document.createElement("span");
  main.className = "boxed-lllllabc-recent-file-main";
  const heading = document.createElement("span");
  heading.className = "boxed-lllllabc-recent-file-title";
  heading.textContent = meta.chatDisplayName || meta.chatFile || meta.chatId || "当前聊天";
  const detail = document.createElement("span");
  detail.className = "boxed-lllllabc-recent-file-meta";
  detail.textContent = formatFullBackupDetail(messages, meta, settings);
  const preview = document.createElement("span");
  preview.className = "boxed-lllllabc-recent-file-preview";
  preview.textContent = getMessagePreview(messages.at(-1));
  main.append(heading, detail, preview);
  file.append(main);
  if (restore.fullPlan?.totalCount && typeof restore.onPreviewFull === "function") {
    const action = document.createElement("button");
    action.type = "button";
    action.className = "menu_button boxed-lllllabc-action-button boxed-lllllabc-full-restore";
    const icon = document.createElement("i");
    icon.className = "fa-solid fa-rotate-left";
    icon.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = "预览整聊恢复";
    action.append(icon, label);
    action.addEventListener("click", () => restore.onPreviewFull());
    file.append(action);
  }
  section.append(file);
  return section;
}

function formatFullBackupDetail(messages, meta, settings) {
  if (!settings.enabled || !settings.fullBackupEnabled) {
    return `已暂停更新 · ${formatBackupRange(messages)}`;
  }
  if (meta.fullBackupState === "frozen") {
    return meta.fullBackupIncident?.acknowledgedAt
      ? "已查看，完整备份仍保留，更新已暂停"
      : "聊天疑似异常缩短，完整备份已保留";
  }
  return `完整聊天 · ${formatBackupRange(messages)} · 更新于 ${formatDate(meta.fullBackupAt)}`;
}

function renderHistoricalSection(records, restore = {}) {
  if (!records.length) {
    return null;
  }

  const section = document.createElement("section");
  section.className = "boxed-lllllabc-panel-section";
  const title = document.createElement("div");
  title.className = "boxed-lllllabc-panel-title";
  title.textContent = "历史楼层改动备份";
  section.append(title);

  const list = document.createElement("div");
  list.className = "boxed-lllllabc-pending-list";
  for (const record of records) {
    const file = document.createElement("article");
    file.className = "boxed-lllllabc-pending-file";

    const main = document.createElement("span");
    main.className = "boxed-lllllabc-recent-file-main";
    const heading = document.createElement("span");
    heading.className = "boxed-lllllabc-recent-file-title";
    heading.textContent = `第 ${record.messageIndex} 层 · ${renderPendingKind(record.lastKind)}`;
    const detail = document.createElement("span");
    detail.className = "boxed-lllllabc-recent-file-meta";
    detail.textContent = `保存于 ${formatDate(record.updatedAt)}`;
    const preview = document.createElement("span");
    preview.className = "boxed-lllllabc-recent-file-preview";
    preview.textContent = getMessagePreview(record.message || {});

    main.append(heading, detail, preview);
    file.append(main);
    if (typeof restore.onPreviewHistorical === "function") {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "menu_button boxed-lllllabc-action-button boxed-lllllabc-historical-restore";
      const icon = document.createElement("i");
      icon.className = "fa-solid fa-clock-rotate-left";
      icon.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = "预览恢复";
      action.append(icon, label);
      action.addEventListener("click", () => restore.onPreviewHistorical(record.messageIndex));
      file.append(action);
    }
    list.append(file);
  }

  section.append(list);
  return section;
}

function renderRecentSection(messages, settings, disclosure, restore) {
  const section = document.createElement("section");
  section.className = "boxed-lllllabc-panel-section";

  const title = document.createElement("div");
  title.className = "boxed-lllllabc-panel-title";
  title.textContent = "最近楼层备份";
  section.append(title);

  if (!settings.recentBackupEnabled) {
    section.append(renderEmpty("最近楼层备份未启用"));
    return section;
  }

  if (!messages.length) {
    section.append(renderEmpty("还没有最近楼层备份"));
    return section;
  }

  section.append(renderRecentFile(messages, disclosure, restore));
  return section;
}

function renderRecentFile(messages, { expanded, onToggle }, restore) {
  const wrapper = document.createElement("div");
  wrapper.className = "boxed-lllllabc-recent-file-wrap";

  const detailsId = `boxed-lllllabc-recent-details-${Math.random().toString(36).slice(2)}`;
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "boxed-lllllabc-recent-file";
  trigger.setAttribute("aria-expanded", String(expanded));
  trigger.setAttribute("aria-controls", detailsId);

  const main = document.createElement("span");
  main.className = "boxed-lllllabc-recent-file-main";

  const heading = document.createElement("span");
  heading.className = "boxed-lllllabc-recent-file-title";
  heading.textContent = formatBackupRange(messages);

  const meta = document.createElement("span");
  meta.className = "boxed-lllllabc-recent-file-meta";
  meta.textContent = `共 ${messages.length} 层 · 更新于 ${formatDate(messages.at(-1)?.backedUpAt)}`;

  const preview = document.createElement("span");
  preview.className = "boxed-lllllabc-recent-file-preview";
  preview.textContent = getMessagePreview(messages.at(-1));

  const chevron = document.createElement("i");
  chevron.className = "fa-solid fa-chevron-down boxed-lllllabc-recent-file-chevron";
  chevron.setAttribute("aria-hidden", "true");

  main.append(heading, meta, preview);
  trigger.append(main, chevron);

  const details = document.createElement("div");
  details.id = detailsId;
  details.className = "boxed-lllllabc-recent-details";
  details.hidden = !expanded;
  for (const message of messages) {
    details.append(renderMessageDetail(message));
  }
  if (restore.recentOptions?.endIndexes?.length && typeof restore.onPreviewRecent === "function") {
    details.append(renderRecentRestoreControls(restore.recentOptions, restore.onPreviewRecent));
  }

  trigger.addEventListener("click", () => {
    const nextExpanded = trigger.getAttribute("aria-expanded") !== "true";
    trigger.setAttribute("aria-expanded", String(nextExpanded));
    details.hidden = !nextExpanded;
    onToggle(nextExpanded);
  });

  wrapper.append(trigger, details);
  return wrapper;
}

function renderPendingSection(records, restore) {
  const section = document.createElement("section");
  section.className = "boxed-lllllabc-panel-section";

  const title = document.createElement("div");
  title.className = "boxed-lllllabc-panel-title";
  title.textContent = "未保存变更";
  section.append(title);

  if (!records.length) {
    section.append(renderEmpty("当前为空"));
    return section;
  }

  const list = document.createElement("div");
  list.className = "boxed-lllllabc-pending-list";
  for (const record of records) {
    list.append(renderPendingPreview(record));
  }
  section.append(list);

  const plan = restore.pendingPlan;
  if (plan?.blockedReason) {
    const blocked = renderEmpty(plan.blockedReason);
    blocked.classList.add("boxed-lllllabc-restore-blocked");
    section.append(blocked);
  } else if (plan?.totalCount && typeof restore.onPreviewPending === "function") {
    section.append(renderRestoreAction({
      icon: "fa-clock-rotate-left",
      label: "预览全量恢复",
      onClick: restore.onPreviewPending,
    }));
  }

  return section;
}

function renderRecentRestoreControls(options, onPreview) {
  const controls = document.createElement("div");
  controls.className = "boxed-lllllabc-restore-controls";

  const label = document.createElement("label");
  label.className = "boxed-lllllabc-restore-select-label";
  const text = document.createElement("span");
  text.textContent = "恢复到";
  const select = document.createElement("select");
  select.setAttribute("aria-label", "选择连续恢复终点");
  for (const endIndex of options.endIndexes) {
    const option = document.createElement("option");
    option.value = String(endIndex);
    option.textContent = `第 ${endIndex} 层`;
    select.append(option);
  }
  select.value = String(options.lastIndex);
  label.append(text, select);

  const action = renderRestoreAction({
    icon: "fa-magnifying-glass",
    label: "预览恢复",
    onClick: () => onPreview(Number(select.value)),
  });
  controls.append(label, action);
  return controls;
}

function renderRestoreAction({ icon, label, onClick }) {
  const actions = document.createElement("div");
  actions.className = "boxed-lllllabc-actions boxed-lllllabc-restore-actions";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "menu_button boxed-lllllabc-action-button";
  const iconElement = document.createElement("i");
  iconElement.className = `fa-solid ${icon}`;
  iconElement.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.textContent = label;
  button.append(iconElement, text);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await onClick();
    } finally {
      if (button.isConnected) {
        button.disabled = false;
      }
    }
  });
  actions.append(button);
  return actions;
}

function renderLine(label, value) {
  const line = document.createElement("div");
  line.className = "boxed-lllllabc-panel-row";

  const term = document.createElement("span");
  term.className = "boxed-lllllabc-panel-label";
  term.textContent = label;

  const description = document.createElement("span");
  description.className = "boxed-lllllabc-panel-value";
  description.textContent = value || "暂无";

  line.append(term, description);
  return line;
}

function renderMessageDetail(message) {
  const detail = document.createElement("article");
  detail.className = "boxed-lllllabc-message-detail";

  const heading = document.createElement("strong");
  heading.textContent = `第 ${message.messageIndex} 层 · ${message.name || renderRole(message.role)}`;

  const candidateSummary = document.createElement("div");
  candidateSummary.className = "boxed-lllllabc-muted";
  candidateSummary.textContent = formatCandidateSummary(message);

  const text = document.createElement("p");
  text.textContent = getMessagePreview(message);

  detail.append(heading, candidateSummary, text);
  return detail;
}

function renderPendingPreview(record) {
  const preview = document.createElement("article");
  preview.className = "boxed-lllllabc-pending-file";

  const main = document.createElement("span");
  main.className = "boxed-lllllabc-recent-file-main";

  const title = document.createElement("span");
  title.className = "boxed-lllllabc-recent-file-title";
  title.textContent = Number.isInteger(record.messageIndex)
    ? `第 ${record.messageIndex} 层 · ${renderPendingKind(record.kind)}`
    : `聊天结构变化 · ${renderPendingKind(record.kind)}`;

  const detail = document.createElement("span");
  detail.className = "boxed-lllllabc-recent-file-meta";
  detail.textContent = `等待后端确认 · 更新于 ${formatDate(record.updatedAt)}`;

  const text = document.createElement("span");
  text.className = "boxed-lllllabc-recent-file-preview";
  text.textContent = Number.isInteger(record.messageIndex)
    ? getMessagePreview(record.message || {})
    : `已记录当前 ${record.chatLength ?? "全部"} 层的聊天结构`;

  main.append(title, detail, text);
  preview.append(main);
  return preview;
}

function renderEmpty(text) {
  const empty = document.createElement("div");
  empty.className = "boxed-lllllabc-muted boxed-lllllabc-empty";
  empty.textContent = text;
  return empty;
}

function renderRole(role) {
  if (role === "user") {
    return "用户";
  }

  if (role === "system") {
    return "系统";
  }

  return "角色";
}

function renderPendingKind(kind) {
  switch (kind) {
    case "new_message":
      return "新消息";
    case "message_edit":
      return "消息编辑";
    case "swipe_change":
      return "候选回复变更";
    case "message_delete":
      return "消息删除";
    case "restore":
      return "备份恢复";
    default:
      return "结构变化";
  }
}

function formatDate(value) {
  if (!value) {
    return "暂无";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "暂无";
  }

  return date.toLocaleString();
}
