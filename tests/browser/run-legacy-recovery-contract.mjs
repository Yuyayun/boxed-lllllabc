import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../',import.meta.url)),{chromium}=await import(process.env.BOXED_PLAYWRIGHT_PATH?pathToFileURL(process.env.BOXED_PLAYWRIGHT_PATH).href:'playwright');
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost').pathname;if(url==='/legacy-recovery-contract'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><script type="module" src="/tests/browser/legacy-recovery-contract.js"></script>');return;}const file=path.resolve(root,'.'+url),relative=path.relative(root,file);if(relative.startsWith('..')||path.isAbsolute(relative)||!/^\/(src|tests\/browser)\//.test(url)||!url.endsWith('.js')){res.writeHead(404).end();return;}res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(await fs.readFile(file));}catch{res.writeHead(404).end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try{browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage(),errors=[],results=[];page.on('pageerror',error=>errors.push(error.message));const url=`http://127.0.0.1:${server.address().port}/legacy-recovery-contract`;
  const load=async()=>{await page.goto(url);await page.waitForFunction(()=>!!globalThis.legacyContract);};await load();for(const stage of ['inventory','clear','copy','verify','cleanup','activated']){const seeded=await page.evaluate(stage=>legacyContract.seed(stage),stage);await load();results.push({...seeded,...await page.evaluate(()=>legacyContract.recover())});}assert.deepEqual(errors,[]);console.log(JSON.stringify({results,browser:browser.version(),pageErrors:errors},null,2));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
