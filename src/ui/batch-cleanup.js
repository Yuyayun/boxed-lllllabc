import { formatStorageSize, groupCatalogChats } from "../backup/catalog.js";

const PREFIX = "boxed-lllllabc-batch";
const TYPES = [["recent", "最近楼层"], ["full", "完整聊天"], ["historical", "历史改动"]];
const RANGES = [["all", "清除全部备份"], ["owner", "清除单角色所有备份"],
  ["owner-selected", "单角色内多选"], ["cross-selected", "跨角色多选"]];
let activeDialog;

export function closeBatchCleanupDialog() { activeDialog?.close(); activeDialog?.remove(); activeDialog = null; }

export function renderBatchCleanupSection({ catalog, onPreview, onExecute }) {
  const section = element("details", { className: `${PREFIX}-section` });
  section.append(element("summary", { textContent: "批量清理" }));
  const form = element("div", { className: `${PREFIX}-form` });
  const range = select(RANGES, "批量清理范围");
  const owner = select([["", "请选择角色或群聊"], ...groupCatalogChats(catalog.chats)
    .map(group => [group.ownerKey, `${group.ownerName}（${group.ownerTypeLabel} · ${group.chatCount} 个聊天）`])], "批量清理所属角色或群聊");
  const selection = new Set();
  const search = element("input", { type: "search", placeholder: "筛选待选聊天", ariaLabel: "筛选批量待选聊天" });
  const list = element("div", { className: `${PREFIX}-choices` });
  const count = element("p", { className: `${PREFIX}-count` });
  count.setAttribute("role", "status");
  const types = element("fieldset");
  types.append(element("legend", { textContent: "要清理的普通备份类型" }));
  const typeInputs = TYPES.map(([value, text]) => {
    const input = element("input", { type: "checkbox", checked: true, value });
    types.append(label(input, text));
    return input;
  });
  const note = element("p", { textContent: "只清理当前活动端的普通备份。未保存变更、冻结或等待确认的完整备份会跳过；聊天快照保留。备份开关不变，后续聊天可能重新生成备份。" });
  const actions = element("div", { className: `${PREFIX}-actions` });
  const preview = button("预览批量清理", () => openPreview({ selection: readSelection(), onPreview, onExecute }));
  const cancel = button("取消多选", () => { section.open = false; range.value = "all"; owner.value = "";
    selection.clear(); search.value = ""; typeInputs.forEach(input => { input.checked = true; }); renderChoices(); });
  actions.append(preview, cancel);
  function readSelection() { return { range: range.value, ownerKey: owner.value, chatKeys: [...selection],
    types: typeInputs.filter(input => input.checked).map(input => input.value) }; }
  function renderChoices() {
    const multi = range.value.endsWith("selected"), needsOwner = range.value.startsWith("owner");
    owner.hidden = !needsOwner; search.hidden = !multi; list.hidden = !multi;
    const candidates = catalog.chats.filter(chat => !needsOwner || chat.ownerKey === owner.value);
    const allowed = new Set(candidates.map(chat => chat.chatKey));
    for (const key of selection) if (!allowed.has(key)) selection.delete(key);
    list.replaceChildren();
    const query = search.value.trim().toLocaleLowerCase();
    const visible = candidates.filter(chat => `${chat.ownerName} ${chat.displayName}`.toLocaleLowerCase().includes(query));
    if (multi) for (const chat of visible) {
      const input = element("input", { type: "checkbox", checked: selection.has(chat.chatKey), value: chat.chatKey });
      input.addEventListener("change", () => { input.checked ? selection.add(chat.chatKey) : selection.delete(chat.chatKey); updateCount(); });
      list.append(label(input, `${chat.ownerName} · ${chat.displayName}（${chat.recordCount} 条）`));
    }
    if (multi && !visible.length) list.append(element("p", { textContent: "没有匹配的待选聊天。" }));
    updateCount();
    function updateCount() { count.textContent = multi
      ? `已选择 ${selection.size} 个聊天 · 显示 ${visible.length} / ${candidates.length} 个（筛选不会取消已选聊天）`
      : `当前范围 ${candidates.length} 个聊天（不受上方目录搜索影响）`; }
  }
  range.addEventListener("change", () => { selection.clear(); search.value = ""; renderChoices(); });
  owner.addEventListener("change", () => { selection.clear(); renderChoices(); });
  search.addEventListener("input", renderChoices);
  form.append(range, owner, search, list, count, types, note, actions);
  section.append(form); renderChoices();
  return section;
}

async function openPreview({ selection, onPreview, onExecute }) {
  closeBatchCleanupDialog();
  const dialog = element("dialog", { className: `${PREFIX}-dialog`, ariaLabel: "批量清理预览" });
  activeDialog = dialog;
  const heading = element("h3", { textContent: "批量清理预览" });
  const body = element("div", { className: `${PREFIX}-body` });
  const actions = element("footer", { className: `${PREFIX}-actions` });
  const close = button("取消", closeBatchCleanupDialog);
  const reload = button("重新预览", load);
  const confirm = button("确认清理", execute);
  const consent = element("input", { type: "checkbox" });
  const consentLabel = label(consent, "我已核对范围，确认删除以上可清理的普通备份。此操作不可撤销。");
  let busy = false, plan;
  dialog.addEventListener("cancel", event => { event.preventDefault(); if (!busy) closeBatchCleanupDialog(); });
  dialog.addEventListener("keydown", event => {
    event.stopPropagation();
    if (busy && event.key === "Tab") { event.preventDefault(); body.focus(); }
  });
  dialog.addEventListener("keyup", event => event.stopPropagation());
  consent.addEventListener("change", () => { confirm.disabled = busy || !plan?.canConfirm || !consent.checked; });
  actions.append(close, reload, confirm); dialog.append(heading, body, consentLabel, actions);
  document.body.append(dialog); dialog.showModal(); close.focus();
  await load();
  async function load() {
    if (busy) return;
    heading.textContent = "批量清理预览";
    plan = null; consent.checked = false; confirm.disabled = true; reload.disabled = true;
    consentLabel.hidden = true; body.replaceChildren(element("p", { textContent: "正在读取活动存储并核对保护规则…" }));
    try {
      const fresh = await onPreview(selection);
      if (!dialog.isConnected) return;
      plan = fresh;
      body.replaceChildren(element("p", { textContent: `活动端：${plan.mode === "sqlite" ? "SQLite" : "IndexedDB"} · ${plan.chatCount} 个聊天 · 预计删除 ${plan.recordCount} 条 · 估算 ${formatStorageSize(plan.storageBytes)}` }),
        element("p", { textContent: `保护跳过 ${plan.skipped.length} 项、${plan.protectedRecords} 条。项按“聊天 × 备份类型”统计。` }));
      const entries = element("ul");
      for (const item of plan.actions) entries.append(element("li", { textContent: `清理：${item.ownerName} · ${item.chatName} · ${item.typeLabel} ${item.count} 条` }));
      for (const item of plan.skipped) entries.append(element("li", { textContent: `跳过：${item.ownerName} · ${item.chatName} · ${item.typeLabel} ${item.count} 条 — ${item.blockedReason}` }));
      body.append(entries);
      if (plan.blockedReason) body.append(element("p", { textContent: plan.blockedReason }));
      consentLabel.hidden = !plan.canConfirm;
    } catch (error) {
      if (dialog.isConnected) body.replaceChildren(element("p", { textContent: error.message || String(error) }));
    } finally { if (dialog.isConnected) reload.disabled = false; }
  }
  async function execute() {
    if (busy || !plan?.canConfirm || !consent.checked) return;
    busy = true; confirm.disabled = close.disabled = reload.disabled = consent.disabled = true;
    dialog.setAttribute("aria-busy", "true"); body.tabIndex = -1; body.focus();
    heading.textContent = "正在清理，请等待结果";
    let result;
    try { result = await onExecute(plan, { confirmed: true }); }
    catch (error) { result = { ok: false, unknown: true, reason: error.message }; }
    if (!dialog.isConnected) return;
    busy = false; close.disabled = reload.disabled = consent.disabled = false;
    dialog.removeAttribute("aria-busy");
    consent.checked = false; consentLabel.hidden = true; confirm.disabled = true; plan = null;
    heading.textContent = result.unknown ? "清理结果未确认" : result.ok ? "批量清理完成" : "批量清理未完成";
    const display = value => value == null ? "未确认" : String(value);
    body.replaceChildren(element("p", { textContent: `成功 ${display(result.succeeded)} 项 · 跳过 ${display(result.skipped)} 项 · 失败 ${display(result.failed)} 项` }));
    if (result.ok) body.append(element("p", { textContent: `已删除 ${result.deletedRecords} 条普通备份记录。` }));
    if (result.reason || result.refreshWarning) body.append(element("p", { textContent: result.reason || result.refreshWarning }));
    const entries = element("ul");
    for (const item of result.items ?? []) entries.append(element("li", { textContent: `${item.status === "deleted" ? "已清理" : "跳过"}：${item.chatName} · ${item.typeLabel} ${item.count} 条${item.reason ? ` — ${item.reason}` : ""}` }));
    body.append(entries); close.textContent = "关闭"; close.focus();
  }
}

function element(tag, properties = {}) { const node = document.createElement(tag); Object.assign(node, properties); return node; }
function label(input, text) { const node = element("label"); node.append(input, element("span", { textContent: text })); return node; }
function button(text, handler) { const node = element("button", { type: "button", className: "menu_button", textContent: text }); node.addEventListener("click", handler); return node; }
function select(options, ariaLabel) { const node = element("select", { ariaLabel });
  for (const [value, textContent] of options) node.append(element("option", { value, textContent })); return node; }
