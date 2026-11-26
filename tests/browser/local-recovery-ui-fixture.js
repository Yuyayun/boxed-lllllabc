import { createIndexedDbStorage } from '../../src/storage/indexeddb-adapter.js';
import { createStorageControl } from '../../src/storage/control.js';
import { createLocalRecovery } from '../../src/storage/local-recovery.js';
import { createLocalRecoveryUi } from '../../src/ui/local-recovery.js';

export async function installLocalRecoveryUiFixture() {
  if (location.hostname !== '127.0.0.1') throw new Error('仅允许隔离浏览器');
  document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/style.css' }));
  document.body.style.cssText = 'font:16px/1.5 system-ui;background:#202020;color:#eee;--SmartThemeBodyColor:#eee;--SmartThemeBlurTintColor:#252525;--SmartThemeBorderColor:#777';
  document.body.innerHTML = '<div id="boxed-lllllabc-local-recovery" hidden><button id="boxed-lllllabc-open-local-recovery" class="menu_button">处理本地备份故障</button></div>';
  const local = createIndexedDbStorage(), key = 'character:ui-only.png:synthetic', session = await local.open();
  await session.putFullMessages({ chatKey: key, messages: [0, 1].map(messageIndex => ({ messageIndex, message: { mes: `合成测试正文 ${messageIndex}` } })) }); session.close();
  let ui;
  const coordinator = createLocalRecovery({ local, control: createStorageControl(), onProgress: value => ui?.progress(value) });
  ui = createLocalRecoveryUi({ coordinator, getChatKey: () => key }); ui.bind(); ui.showFault(new Error('旧本地备份暂时无法读取。'));
  globalThis.localRecoveryFixture = { async count() { const session = await local.open(); try { return (await session.getFullMessages(key)).length; } finally { session.close(); } } };
}
