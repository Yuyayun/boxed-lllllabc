import { createPanelController } from '../../src/controllers/panel-controller.js';
import { createCatalogController } from '../../src/controllers/catalog-controller.js';
import { createIndexedDbStorage } from '../../src/storage/indexeddb-adapter.js';
import { writeBackupRecords } from '../../src/storage/backup-batches.js';
import { formatStorageSize } from '../../src/backup/catalog.js';
import { openBackupCleanupDialog, closeBackupCleanupDialog } from '../../src/ui/backup-cleanup-dialog.js';
import { closeBackupCatalogDialog } from '../../src/ui/backup-catalog-dialog.js';
import { openStatusDialog, closeStatusDialog } from '../../src/ui/status-line.js';

export async function runPanelCleanupContract() {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const same = (left, right, message) => assert(JSON.stringify(left) === JSON.stringify(right), message);
  const waitFor = async predicate => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('清理入口未完成预期操作');
  };
  const adapter = createIndexedDbStorage();
  const targets = ['settings', 'dialog', 'status'];
  const chatKeyFor = target => `character:cleanup.png:zz-direct-${target}`;
  const record = (chatKey, messageIndex) => ({ chatKey, messageIndex,
    raw: { mes: `用于清理入口验收的第 ${messageIndex} 层内容` },
    backedUpAt: '2026-11-17T00:00:00.000Z', updatedAt: '2026-11-17T00:00:00.000Z' });
  const seed = await adapter.open();
  try {
    // Keep the requested chat beyond the first 20-entry catalog page.
    for (let i = 0; i < 21; i++) {
      const chatKey = `character:cleanup.png:aa-other-${String(i).padStart(2, '0')}`;
      await writeBackupRecords(seed, { chatKey, store: 'recent_messages', rows: [record(chatKey, 1)] });
    }
    for (const target of targets) {
      const chatKey = chatKeyFor(target);
      await seed.putChatMeta({ chatKey, characterName: '清理验收角色', chatDisplayName: `权威目录-${target}`, fullBackupState: 'active' });
      for (const [store, indices] of Object.entries({ recent_messages: [40, 42], full_messages: [7, 11], historical_changes: [3, 9] })) {
        await writeBackupRecords(seed, { chatKey, store, rows: indices.map(index => record(chatKey, index)) });
      }
      await writeBackupRecords(seed, { chatKey, store: 'pending_changes', rows: [{ ...record(chatKey, 99), id: `${chatKey}:pending` }] });
    }
  } finally { seed.close(); }

  const checks = [];
  async function fixture(target, failure = '') {
    let catalogPages = 0, opens = 0, closes = 0, deletes = 0;
    let latest = { code: 'saved', shortText: '酒馆聊天已保存' };
    const captures = [], chatKey = chatKeyFor(failure === 'empty' ? 'empty' : target);
    const storage = { getMode: () => 'indexeddb', open: async () => {
      const session = await adapter.open(); opens++;
      const forbidden = () => { throw new Error('清理入口不能退回旧整包读取'); };
      return { ...session, close() { closes++; session.close(); },
        getFullMessages: forbidden, getPendingChanges: forbidden, getHistoricalChanges: forbidden,
        getBackupCatalog: forbidden, getBackupCatalogData: forbidden,
        getBackupPage: options => {
          assert(options.store === 'recent_messages', '面板只能加载有限 recent，不读取完整正文');
          return session.getBackupPage(options);
        },
        getBackupCatalogPage: async options => {
          catalogPages++;
          if (failure === 'read-error') throw new Error('目录读取失败，请重试');
          const page = await session.getBackupCatalogPage(options);
          if (failure === 'missing') return { ...page, items: page.items.filter(chat => chat.chatKey !== chatKey) };
          if (failure === 'revision' && options.after !== null) return { ...page, revision: page.revision + 1 };
          return page;
        },
        deleteBackupV2: options => { deletes++; return session.deleteBackupV2(options); },
      };
    } };
    document.body.replaceChildren();
    if (target === 'dialog') openStatusDialog();
    else {
      const shell = document.createElement('section'); shell.id = `boxed-lllllabc-${target}-panel`;
      const body = document.createElement('div'); body.id = `boxed-lllllabc-${target}-panel-body`;
      shell.append(body); document.body.append(shell);
    }
    const catalog = createCatalogController({ storage, waitForDialogPaint: async () => {},
      openCleanupDialog: options => {
        captures.push(structuredClone({ chat: options.chat, plans: options.plans }));
        return openBackupCleanupDialog(options);
      },
    });
    const panel = createPanelController({ storage,
      getContextReader: () => ({ readCurrentChat: () => ({ ok: true, chat: [{ mes: '当前聊天' }], identity: { chatKey, meta: { chatKey, chatDisplayName: '面板中的旧名称' } } }) }),
      getSettings: () => ({ enabled: true, fullBackupEnabled: true, recentBackupEnabled: true, statusDisplayMode: target === 'status' ? 'top' : 'message' }),
      getLatestStatus: () => latest, setStatus: status => { latest = status; }, createRestoreUiState: () => ({}),
      openBackupCleanup: chat => catalog.openCleanup(chat),
    });
    await panel.renderPanel(target);
    assert(catalogPages === 0, '打开当前聊天面板不应读取 catalog');
    const button = document.querySelector(`#boxed-lllllabc-${target === 'dialog' ? 'status-dialog' : `${target}-panel`}-body .boxed-lllllabc-current-cleanup`);
    assert(button, '管理清理入口缺失');
    return { button, catalog, captures, chatKey, storage,
      get catalogPages() { return catalogPages; }, get latest() { return latest; }, get deletes() { return deletes; },
      assertClosed() { assert(opens === closes, '读取或失败后存储会话未关闭'); },
    };
  }

  for (const target of targets) {
    const run = await fixture(target);
    assert(!run.button.disabled, '有备份时管理清理应可用');
    // The click must read current catalog data, rather than the counts captured at render.
    const session = await adapter.open();
    try { await writeBackupRecords(session, { chatKey: run.chatKey, store: 'recent_messages', rows: [record(run.chatKey, 45)] }); }
    finally { session.close(); }
    run.button.click();
    await waitFor(() => run.captures.length === 1 && !run.button.disabled);
    assert(run.catalogPages === 2, '点击管理清理后应按页读取完整权威目录');
    run.assertClosed();
    const direct = run.captures[0];
    assert(direct.chat.chatKey === run.chatKey && direct.chat.displayName === `权威目录-${target}`, '必须按 chatKey 找到真实目录条目');
    assert(direct.chat.storageBytes > 0, '不能将当前聊天大小伪造为 0 B');
    const expectedRanges = { recent: '第 40－45 层', full: '第 7－11 层', historical: '第 3－9 层' };
    for (const [type, range] of Object.entries(expectedRanges)) {
      const plan = direct.plans.find(plan => plan.type === type);
      assert(plan.storageBytes > 0 && plan.rangeText === range, `${type} 的大小或范围不是权威值`);
      assert(plan.expectedFingerprint === `v2:${direct.chat.revision}`, '清理计划必须保留目录 revision 凭据');
      const row = [...document.querySelectorAll('.boxed-lllllabc-cleanup-option')].find(node => node.textContent.includes(plan.typeLabel));
      assert(row.textContent.includes(range) && row.textContent.includes(formatStorageSize(plan.storageBytes)), '清理界面应展示真实范围和大小');
    }
    assert(direct.chat.recent.count === 3, '点击应读取面板打开后新增的记录');
    const directText = [...document.querySelectorAll('.boxed-lllllabc-cleanup-option-copy > span')].map(node => node.textContent);
    closeBackupCleanupDialog();

    const loaded = await run.catalog.openCatalog();
    assert(loaded.ok, '全部聊天备份目录应读取成功');
    const reads = run.catalogPages;
    const entry = [...document.querySelectorAll('.boxed-lllllabc-catalog-entry')].find(node => node.querySelector('.boxed-lllllabc-catalog-identity > strong').textContent === direct.chat.displayName);
    entry.querySelector('.boxed-lllllabc-catalog-cleanup').click();
    assert(run.captures.length === 2 && run.catalogPages === reads, '目录入口应复用已有 catalog');
    same(run.captures[1], direct, '两个入口的 chat summary 和 cleanup plans 必须一致');
    same([...document.querySelectorAll('.boxed-lllllabc-cleanup-option-copy > span')].map(node => node.textContent), directText, '两个入口的清理展示必须一致');

    const changed = await adapter.open();
    try { await writeBackupRecords(changed, { chatKey: run.chatKey, store: 'recent_messages', rows: [record(run.chatKey, 46)] }); }
    finally { changed.close(); }
    const result = await run.catalog.executeCleanup(direct.plans.find(plan => plan.type === 'recent'));
    assert(!result.ok && result.reason.includes('预览后发生了变化') && run.deletes === 0, '确认阶段必须重新读取目录并拒绝 stale 计划');
    run.assertClosed();
    closeBackupCleanupDialog(); closeBackupCatalogDialog(); closeStatusDialog();
    checks.push(`${target}:authoritative-catalog-and-stale-guard`);
  }

  for (const failure of ['read-error', 'missing', 'revision']) {
    const run = await fixture('settings', failure);
    run.button.click();
    await waitFor(() => !run.button.isConnected);
    assert(run.latest.code === 'saved', '管理入口读取失败不得覆盖聊天已保存状态');
    assert(document.querySelector('.boxed-lllllabc-panel-summary').textContent.includes('备份读取失败'), '当前面板应单独显示读取失败');
    assert(run.captures.length === 0, '目录异常或当前聊天已消失时，不能打开伪造清理摘要');
    assert(!document.querySelector('#boxed-lllllabc-cleanup-dialog'), '读取失败不应打开清理对话框');
    assert(!document.querySelector('.boxed-lllllabc-current-cleanup').disabled, '读取失败后应恢复入口');
    run.assertClosed(); checks.push(`settings:${failure}`);
  }
  const empty = await fixture('settings', 'empty');
  assert(empty.button.disabled && empty.catalogPages === 0, '空聊天不应预读目录或开放清理');
  empty.assertClosed(); checks.push('settings:empty');
  return checks;
}
