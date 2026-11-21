import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const { chromium } = await import(process.env.BOXED_PLAYWRIGHT_PATH ? pathToFileURL(process.env.BOXED_PLAYWRIGHT_PATH).href : 'playwright');
const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<meta name="viewport" content="width=device-width">'); return; }
  const file = path.resolve(root, '.' + pathname), relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !/^\/(src|tests)\/.+\.js$/.test(pathname)) { response.writeHead(404).end(); return; }
  try { response.setHeader('Content-Type', 'text/javascript'); response.end(await fs.readFile(file)); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.BOXED_BROWSER_PATH ? { executablePath: process.env.BOXED_BROWSER_PATH } : { channel: 'msedge' }) });
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: { width: mobile ? 360 : 1200, height: 760 }, isMobile: mobile, hasTouch: mobile });
    try {
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const checks = await page.evaluate(async () => (await import('/tests/browser/backup-version-contract.js')).runBackupVersionContract());
      assert.equal(checks.length, 27); assert.deepEqual(errors, []);
      console.log(JSON.stringify({ mobile, checks: checks.length, cases: checks }));
    } finally { await context.close(); }
  }
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
