import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { chromium } = await import(pathToFileURL(process.env.BOXED_PLAYWRIGHT_PATH).href);
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<meta name="viewport" content="width=device-width"><button id="alive">test</button>'); return; }
  const file = path.resolve(root, '.' + url.pathname);
  if (!file.startsWith(root) || !url.pathname.startsWith('/src/')) { response.writeHead(404).end(); return; }
  try { response.setHeader('Content-Type', 'text/javascript'); response.end(await fs.readFile(file)); } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.BOXED_BROWSER_PATH ? { executablePath: process.env.BOXED_BROWSER_PATH } : {}) });
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: { width: mobile ? 360 : 1200, height: 760 }, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await page.evaluate(async () => {
      const { createIndexedDbStorage } = await import('/src/storage/indexeddb-adapter.js');
      const { readBackupRecords, writeBackupRecords } = await import('/src/storage/backup-batches.js');
      const session = await createIndexedDbStorage().open(), rows = Array.from({ length: 3000 }, (_, messageIndex) => ({ messageIndex, raw: { mes: 'body ' + messageIndex, extra: Array.from({ length: 20 }, (_, i) => ({ key: i, value: true })) } }));
      let ticks = 0; const timer = setInterval(() => ticks++, 10), start = performance.now();
      try {
        await writeBackupRecords(session, { chatKey: 'large', store: 'full_messages', rows, replace: true });
        const summary = await session.getBackupSummary('large');
        const records = await readBackupRecords(session, 'large', 'full_messages', { summary });
        if (records.length !== 3000 || records.at(-1).messageIndex !== 2999) throw new Error('incomplete');
        // Inject a real request failure after deletion and some writes in the final IDB transaction.
        const job = await session.beginBackupWrite({ chatKey: 'large', store: 'full_messages', count: 2, revision: summary.revision });
        await session.appendBackupWrite({ id: job.id, start: 0, rows: [{ messageIndex: 0, raw: { mes: 'replacement' } }, { messageIndex: 1, raw: { mes: 'replacement' } }] });
        const original = IDBObjectStore.prototype.put; let puts = 0, failed = false;
        IDBObjectStore.prototype.put = function (...args) { if (this.name === 'full_messages' && ++puts === 2) throw new DOMException('injected quota', 'QuotaExceededError'); return original.apply(this, args); };
        try { await session.commitBackupWrite({ id: job.id }); } catch { failed = true; } finally { IDBObjectStore.prototype.put = original; }
        const after = await session.getBackupSummary('large');
        if (!failed || after.counts.full_messages !== 3000) throw new Error('transaction did not roll back');
        let unchanged = true;
        try { await writeBackupRecords(session, { chatKey: 'large', store: 'full_messages', rows: rows.slice(0, 100), replace: true, sourceUnchanged: () => { unchanged = !unchanged; return unchanged; } }); } catch {}
        if ((await session.getBackupSummary('large')).counts.full_messages !== 3000) throw new Error('changed source published');
        const { createBackupCoordinator } = await import('/src/controllers/backup-coordinator.js');
        let latest, fullReads = 0;
        const current = { ok: true, chat: rows.slice(0, 3000).map(row => row.raw), identity: { ok: true, chatKey: 'coordinator', meta: { chatKey: 'coordinator', chatId: 'coordinator' } } };
        const adapter = createIndexedDbStorage();
        const coordinator = createBackupCoordinator({ storage: { open: async () => { const opened = await adapter.open(); return { ...opened, getFullMessages: () => { throw new Error('legacy full read'); }, getBackupPage: options => { if (options.store === 'full_messages') fullReads++; return opened.getBackupPage(options); } }; } }, getContextReader: () => ({ readCurrentChat: () => current }), getSettings: () => ({ enabled: true, fullBackupEnabled: true, recentBackupEnabled: true, historicalBackupEnabled: true, recentLimit: 2 }), getLatestStatus: () => latest, setStatus: value => { latest = value; }, refreshVisiblePanel: async () => {}, clearScheduledVerification() {}, scheduleBackendVerification() {}, scheduleBackendSnapshotVerification() {}, readChatCatalog: async () => [] });
        await coordinator.runBackupNow({ eventName: 'extension-loaded', args: [] });
        if (latest.code !== 'saved') throw new Error('coordinator initialize: ' + latest.detail);
        fullReads = 0; current.chat[427].mes = 'edited'; current.chat.push({ mes: 'new tail' });
        coordinator.noteSourceChange();
        await coordinator.runBackupNow({ eventName: 'batched', triggers: [{ eventName: 'message_edited', args: [427] }, { eventName: 'message_received', args: [3000] }] });
        if (fullReads !== 0 || latest.code !== 'checking') throw new Error('incremental read/status failure: ' + fullReads + '/' + latest.code + '/' + latest.detail);
        const final = await readBackupRecords(session, 'coordinator', 'full_messages');
        if (final.length !== 3001 || final[427].raw.mes !== 'edited') throw new Error('mixed event lost');
        const incrementalFullReads = fullReads;
        const { createRestoreController } = await import('/src/controllers/restore-controller.js');
        const { createPanelController } = await import('/src/controllers/panel-controller.js');
        const storage = { getMode: () => 'indexeddb', open: async () => { const opened = await adapter.open(); return { ...opened, getFullMessages: () => { throw new Error('panel legacy full read'); }, getBackupPage: options => { if (options.store === 'full_messages') fullReads++; return opened.getBackupPage(options); } }; } };
        const settings = { enabled: true, fullBackupEnabled: true, recentBackupEnabled: true };
        const restorer = createRestoreController({ storage, getContextReader: () => ({ readCurrentChat: () => current }), getSettings: () => settings, setStatus: value => { latest = value; } });
        document.body.innerHTML = '<section id="boxed-lllllabc-settings-panel"><div id="boxed-lllllabc-settings-panel-body"></div></section>';
        const panel = createPanelController({ storage, getContextReader: () => ({ readCurrentChat: () => current }), getSettings: () => settings, getLatestStatus: () => latest, createRestoreUiState: restorer.createRestoreUiState });
        await panel.renderPanel('settings');
        if (fullReads !== 0 || !document.body.textContent.includes('3001 层')) throw new Error('panel eagerly reads full backup or loses summary');
        const buttons = [...document.querySelectorAll('.boxed-lllllabc-primary-action')];
        if (buttons.length !== 4) throw new Error('primary UI flow changed');
        return { count: records.length, ticks, elapsedMs: Math.round(performance.now() - start), rollback: failed, schema: 8, incrementalFullReads, mixedEvent: true, panelFullReads: fullReads, primaryActions: buttons.length };
      } finally { clearInterval(timer); session.close(); }
    });
    assert.equal(result.count, 3000); assert(result.ticks > 0); console.log(JSON.stringify({ mobile, ...result })); await context.close();
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
