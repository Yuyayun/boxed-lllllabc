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
        return { count: records.length, ticks, elapsedMs: Math.round(performance.now() - start), rollback: failed, schema: 8 };
      } finally { clearInterval(timer); session.close(); }
    });
    assert.equal(result.count, 3000); assert(result.ticks > 0); console.log(JSON.stringify({ mobile, ...result })); await context.close();
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
