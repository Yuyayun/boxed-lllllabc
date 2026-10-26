import { buildBackupCatalog } from '/scripts/extensions/third-party/boxed-lllllabc/src/backup/catalog.js';
import { openBackupCatalogDialog, renderBackupCatalogDialog, closeBackupCatalogDialog } from '/scripts/extensions/third-party/boxed-lllllabc/src/ui/backup-catalog-dialog.js';

export function showCatalogFixture(state = 'loaded') {
  if (location.origin !== 'http://127.0.0.1:18000') throw new Error('仅供隔离酒馆验收');
  if (!document.querySelector('#boxed-lllllabc-catalog-dialog')) openBackupCatalogDialog();
  if (state === 'loading') return renderBackupCatalogDialog({ loading: true });
  if (state === 'error') return renderBackupCatalogDialog({ error: '受控读取失败；未修改备份。' });
  const chatMeta = [], recentMessages = [];
  for (let i = 0; i < (state === 'empty' ? 0 : 180); i++) {
    const chatKey = `character:p6-${i % 6}.png:${i}`;
    chatMeta.push({ chatKey, chatType: 'character', characterAvatar: `p6-${i % 6}.png`, characterName: `角色${i % 6}`,
      chatDisplayName: `聊天${i}：` + (i === 0 ? '长名称<>&'.repeat(32) : '独立备份') });
    recentMessages.push({ chatKey, messageIndex: i, raw: { mes: '虚构测试数据' } });
  }
  renderBackupCatalogDialog({ catalog: buildBackupCatalog({ chatMeta, recentMessages }) });
}

export function inspectCatalogLayout() {
  const dialog = document.querySelector('#boxed-lllllabc-catalog-dialog');
  const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const frame = dialog.querySelector('.boxed-lllllabc-catalog-frame'), body = dialog.querySelector('.boxed-lllllabc-catalog-body');
  const viewport = window.visualViewport;
  return { viewport: { x: viewport?.offsetLeft ?? 0, y: viewport?.offsetTop ?? 0, width: viewport?.width ?? innerWidth, height: viewport?.height ?? innerHeight },
    frame: rect(frame), header: rect(dialog.querySelector('header')), footer: rect(dialog.querySelector('.boxed-lllllabc-catalog-mobile-footer')),
    body: { ...rect(body), scrollHeight: body.scrollHeight, clientHeight: body.clientHeight, scrollWidth: body.scrollWidth, clientWidth: body.clientWidth },
    placeItems: getComputedStyle(dialog).placeItems, background: getComputedStyle(frame).backgroundColor,
    color: getComputedStyle(frame).color, modalOpen: dialog.isConnected };
}
export { closeBackupCatalogDialog };
