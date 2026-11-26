import { DB_NAME } from '../db/schema.js';

const ID = 'boxed-lllllabc-local-recovery-dialog';
const labels = { chat_meta: '聊天信息', recent_messages: '最近楼层', full_messages: '完整备份', historical_changes: '历史变更', pending_changes: '未保存变更', snapshots: '快照信息', snapshot_messages: '快照正文', __boxed_transfer_meta: '存储任务信息', __boxed_transfer_rows: '暂存记录' };
const category = name => `${name?.startsWith('__boxed_next_') ? '数据区 B · ' : ''}${labels[name?.replace(/^__boxed_next_/, '')] ?? '其他原始记录'}`;
const element = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };

export function createLocalRecoveryUi({ coordinator, getChatKey = () => undefined, onRecovered = async () => {}, getMode = () => 'indexeddb' } = {}) {
  let dialog, message, actions, running = false, abort, downloadUrl, lastError;
  function releaseUrl() { if (downloadUrl) URL.revokeObjectURL(downloadUrl); downloadUrl = undefined; }
  function close() {
    abort?.abort(); releaseUrl(); dialog?.close(); dialog?.remove(); dialog = null;
    document.querySelector('#boxed-lllllabc-open-local-recovery')?.focus();
  }
  function button(text, run) {
    const node = element('button', text, 'menu_button boxed-lllllabc-action-button'); node.type = 'button';
    node.addEventListener('click', () => { Promise.resolve().then(run).catch(showError); }); actions.append(node); return node;
  }
  function frame(title) {
    if (dialog) { dialog.close(); dialog.remove(); }
    dialog = element('dialog'); dialog.id = ID;
    const heading = element('strong', title); heading.id = `${ID}-title`;
    dialog.setAttribute('aria-labelledby', heading.id);
    message = element('p'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    actions = element('div', undefined, 'boxed-lllllabc-transfer-actions');
    dialog.append(heading, message, actions); document.body.append(dialog); dialog.showModal();
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('keyup', event => event.stopPropagation());
  }
  function download(value, suffix) {
    releaseUrl(); downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' }));
    const link = element('a'); link.href = downloadUrl; link.download = `boxed-local-rescue-${value.exportId}-${suffix}.json`;
    document.body.append(link); link.click(); link.remove();
  }
  function showError(error) {
    if (!dialog) return;
    running = false;
    message.textContent = `本次处理未完成：${error?.message || String(error)}`;
    actions.replaceChildren(); button('返回故障处理', open); button('关闭', close);
  }
  async function retry() {
    if (running) return;
    running = true; actions.replaceChildren(); message.textContent = '正在重新检查本地备份，尚未恢复自动写入。';
    try {
      const state = await coordinator.retry(getChatKey());
      if (state.writePaused) throw new Error('仍有备份写入结果无法确认。可先救援可读数据，或明确放弃旧备份后重建。');
      lastError = undefined;
      const notice = document.querySelector('#boxed-lllllabc-local-recovery'); if (notice) notice.hidden = true;
      await onRecovered(); close();
    } finally { running = false; }
  }
  async function rescue() {
    if (running) return;
    running = true; abort = new AbortController(); actions.replaceChildren();
    message.textContent = '正在尝试读取旧本地备份；不会修改原库。'; button('取消救援', () => abort.abort());
    try {
      const manifest = await coordinator.rescue({ signal: abort.signal, onVolume: volume => new Promise((resolve, reject) => {
        const signal = abort.signal;
        const cancel = () => reject(new DOMException('已取消救援。', 'AbortError'));
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) { cancel(); return; }
        actions.replaceChildren(); message.textContent = `第 ${volume.volume} 卷已准备好，共 ${volume.records.length} 条原始记录。文件含私密聊天内容，请自行保管。下载后继续读取下一部分。`;
        button(`下载第 ${volume.volume} 卷并继续`, () => {
          download(volume, `part-${volume.volume}`); signal.removeEventListener('abort', cancel);
          actions.replaceChildren(); button('取消救援', () => abort.abort()); resolve();
        });
        button('取消救援', () => abort.abort());
      }) });
      if (!dialog) return;
      actions.replaceChildren();
      message.textContent = `${manifest.cancelled ? '救援已取消。' : manifest.status === 'scanned' ? '原始记录扫描结束。' : '部分记录未能读取或核验。'}已提供 ${manifest.volumes.length} 卷、${manifest.exportedRecords} 条原始记录的下载。原库未改动；这些文件不代表完整可恢复备份，不能直接作为迁移包导入。${manifest.error ? ` ${manifest.error.message}` : ''}`;
      if (manifest.volumes.length) button('下载救援清单', () => download(manifest, 'manifest'));
      button('返回故障处理', open); button('关闭', close);
    } finally { running = false; abort = undefined; }
  }
  function confirmRebuild() {
    if (running || coordinator.state().busy) return;
    frame('清除旧本地备份并重建');
    message.textContent = `将永久删除当前站点 ${location.origin} 下的箱装备份库 ${DB_NAME}，包括所有聊天的普通备份、未保存变更、历史副本、快照和暂存记录，也可能包含曾用其他账号的本地备份。酒馆服务器上的原始聊天、角色卡和扩展设置不受影响。旧库独有的内容不能找回。`;
    const label = element('label'), check = element('input'); check.type = 'checkbox';
    label.append(check, element('span', '我接受丢失这些旧本地备份，并重建空库')); dialog.insertBefore(label, actions);
    const confirm = button('删除旧备份并重建', async () => {
      if (!check.checked || running) return;
      running = true; actions.replaceChildren(); label.remove();
      button('暂时关闭提示', close);
      try {
        await coordinator.rebuild({ confirmed: true, databaseName: DB_NAME, confirmedOrigin: location.origin });
        lastError = undefined;
        const notice = document.querySelector('#boxed-lllllabc-local-recovery'); if (notice) notice.hidden = true;
        await onRecovered();
        if (dialog) {
          message.textContent = '旧本地备份已删除，新备份库已建立并核验。后续按原设置备份当前可读取的聊天；过去的历史副本和快照没有恢复。请查看当前聊天的首轮备份结果。';
          actions.replaceChildren(); button('关闭', close);
        }
      } finally { running = false; }
    });
    confirm.disabled = true; check.addEventListener('change', () => { confirm.disabled = !check.checked; });
    button('取消', open);
  }
  function open() {
    if (getMode() === 'sqlite') return;
    frame('处理本地备份故障');
    if (running || coordinator.state().busy) {
      message.textContent = '本地备份处理仍在进行。若正在等待其他页签关闭，请关闭其他酒馆页签；提交删除后不能撤销，关闭提示不会取消已提交的删除。'; button('暂时关闭提示', close); return;
    }
    message.textContent = `${lastError?.message || '本地备份暂不可用。'} 可先重新检查，或尝试只读救援。也可以在明确放弃旧本地备份后重建；不会自动删库。`;
    button('重新检查', retry); button('尝试救援本地备份', rescue); button('清除旧本地备份并重建', confirmRebuild); button('稍后处理', close);
  }
  return {
    bind() { document.querySelector('#boxed-lllllabc-open-local-recovery')?.addEventListener('click', open); },
    showFault(error) {
      if (getMode() === 'sqlite' || error?.code === 'backup-client-upgrade-required') return;
      lastError = error;
      const notice = document.querySelector('#boxed-lllllabc-local-recovery'); if (notice) notice.hidden = false;
    },
    progress(value) {
      if (!dialog || !message) return;
      const descriptions = { deleting: '正在删除旧本地备份。提交后不能撤销，请等待结果。', blocked: '其他酒馆页签仍占用旧备份，请关闭其他页签。删除尚未完成，不会提前新建或重复删除。', creating: '旧库已删除，正在建立并核验新的本地备份库。', rebuilt: '新本地备份库已建立，正在重新检查当前聊天。' };
      message.textContent = value.phase === 'reading' ? `正在读取${category(value.store)}，已读取 ${value.count} 条。原库不会改动。` : descriptions[value.phase] ?? '正在处理本地备份。';
    },
    open, close,
  };
}
