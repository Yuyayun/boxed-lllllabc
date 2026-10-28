// Run against a private loopback origin, never an installed Tavern or its data.
// BOXED_PLAYWRIGHT_PATH may point to an existing Playwright module; no project
// production dependency is added for this browser-only acceptance runner.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root=fileURLToPath(new URL('../../',import.meta.url));
const {chromium}=await import(process.env.BOXED_PLAYWRIGHT_PATH?pathToFileURL(process.env.BOXED_PLAYWRIGHT_PATH).href:'playwright');
const server=http.createServer(async(req,res)=>{
  try {
    const pathname=new URL(req.url,'http://127.0.0.1').pathname;
    if(pathname==='/dataset-contract') {
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end('<!doctype html><script type="module">import {runDatasetContract} from "/tests/browser/dataset-contract.js";globalThis.runDatasetContract=runDatasetContract;</script>');return;
    }
    const target=path.resolve(root,'.'+pathname),relative=path.relative(root,target);
    if(relative.startsWith('..')||path.isAbsolute(relative)||!pathname.endsWith('.js')||!/^\/(src|tests\/browser)\//.test(pathname)) {res.writeHead(404).end();return;}
    res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(await fs.readFile(target));
  }catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser=await chromium.launch({headless:true,...(process.env.BOXED_BROWSER_PATH?{executablePath:process.env.BOXED_BROWSER_PATH}:{channel:'msedge'})});
  const context=await browser.newContext(),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/dataset-contract`);
  await page.waitForFunction(()=>typeof globalThis.runDatasetContract==='function');
  const result=await page.evaluate(()=>globalThis.runDatasetContract());assert.deepEqual(errors,[]);
  console.log(JSON.stringify({...result,browser:browser.version(),pageErrors:errors},null,2));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
