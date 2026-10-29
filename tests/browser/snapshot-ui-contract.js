import { createSnapshotUi } from '../../src/ui/snapshots.js';

// Run in a browser: exercise the shared completion path without changing the
// controller's data, verification or native-save implementation.
export async function runSnapshotUiContract() {
  const checks = [];
  const assert = (value, reason) => { if (!value) throw new Error(reason); };
  const wait = async predicate => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('快照界面未达到预期状态');
  };
  const currentDialog = () => document.querySelector('.boxed-lllllabc-snapshot-dialog[open]');
  const click = label => {
    const button = [...currentDialog().querySelectorAll('button')].find(node => node.textContent === label);
    assert(button && !button.disabled, `操作按钮不可用：${label}`); button.click();
  };
  const item = { id: 'ui-snapshot', name: '原快照', state: 'ready', contentHash: 'hash', messageCount: 1, createdAt: '2026-10-29T00:00:00.000Z' };
  const preview = { snapshot: { header: { ...item, metadata: {} }, chat: [{ name: '角色', mes: '快照内容' }] }, meta: {}, restore: { snapshotId: item.id } };
  const success = { create: { ok: true, header: item }, restore: { ok: true, confirmed: true }, rename: { ...item, name: '新名称' }, delete: { deleted: true } };
  const unknown = { create: { ok: false }, restore: { ok: true, confirmed: false, reason: '酒馆保存尚未确认' }, rename: undefined, delete: { deleted: false } };
  for (const operation of ['create', 'restore', 'rename', 'delete']) {
    for (const outcome of ['success', 'unknown', 'error']) {
      let settle, reject, calls = 0, refreshed = 0;
      const pending = new Promise((resolve, fail) => { settle = resolve; reject = fail; });
      const controller = {
        list: async () => ({ items: [item], after: '' }), preview: async () => preview,
        [operation]: async () => { calls++; return pending; },
      };
      const ui = createSnapshotUi({ controller, onChanged: async () => { refreshed++; } });
      if (operation === 'create') { ui.create(); click('确认创建'); }
      else if (operation === 'restore') {
        await ui.preview(item.id); click('恢复到当前聊天');
        await wait(() => currentDialog()?.querySelector('input[type="checkbox"]'));
        const confirm = currentDialog().querySelector('input'); confirm.checked = true; confirm.dispatchEvent(new Event('change'));
        click('确认覆盖并恢复');
      } else {
        await ui.manage(); click(operation === 'rename' ? '重命名' : '删除');
        await wait(() => currentDialog()?.querySelector('strong')?.textContent === (operation === 'rename' ? '重命名聊天快照' : '删除聊天快照'));
        if (operation === 'rename') currentDialog().querySelector('input').value = '新名称';
        click(operation === 'rename' ? '保存名称' : '确认删除此快照');
      }
      await wait(() => calls === 1);
      const dialog = currentDialog();
      assert(dialog.getAttribute('aria-busy') === 'true', '处理中必须保持忙碌状态');
      assert([...dialog.querySelectorAll('button,input')].every(node => node.disabled), '处理中禁止重复操作');
      const cancel = new Event('cancel', { cancelable: true }); dialog.dispatchEvent(cancel);
      assert(cancel.defaultPrevented && dialog.open, '处理中禁止关闭');
      if (outcome === 'error') reject(new Error('本次操作失败，请重试'));
      else settle(outcome === 'success' ? success[operation] : unknown[operation]);
      await wait(() => !dialog.hasAttribute('aria-busy'));
      if (outcome === 'success') {
        await wait(() => !dialog.isConnected);
        assert(!currentDialog(), '成功后不遗留操作或成功确认弹窗');
        assert(refreshed === 1, '成功后刷新原界面');
      } else {
        await wait(() => !dialog.querySelector('[data-snapshot-status]').textContent.startsWith('正在处理'));
        assert(dialog.open && dialog.isConnected, '失败或结果未知时保留原因');
        assert(dialog.querySelector('[data-snapshot-status]').textContent.trim(), '失败时应说明原因');
        assert(!dialog.querySelector('button').disabled, '失败后恢复可操作状态');
        click('取消');
        await wait(() => !dialog.isConnected);
        if (currentDialog()) { await wait(() => [...currentDialog().querySelectorAll('button')].some(node => node.textContent === '关闭')); click('关闭'); }
      }
      assert(calls === 1, '操作不应重复执行');
      checks.push(`${operation}:${outcome}`);
    }
  }
  // A bare ok flag is insufficient if native saving has not been confirmed.
  assert(checks.includes('restore:unknown'), '必须覆盖保存尚未确认的恢复结果');
  return checks;
}
