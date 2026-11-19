import { createPanelController } from '../../src/controllers/panel-controller.js';

export async function runPanelVerificationContract() {
  const cases = [];
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  for (const bounded of [true, false]) {
    const scenarios = bounded ? [[1, 1], [0, 0], [0, 1], [1, 0], [1, 1, true]] : [[1, 1], [0, 0]];
    for (const [initialCount, clickCount, readFailure = false] of scenarios) {
      let pendingCount = initialCount, revision = 1, bodyReads = 0, snapshotReads = 0, pendingReads = 0, opens = 0, closes = 0;
      let failNextSummary = false, latestStatus = { code: 'checking', shortText: '正在检查保存状态' };
      const calls = [], current = { ok: true, chat: [{ mes: 'current' }], identity: { chatKey: 'verify', meta: { chatKey: 'verify' } } };
      const settings = { enabled: true, fullBackupEnabled: true, recentBackupEnabled: true };
      const summary = () => ({ meta: { chatKey: 'verify' }, revision, counts: { pending_changes: pendingCount, full_messages: 0, historical_changes: 0, recent_messages: 0 } });
      const storage = { getMode: () => 'indexeddb', open: async () => {
        opens++;
        return { capabilities: bounded ? { boundedBackup: 1 } : {}, close() { closes++; },
          getBackupSummary: async () => {
            if (failNextSummary) { failNextSummary = false; throw new Error('摘要读取失败，请重试'); }
            return summary();
          },
          getBackupPage: async options => { assert(options.store === 'recent_messages', '手动核对不应读取 pending 或完整正文'); return { rows: [], after: null }; },
          getRecentMessages: async () => [], getChatMeta: async () => ({ chatKey: 'verify' }),
          getPendingChanges: async () => { bodyReads++; return pendingCount ? [{ chatKey: 'verify', id: 'verify:0', messageIndex: 0 }] : []; },
          getFullMessages: async () => { bodyReads++; return []; }, getHistoricalChanges: async () => [],
        };
      } };
      document.body.innerHTML = '<section id="boxed-lllllabc-settings-panel"><div id="boxed-lllllabc-settings-panel-body"></div></section>';
      const panel = createPanelController({ storage, getContextReader: () => ({ readCurrentChat: () => current }), getSettings: () => settings,
        getLatestStatus: () => latestStatus, setStatus: status => { latestStatus = status; }, createRestoreUiState: () => ({}),
        verifyBackendNow: async options => { pendingReads++; calls.push(options); },
        verifyBackendSnapshotNow: async options => { snapshotReads++; calls.push(options); }, verificationRetryLimit: 3,
      });
      await panel.renderPanel('settings');
      pendingCount = clickCount; revision++; failNextSummary = readFailure;
      const verifyButton = () => [...document.querySelectorAll('.boxed-lllllabc-primary-action')].find(node => node.textContent.includes('检查保存状态'));
      const button = verifyButton();
      assert(button && !button.disabled, '检查保存状态入口应可用'); button.click();
      for (let attempt = 0; attempt < 100 && button.isConnected; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
      assert(!button.isConnected && verifyButton() && !verifyButton().disabled, '完成核对或读取失败后应刷新原面板并恢复可操作状态');
      if (readFailure) {
        assert(calls.length === 0, '摘要读取失败时不应猜测核对路径');
        assert(latestStatus.code === 'checking', '摘要读取失败不得覆盖聊天保存状态');
        assert(document.querySelector('.boxed-lllllabc-panel-summary').textContent.includes('摘要读取失败，请重试'), '原面板应显示具体失败原因');
      } else {
        assert(pendingReads === (clickCount ? 1 : 0) && snapshotReads === (clickCount ? 0 : 1), `核对路径错误：bounded=${bounded}, pending=${initialCount}->${clickCount}, calls=${JSON.stringify({ pendingReads, snapshotReads })}`);
        assert(calls[0].chatKey === 'verify' && calls[0].retryIndex === 3, '手动核对应沿用当前身份和重试上限');
      }
      assert(opens === closes, '核对与刷新后必须关闭所有存储会话');
      if (bounded) assert(bodyReads === 0, '懒加载面板不得为选择核对路径搬运正文');
      cases.push({ bounded, initialCount, clickCount, readFailure });
    }
  }
  return cases;
}
