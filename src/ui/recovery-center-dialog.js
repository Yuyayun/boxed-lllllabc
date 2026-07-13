import { formatBackupRange, getMessagePreview } from "./presentation.js";

const RECOVERY_DIALOG_ID = "boxed-lllllabc-recovery-center-dialog";

export function buildRecoveryCenterModel({
  chatName,
  pendingPlan,
  pendingCount = 0,
  recentOptions,
  recentMessages = [],
  fullPlan,
  fullMessages = [],
  historicalChanges = [],
  disabledReason = "",
}) {
  return {
    chatName: chatName || "当前聊天",
    disabledReason,
    pending: {
      count: pendingCount,
      available: !disabledReason && Boolean(pendingPlan?.totalCount) && !pendingPlan?.blockedReason,
      reason: disabledReason || pendingPlan?.blockedReason || "当前没有可恢复的未保存变更。",
    },
    recent: {
      count: recentMessages.length,
      range: formatBackupRange(recentMessages) || "当前为空",
      preview: getMessagePreview(recentMessages.at(-1) || {}),
      endIndexes: recentOptions?.endIndexes ?? [],
      lastIndex: recentOptions?.lastIndex ?? null,
      available: !disabledReason && Boolean(recentOptions?.endIndexes?.length),
      reason: disabledReason || `当前聊天没有可从第 ${recentOptions?.startIndex ?? 0} 层开始连续追加的缺失尾层。`,
    },
    full: {
      count: fullMessages.length,
      range: formatBackupRange(fullMessages) || "当前为空",
      preview: getMessagePreview(fullMessages.at(-1) || {}),
      available: !disabledReason && Boolean(fullPlan?.totalCount) && !fullPlan?.blockedReason,
      reason: disabledReason || fullPlan?.blockedReason || "当前没有可恢复的完整聊天备份。",
    },
    historical: historicalChanges.map((record) => ({
      messageIndex: record.messageIndex,
      preview: getMessagePreview(record.message || {}),
      available: !disabledReason,
      reason: disabledReason,
    })),
  };
}

export function openRecoveryCenterDialog({
  state,
  onPreviewPending,
  onPreviewRecent,
  onPreviewFull,
  onPreviewHistorical,
}) {
  closeRecoveryCenterDialog();
  const model = buildRecoveryCenterModel(state);
  const dialog = document.createElement("div");
  dialog.id = RECOVERY_DIALOG_ID;
  dialog.className = "boxed-lllllabc-dialog boxed-lllllabc-recovery-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "boxed-lllllabc-recovery-title");

  const backdrop = document.createElement("div");
  backdrop.className = "boxed-lllllabc-dialog-backdrop";
  backdrop.addEventListener("click", closeRecoveryCenterDialog);

  const frame = document.createElement("div");
  frame.className = "boxed-lllllabc-dialog-frame boxed-lllllabc-recovery-frame";
  const header = document.createElement("header");
  header.className = "boxed-lllllabc-dialog-header";
  const heading = document.createElement("div");
  heading.className = "boxed-lllllabc-recovery-heading";
  const title = document.createElement("strong");
  title.id = "boxed-lllllabc-recovery-title";
  title.textContent = "恢复备份";
  const subtitle = document.createElement("span");
  subtitle.textContent = model.chatName;
  heading.append(title, subtitle);
  const close = createIconButton("fa-xmark", "关闭", closeRecoveryCenterDialog);
  close.classList.add("boxed-lllllabc-dialog-close");
  header.append(heading, close);

  const body = document.createElement("div");
  body.className = "boxed-lllllabc-recovery-body";
  body.append(
    renderSource({
      icon: "fa-shield-halved",
      title: "未保存变更",
      meta: model.pending.count ? `共 ${model.pending.count} 项` : "当前为空",
      available: model.pending.available,
      reason: model.pending.reason,
      onPreview: () => openPreview(onPreviewPending),
    }),
    renderRecentSource(model.recent, onPreviewRecent),
    renderSource({
      icon: "fa-box-archive",
      title: "完整聊天备份",
      meta: `${model.full.range} · 共 ${model.full.count} 层`,
      preview: model.full.preview,
      available: model.full.available,
      reason: model.full.reason,
      onPreview: () => openPreview(onPreviewFull),
    }),
    renderHistoricalSource(model.historical, onPreviewHistorical),
  );

  frame.append(header, body);
  dialog.append(backdrop, frame);
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeRecoveryCenterDialog();
  });
  document.body.append(dialog);
  close.focus();
  return dialog;
}

export function closeRecoveryCenterDialog() {
  document.getElementById(RECOVERY_DIALOG_ID)?.remove();
}

function renderRecentSource(source, onPreviewRecent) {
  const extra = source.available ? document.createElement("label") : null;
  let select = null;
  if (extra) {
    extra.className = "boxed-lllllabc-recovery-select";
    const text = document.createElement("span");
    text.textContent = "恢复到";
    select = document.createElement("select");
    select.setAttribute("aria-label", "选择最近备份恢复终点");
    for (const endIndex of source.endIndexes) {
      const option = document.createElement("option");
      option.value = String(endIndex);
      option.textContent = `第 ${endIndex} 层`;
      select.append(option);
    }
    select.value = String(source.lastIndex);
    extra.append(text, select);
  }
  return renderSource({
    icon: "fa-clock-rotate-left",
    title: "最近楼层备份",
    meta: `${source.range} · 共 ${source.count} 层`,
    preview: source.preview,
    available: source.available,
    reason: source.reason,
    extra,
    onPreview: () => openPreview(() => onPreviewRecent?.(Number(select.value))),
  });
}

function renderHistoricalSource(records, onPreviewHistorical) {
  const section = document.createElement("section");
  section.className = "boxed-lllllabc-recovery-source";
  const header = renderSourceHeader("fa-layer-group", "历史楼层改动备份", records.length ? `共 ${records.length} 层` : "当前为空");
  section.append(header);
  if (!records.length) {
    section.append(renderReason("当前没有历史楼层改动备份。"));
    return section;
  }
  const list = document.createElement("div");
  list.className = "boxed-lllllabc-recovery-history";
  for (const record of records) {
    const row = document.createElement("div");
    row.className = "boxed-lllllabc-recovery-history-row";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `第 ${record.messageIndex} 层`;
    const preview = document.createElement("span");
    preview.textContent = record.preview || "无正文预览";
    copy.append(title, preview);
    const action = createTextButton("fa-magnifying-glass", "预览恢复", () => {
      openPreview(() => onPreviewHistorical?.(record.messageIndex));
    });
    action.disabled = !record.available;
    if (record.reason) action.title = record.reason;
    row.append(copy, action);
    list.append(row);
  }
  section.append(list);
  return section;
}

function renderSource({ icon, title, meta, preview = "", available, reason, extra = null, onPreview }) {
  const section = document.createElement("section");
  section.className = "boxed-lllllabc-recovery-source";
  section.dataset.available = String(Boolean(available));
  section.append(renderSourceHeader(icon, title, meta));
  if (preview) {
    const previewElement = document.createElement("p");
    previewElement.className = "boxed-lllllabc-recovery-preview";
    previewElement.textContent = preview;
    section.append(previewElement);
  }
  if (extra) section.append(extra);
  if (!available) section.append(renderReason(reason));
  const action = createTextButton("fa-magnifying-glass", "预览恢复", onPreview);
  action.disabled = !available;
  if (!available) action.title = reason;
  section.append(action);
  return section;
}

function renderSourceHeader(iconName, titleText, metaText) {
  const header = document.createElement("header");
  header.className = "boxed-lllllabc-recovery-source-header";
  const icon = document.createElement("i");
  icon.className = `fa-solid ${iconName}`;
  icon.setAttribute("aria-hidden", "true");
  const copy = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = titleText;
  const meta = document.createElement("span");
  meta.textContent = metaText;
  copy.append(title, meta);
  header.append(icon, copy);
  return header;
}

function renderReason(text) {
  const reason = document.createElement("div");
  reason.className = "boxed-lllllabc-recovery-reason";
  reason.textContent = text;
  return reason;
}

function openPreview(callback) {
  closeRecoveryCenterDialog();
  return callback?.();
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
