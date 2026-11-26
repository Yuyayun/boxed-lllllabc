import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const playwright = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const output = path.resolve(process.env.BOXED_TEST_OUTPUT ?? path.join(root, '.local-test/review-1.0.5-fix.2'));
const baselineCache = new Map(), git = promisify(execFile);
await fs.mkdir(output, { recursive: true });
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (/^\/baseline\/src\/[a-zA-Z0-9_./-]+\.js$/.test(pathname) && !pathname.includes('..')) {
      const source = pathname.slice('/baseline/'.length);
      if (!baselineCache.has(source)) baselineCache.set(source, (await git('git', ['show', `ab7339ef02da588b5cbbff10bf0143f11e53018c:${source}`], { cwd: root, maxBuffer: 1024 * 1024 })).stdout);
      res.setHeader('Content-Type', 'text/javascript'); res.end(baselineCache.get(source)); return;
    }
    if (pathname === '/' || pathname === '/dataset-contract') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html lang="zh"><meta charset="utf-8"><title>隔离 IndexedDB 回归</title><body></body></html>'); return; }
    const sourcePath = pathname.replace(/^\/scripts\/extensions\/third-party\/boxed-lllllabc\//, '/');
    const file = path.resolve(root, `.${sourcePath}`);
    if (!file.startsWith(root + path.sep) || !/^\/(src|tests\/(browser|contracts)|styles)\//.test(sourcePath) && !['/style.css', '/settings.html'].includes(sourcePath)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const results = [];
try {
  for (const engine of (process.env.BOXED_TEST_ENGINES ?? 'edge').split(',')) {
    let browser, browserServer;
    try {
      const type = playwright[engine === 'edge' ? 'chromium' : engine];
      browserServer = await type.launchServer(engine === 'edge' ? { channel: 'msedge', headless: true, timeout: 45000 } : { headless: true, timeout: 45000 });
      browser = await type.connect(browserServer.wsEndpoint());
    } catch (error) {
      results.push({ engine, available: false, reason: error.message.split('\n')[0] }); continue;
    }
    try {
      const context = await browser.newContext(), page = await context.newPage(), errors = [];
      let lastCase = '', watchdog;
      const armWatchdog = () => { clearTimeout(watchdog); watchdog = setTimeout(() => { console.log(`${engine}: 测试无进展，最后测试 ${lastCase}`); browserServer.kill().catch(() => {}); }, 300000); };
      page.on('console', message => { if (message.text().startsWith('IDB_CASE ')) { lastCase = message.text().slice(9); console.log(`${engine}: ${lastCase}`); armWatchdog(); } else if (message.text().startsWith('IDB_STEP ')) { console.log(`${engine}: ${message.text().slice(9)}`); armWatchdog(); } });
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      console.log(`${engine}: ${JSON.stringify(await page.evaluate(() => ({ secureContext: isSecureContext, nativeWebLocks: Boolean(navigator.locks?.request) })))}`);
      armWatchdog();
      let result;
      try { result = await page.evaluate(async options => (await import('/tests/browser/indexeddb-recovery-contract.js')).runIndexedDbRecoveryContract(options), { only: process.env.BOXED_IDB_CASE_FILTER, duplicateRows: Number(process.env.BOXED_IDB_DUPLICATE_ROWS ?? (engine === 'webkit' ? 1000 : 10000)) }); }
      finally { clearTimeout(watchdog); }
      results.push({ engine, available: true, version: browser.version(), ...result, pageErrors: errors });
      console.log(`${engine}: 专项 ${result.checks.length} 项通过，${result.failures.length} 项失败`);
      await fs.writeFile(path.join(output, 'browser.json'), JSON.stringify(results, null, 2));
      if (errors.length || result.failures.length) process.exitCode = 1;
      await context.close();
      if (engine === 'edge' && process.env.BOXED_PERFORMANCE_CHECK === '1') {
        const fixture = await browser.newContext(), target = await fixture.newPage();
        try {
          await target.goto(`http://127.0.0.1:${server.address().port}/`);
          results.at(-1).performance = await target.evaluate(async () => (await import('/tests/browser/indexeddb-recovery-performance.js')).measureIndexedDbRecoveryPerformance());
        } catch (error) { results.at(-1).performanceError = error.message; process.exitCode = 1; }
        finally { await fixture.close(); }
      }
      if (process.env.BOXED_EXISTING_CONTRACTS === '1' && (engine !== 'webkit' || process.env.BOXED_WEBKIT_REGRESSIONS === '1')) {
        const regressions = [];
        for (const [file, method, pathname] of [
          ['backup-version-contract', 'runBackupVersionContract'], ['historical-repair-contract', 'runHistoricalRepairContract'],
          ['legacy-sequence-contract', 'runLegacySequenceContract'], ['pending-journal-contract', 'runPendingJournalContract'],
          ['panel-cleanup-contract', 'runPanelCleanupContract'], ['recovery-log-contract', 'runRecoveryLogContract'],
          ['dataset-contract', 'runDatasetContract', '/dataset-contract'],
        ]) {
          const fixture = await browser.newContext(), target = await fixture.newPage(), pageErrors = [];
          target.on('pageerror', error => pageErrors.push(error.message));
          try {
            await target.goto(`http://127.0.0.1:${server.address().port}${pathname ?? '/'}`);
            const checks = await target.evaluate(async ({ file, method }) => (await import(`/tests/browser/${file}.js`))[method](), { file, method });
            regressions.push({ file, checks, pageErrors }); if (pageErrors.length) process.exitCode = 1;
            console.log(`${engine}: ${file} 通过`);
          } catch (error) { regressions.push({ file, error: error.message, pageErrors }); process.exitCode = 1; }
          finally { await fixture.close(); }
        }
        results.at(-1).regressions = regressions;
        await fs.writeFile(path.join(output, 'browser.json'), JSON.stringify(results, null, 2));
      }
      if (engine === 'edge' && process.env.BOXED_UI_CHECK === '1') {
        const ui = [];
        for (const width of [1280, 360]) {
          console.log(`UI ${width}: 开始`);
          const fixture = await browser.newContext({ viewport: { width, height: 800 }, acceptDownloads: true }), target = await fixture.newPage();
          try {
            await target.goto(`http://127.0.0.1:${server.address().port}/`);
            await target.evaluate(async () => (await import('/tests/browser/local-recovery-ui-fixture.js')).installLocalRecoveryUiFixture());
            console.log(`UI ${width}: 夹具就绪`);
            await target.getByRole('button', { name: '处理本地备份故障', exact: true }).click();
            await target.screenshot({ path: path.join(output, `local-recovery-${width}-open.png`) });
            await target.getByRole('button', { name: '清除旧本地备份并重建', exact: true }).click();
            if (!await target.getByRole('button', { name: '删除旧备份并重建', exact: true }).isDisabled()) throw new Error('未勾选时删除可执行');
            await target.screenshot({ path: path.join(output, `local-recovery-${width}-confirm.png`) });
            await target.getByRole('button', { name: '取消', exact: true }).click();
            if (await target.evaluate(() => localRecoveryFixture.count()) !== 2) throw new Error('取消删除改动旧数据');
            await target.getByRole('button', { name: '尝试救援本地备份', exact: true }).click();
            const downloadButton = target.getByRole('button', { name: '下载第 1 卷并继续', exact: true });
            await downloadButton.waitFor();
            const [download] = await Promise.all([target.waitForEvent('download'), downloadButton.click()]);
            await download.saveAs(path.join(output, `ui-rescue-${width}.json`));
            console.log(`UI ${width}: 救援卷已下载`);
            await target.getByRole('button', { name: '下载救援清单', exact: true }).waitFor();
            await target.getByRole('button', { name: '返回故障处理', exact: true }).click();
            await target.getByRole('button', { name: '清除旧本地备份并重建', exact: true }).click();
            await target.getByRole('checkbox').check();
            await target.getByRole('button', { name: '删除旧备份并重建', exact: true }).click();
            console.log(`UI ${width}: 已确认重建`);
            await target.getByText('旧本地备份已删除，新备份库已建立并核验。', { exact: false }).waitFor();
            await target.screenshot({ path: path.join(output, `local-recovery-${width}-rebuilt.png`) });
            const layout = await target.locator('#boxed-lllllabc-local-recovery-dialog').evaluate(node => ({ width: node.getBoundingClientRect().width, overflow: node.scrollWidth > node.clientWidth }));
            if (layout.overflow || layout.width > width) throw new Error('本地故障界面横向溢出');
            if (await target.evaluate(() => localRecoveryFixture.count()) !== 0) throw new Error('UI 重建残留旧数据');
            ui.push({ width, passed: true, layout });
            console.log(`UI ${width}: 通过`);
          } catch (error) { ui.push({ width, error: error.message }); process.exitCode = 1; }
          finally { await fixture.close(); }
        }
        results.at(-1).ui = ui;
      }
    } catch (error) { results.push({ engine, available: true, error: error.stack }); process.exitCode = 1; }
    finally {
      await browser.close().catch(() => {});
      browserServer.process()?.kill('SIGKILL');
      await browserServer.kill();
    }
  }
  if (!results.some(item => item.available)) process.exitCode = 1;
} finally { await new Promise(resolve => server.close(resolve)); }
await fs.writeFile(path.join(output, 'browser.json'), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
