import { buildVisibleChatSummary, formatCandidateSummary } from "./presentation.js";

export function createSnapshotUi({ controller, onChanged = async () => {} }) {
  let dialog, body, actions, busy = false, view = 0;
  const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const chatName = meta => buildVisibleChatSummary(meta ?? {}).map(row => row.value).filter(value => value && value !== "当前聊天").join(" · ") || "当前聊天";
  function close() { if (busy) return; view++; dialog?.close(); dialog?.remove(); dialog = null; }
  function frame(title) {
    close(); dialog = element("dialog", undefined, "boxed-lllllabc-snapshot-dialog");
    const heading = element("strong", title); heading.id = "boxed-lllllabc-snapshot-title";
    dialog.setAttribute("aria-labelledby", heading.id);
    body = element("div", undefined, "boxed-lllllabc-snapshot-body");
    actions = element("footer"); dialog.append(heading, body, actions);
    dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
    dialog.addEventListener("keydown", event => {
      event.stopPropagation();
      if (busy && event.key === "Tab") { event.preventDefault(); dialog.querySelector("[data-snapshot-status]")?.focus(); }
    });
    dialog.addEventListener("keyup", event => event.stopPropagation());
    document.body.append(dialog); dialog.showModal(); return dialog;
  }
  function button(label, callback, parent = actions) {
    const node = element("button", label, "menu_button boxed-lllllabc-action-button"); node.type = "button";
    node.addEventListener("click", () => { if (node.isConnected && dialog?.open) Promise.resolve().then(callback).catch(error => message(error.message)); });
    parent.append(node); return node;
  }
  function message(text) {
    let status = dialog?.querySelector("[data-snapshot-status]");
    if (!status && body) { status = element("p"); status.dataset.snapshotStatus = ""; status.setAttribute("role", "status"); body.append(status); }
    if (status) status.textContent = text;
  }
  async function perform(callback, isSuccess, failureReason) {
    if (busy) return;
    busy = true;
    const controls = [...dialog.querySelectorAll("button,input")];
    const previousFocus = document.activeElement;
    const disabled = controls.map(node => node.disabled); controls.forEach(node => { node.disabled = true; });
    dialog.setAttribute("aria-busy", "true"); message("正在处理，请勿关闭页面。聊天快照不会自动改写已有存档。");
    const progress = dialog.querySelector("[data-snapshot-status]"); progress.tabIndex = 0; progress.focus();
    let succeeded = false;
    try {
      const result = await callback();
      await onChanged();
      succeeded = isSuccess(result);
      if (!succeeded) message(result?.reason || failureReason);
    }
    finally { busy = false; controls.forEach((node, index) => { node.disabled = disabled[index]; }); dialog?.removeAttribute("aria-busy"); progress.tabIndex = -1; if (previousFocus?.isConnected) previousFocus.focus(); }
    if (succeeded) close();
  }
  function create() {
    frame("创建聊天快照");
    body.append(element("p", "保存当前聊天的完整内容、所有候选回复及聊天元数据。不会新建酒馆聊天，也不会开启自动快照。"));
    const label = element("label", "快照名称"), input = element("input"); input.type = "text"; input.maxLength = 200; input.value = new Date().toLocaleString(); label.append(input); body.append(label);
    button("取消", close);
    button("确认创建", () => perform(() => controller.create({ name: input.value.trim() || undefined }), result => result?.ok === true, "聊天快照尚未确认保存并完成校验，请检查后重试。"));
    input.focus(); input.select();
  }
  async function manage() {
    frame("管理聊天快照");
    const expectedView = view;
    const list = element("div", undefined, "boxed-lllllabc-snapshot-list"); body.append(list);
    let after = "";
    const load = async () => {
      more.disabled = true;
      try {
        const result = await controller.list({ after }); after = result.after;
        if (view !== expectedView || !dialog?.open) return;
        for (const item of result.items) {
          const card = element("article"); card.append(element("strong", item.name), element("p", `${chatName(item.meta)} · ${new Date(item.createdAt).toLocaleString()} · ${item.messageCount} 层`));
          if (item.state !== "ready") card.append(element("p", `创建未完成（${item.written} / ${item.messageCount} 层），不可恢复；可单独删除此未完成存档。`));
          const controls = element("div", undefined, "boxed-lllllabc-snapshot-controls"); card.append(controls);
          button("预览 / 恢复", () => preview(item.id), controls).disabled = item.state !== "ready";
          button("重命名", () => rename(item), controls).disabled = item.state !== "ready"; button("删除", () => remove(item), controls);
          list.append(card);
        }
        if (!list.childElementCount) message("尚无已完成的聊天快照，可先打开聊天创建。");
      } finally { more.disabled = !after; }
    };
    button("创建聊天快照", create); const more = button("继续加载", load); button("关闭", close);
    await load();
  }
  async function preview(id) {
    frame("预览聊天快照"); message("正在读取并校验完整快照……");
    const expectedView = view;
    const result = await controller.preview(id);
    if (view !== expectedView || !dialog?.open) return;
    body.replaceChildren(element("strong", result.snapshot.header.name), element("p", `${chatName(result.meta)} · ${new Date(result.snapshot.header.createdAt).toLocaleString()} · ${result.snapshot.chat.length} 层`));
    const list = element("div", undefined, "boxed-lllllabc-snapshot-preview"); body.append(list);
    let shown = 0;
    const showMore = () => {
      for (const raw of result.snapshot.chat.slice(shown, shown + 30)) {
        const item = element("details"), summary = element("summary", `第 ${shown++} 层 · ${raw.name || (raw.is_user ? "用户" : "角色")} · ${formatCandidateSummary({ raw, swipes: raw.swipes, swipeIndex: raw.swipe_id })}`);
        item.append(summary, element("pre", String(raw.mes ?? "")));
        if (Array.isArray(raw.swipes)) raw.swipes.forEach((swipe, index) => item.append(element("pre", `候选 ${index + 1}${index === raw.swipe_id ? "（当前）" : ""}\n${typeof swipe === "string" ? swipe : JSON.stringify(swipe)}`)));
        list.append(item);
      }
      more.disabled = shown >= result.snapshot.chat.length;
    };
    const metadata = element("details"), heading = element("summary", "聊天元数据"); metadata.append(heading, element("pre", JSON.stringify(result.snapshot.header.metadata, null, 2))); body.append(metadata);
    if (result.reason) body.append(element("p", result.reason));
    const more = button("继续预览楼层", showMore); showMore();
    const restore = button("恢复到当前聊天", () => confirmRestore(result)); restore.disabled = !result.restore;
    button("返回管理", manage); button("关闭", close);
  }
  function confirmRestore(result) {
    frame("确认恢复聊天快照");
    body.append(element("p", `来源快照：${result.snapshot.header.name}`), element("p", `当前聊天：${chatName(result.meta)}。将覆盖当前聊天的完整内容和可恢复元数据，共 ${result.snapshot.chat.length} 层；当前未保存改动将被替换，原生聊天身份保持不变。源快照仍然保留。`));
    const label = element("label"), check = element("input"); check.type = "checkbox"; label.append(check, element("span", "我确认覆盖当前聊天内容。")); body.append(label);
    button("取消", () => preview(result.snapshot.header.id));
    const submit = button("确认覆盖并恢复", () => perform(() => controller.restore(result.restore, { confirmed: true }), restored => restored?.ok === true && restored.confirmed === true, "本次恢复未完成或酒馆保存尚未确认。")); submit.disabled = true; check.addEventListener("change", () => { submit.disabled = !check.checked; });
  }
  function rename(item) {
    frame("重命名聊天快照"); body.append(element("p", "只修改名称，存档正文、创建时间与内容摘要保持不变。"));
    const label = element("label", "快照名称"), input = element("input"); input.type = "text"; input.maxLength = 200; input.value = item.name; label.append(input); body.append(label);
    button("取消", manage); button("保存名称", () => perform(() => controller.rename({ id: item.id, name: input.value, expectedName: item.name }), result => result?.id === item.id && result.name === input.value.trim(), "快照名称尚未确认保存，请刷新后检查。")); input.focus(); input.select();
  }
  function remove(item) {
    frame("删除聊天快照"); body.append(element("p", `将永久删除快照「${item.name}」（${item.messageCount} 层）。此操作不清理普通备份，也不修改酒馆聊天。`));
    button("取消", manage); button("确认删除此快照", () => perform(() => controller.delete({ id: item.id, expectedHash: item.contentHash, confirmed: true }), result => result?.deleted === true, "本次未确认删除快照，请刷新后检查。"));
  }
  function bind() { document.querySelector("#boxed-lllllabc-manage-snapshots")?.addEventListener("click", () => manage().catch(error => message(error.message))); }
  return { bind, create, manage, preview };
}
