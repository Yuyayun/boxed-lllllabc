import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const { chromium } = await import(process.env.BOXED_PLAYWRIGHT_PATH ? pathToFileURL(process.env.BOXED_PLAYWRIGHT_PATH).href : 'playwright');
const mode = process.env.BOXED_SERVER_REPOSITORY ? 'sqlite' : 'indexeddb', nonce = randomUUID();
let routes, directory;
const handlers = new Map();
if (mode === 'sqlite') {
  directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'boxed-version-browser-'));
  const storage = path.join(directory, 'boxed-storage'); await fs.mkdir(storage);
  const { installRoutes } = await import(pathToFileURL(path.join(process.env.BOXED_SERVER_REPOSITORY, 'src/router.js')).href);
  const host = { root: directory, dataRoot: path.join(directory, 'data'), defaultHandle: 'default-user', users: async () => [], csrfEnabled: () => true,
    config: (key, fallback) => key === 'boxedLllllabc.databaseDirectory' ? storage : key === 'enableUserAccounts' ? false : fallback };
  routes = installRoutes({ get: (name, handler) => handlers.set('GET ' + name, handler), post: (name, handler) => handlers.set('POST ' + name, handler) }, { host });
}
const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname.startsWith('/api/plugins/boxed-lllllabc/')) {
    try {
      if (!routes || request.headers['x-test-nonce'] !== nonce) { response.writeHead(403).end(); return; }
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new Error('Fixture body limit'); chunks.push(chunk); }
      request.body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      request.protocol = 'http'; request.get = name => request.headers[name.toLowerCase()];
      request.user = { profile: { handle: 'default-user', enabled: true } }; request.session = { handle: 'default-user' };
      response.set = (key, value) => response.setHeader(key, value); response.status = code => { response.statusCode = code; return response; };
      response.json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
      const route = handlers.get(request.method + ' ' + pathname.slice('/api/plugins/boxed-lllllabc'.length));
      if (!route) { response.writeHead(404).end(); return; }
      await route(request, response);
    } catch (error) { if (!response.destroyed && !response.headersSent) response.writeHead(500).end(JSON.stringify({ reason: error.message })); else response.destroy(error); }
    return;
  }
  if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/style.css"><style>body{background:#202124;color:#eee;font:16px sans-serif;--SmartThemeBlurTintColor:#25262a;--SmartThemeBodyColor:#eee;--SmartThemeBorderColor:#777}.menu_button{color:inherit;background:#333;border:1px solid #777;border-radius:5px;padding:8px}</style>'); return; }
  if(pathname==='/style.css'||/^\/styles\/[a-z-]+\.css$/.test(pathname)){
    try{const css=await fs.readFile(path.resolve(root,'.'+pathname));response.setHeader('Content-Type','text/css');response.end(css);}
    catch{response.writeHead(404).end();}return;
  }
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
      const checks = await page.evaluate(async options => (await import('/tests/browser/backup-version-contract.js')).runBackupVersionContract(options), { mode, nonce });
      assert.equal(checks.length, mode === 'sqlite' ? 26 : 27);
      let historicalRepairCases;
      if (mode === 'sqlite') {
        historicalRepairCases = await page.evaluate(async nonce => {
          const { createSqliteStorage } = await import('/src/storage/sqlite-client.js');
          const { runHistoricalRepairContract } = await import('/tests/browser/historical-repair-contract.js');
          return runHistoricalRepairContract({ adapter: createSqliteStorage({ getRequestHeaders: () => ({ 'X-Test-Nonce': nonce, 'X-CSRF-Token': nonce }) }), mode: 'sqlite' });
        }, nonce);
        assert.equal(historicalRepairCases.length, 6);
      }
      assert.deepEqual(errors, []);
      const journalCases=await page.evaluate(async ({mode,nonce})=>{
        const adapter=mode==='sqlite'?(await import('/src/storage/sqlite-client.js')).createSqliteStorage({getRequestHeaders:()=>({'X-Test-Nonce':nonce,'X-CSRF-Token':nonce})}):undefined;
        return (await import('/tests/browser/pending-journal-contract.js')).runPendingJournalContract({adapter,mode});
      },{mode,nonce});
      assert.equal(journalCases.length,13);assert.deepEqual(errors,[]);
      if(process.env.BOXED_SCREENSHOT_ROOT){await page.screenshot({path:path.join(process.env.BOXED_SCREENSHOT_ROOT,`${mode}-${mobile?'mobile':'desktop'}-recovery.png`)});await page.locator('.boxed-lllllabc-recovery-source button').first().click();await page.screenshot({path:path.join(process.env.BOXED_SCREENSHOT_ROOT,`${mode}-${mobile?'mobile':'desktop'}-preview.png`)});}
      const legacyCases=await page.evaluate(async({mode,nonce})=>{
        const adapter=mode==='sqlite'?(await import('/src/storage/sqlite-client.js')).createSqliteStorage({getRequestHeaders:()=>({'X-Test-Nonce':nonce,'X-CSRF-Token':nonce})}):undefined;
        return (await import('/tests/browser/legacy-sequence-contract.js')).runLegacySequenceContract({adapter,mode});
      },{mode,nonce});
      assert.equal(legacyCases.length,12);assert.deepEqual(errors,[]);
      const recoveryLogCases=await page.evaluate(async({mode,nonce})=>{
        const adapter=mode==='sqlite'?(await import('/src/storage/sqlite-client.js')).createSqliteStorage({getRequestHeaders:()=>({'X-Test-Nonce':nonce,'X-CSRF-Token':nonce})}):undefined;
        return (await import('/tests/browser/recovery-log-contract.js')).runRecoveryLogContract({adapter,mode});
      },{mode,nonce});
      assert.equal(recoveryLogCases.length,2);assert.deepEqual(errors,[]);
      if(process.env.BOXED_LEGACY_SCREENSHOT_ROOT)await page.screenshot({path:path.join(process.env.BOXED_LEGACY_SCREENSHOT_ROOT,`${mode}-${mobile?'mobile':'desktop'}-branch.png`)});
      const statusCopyCases=await page.evaluate(async()=> (await import('/tests/browser/status-copy-contract.js')).runStatusCopyContract());
      assert.equal(statusCopyCases.length,10);assert.deepEqual(errors,[]);
      if(process.env.BOXED_STATUS_COPY_SCREENSHOT_ROOT)await page.screenshot({path:path.join(process.env.BOXED_STATUS_COPY_SCREENSHOT_ROOT,`${mode}-${mobile?'mobile':'desktop'}-status.png`)});
      console.log(JSON.stringify({ mode, mobile, checks: checks.length, cases: checks, historicalRepairCases,journalCases,legacyCases,recoveryLogCases,statusCopyCases }));
    } finally { await context.close(); }
  }
} finally {
  await browser?.close(); await routes?.close(); await new Promise(resolve => server.close(resolve));
  if (directory) {
    const resolved = await fs.realpath(directory), base = await fs.realpath(os.tmpdir());
    assert.equal(path.dirname(resolved), base); assert(path.basename(resolved).startsWith('boxed-version-browser-'));
    await fs.rm(resolved, { recursive: true });
  }
}
