// Private fixture bridge: invokes repository methods directly, never installs a
// route in Tavern and never opens the user's SQLite/IndexedDB data.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { encodeStorageValue, decodeStorageValue } from '../../src/storage/protocol.js';

if(!process.env.BOXED_SERVER_REPOSITORY)throw new Error('Set BOXED_SERVER_REPOSITORY to the independent backend checkout');
const {SqliteRepository}=await import(pathToFileURL(path.join(process.env.BOXED_SERVER_REPOSITORY,'src/sqlite.js')).href);
const {chromium}=await import(process.env.BOXED_PLAYWRIGHT_PATH?pathToFileURL(process.env.BOXED_PLAYWRIGHT_PATH).href:'playwright');
const root=fileURLToPath(new URL('../../',import.meta.url)),tempRoot=await fs.realpath(os.tmpdir()),directory=await fs.mkdtemp(path.join(tempRoot,'boxed-batch-browser-')),nonce=randomUUID();
const allowed=new Set(['begin','status','prepareStep','sourceNext','append','verifyBatch','startSeal','sealStep']);
const normalAllowed=new Set(['putChatMeta','getChatMeta','putFullMessages','getFullMessages','replaceRecentSnapshot','putPendingChanges','putHistoricalChanges','beginSnapshot','appendSnapshotMessages','publishSnapshot','getSnapshotHeader','getSnapshotMessages']);
let repo,sequence=0,tail=Promise.resolve(),browser;
async function fixture(method,args) {
  if(method==='reset'){repo?.close();repo=new SqliteRepository(path.join(directory,`case-${++sequence}.sqlite`));return true;}
  if(!repo)throw new Error('Fixture not initialized');
  if(method==='reopen'){repo.close();repo=new SqliteRepository(path.join(directory,`case-${sequence}.sqlite`));return true;}
  if(allowed.has(method))return repo.batchTransfer[method](...args);
  if(method==='normal'){
    const [operation,...values]=args;if(!normalAllowed.has(operation))throw new Error('Fixture operation unavailable');return repo.execute(operation,values);
  }
  if(method==='peek'){
    const [area]=args;if(area!==0&&area!==1)throw new Error('Invalid fixture area');
    const result=Object.fromEntries(['chat_meta','recent_messages','pending_changes','full_messages','historical_changes','snapshots','snapshot_messages'].map(name=>[name,[]]));
    for(const row of repo.db.prepare(`SELECT store,payload FROM ${area===0?'records':'records_next'} ORDER BY store,primary_key`).all())result[row.store].push(decodeStorageValue(JSON.parse(row.payload)));return result;
  }
  if(method==='activate')return repo.changeDataset('commit',...args);
  if(method==='unlock'){
    const [id]=args,key='transfer:'+id,row=repo.db.prepare('SELECT value FROM plugin_meta WHERE key=?').get(key),state=JSON.parse(row.value);
    if(state.phase!=='committed')throw new Error('Fixture unlock requires committed task');
    repo.db.prepare('UPDATE plugin_meta SET value=? WHERE key=?').run(JSON.stringify({...state,phase:'finished'}),key);
    repo.db.prepare("DELETE FROM plugin_meta WHERE key='transfer-lock'").run();return true;
  }
  throw new Error('Fixture method unavailable');
}
const server=http.createServer((req,res)=>{
  const run=tail.then(async()=>{
    try {
      const pathname=new URL(req.url,'http://127.0.0.1').pathname;
      if(pathname==='/transfer-batch-contract') {
        res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><script type="module">import {runTransferBatchContract} from '/tests/browser/transfer-batch-contract.js';globalThis.runTransferBatchContract=()=>runTransferBatchContract(${JSON.stringify(nonce)});</script>`);return;
      }
      if(pathname==='/test-batch'&&req.method==='POST') {
        if(req.headers['x-boxed-test-nonce']!==nonce||req.headers.origin!==`http://127.0.0.1:${server.address().port}`)throw new Error('Fixture origin mismatch');
        const chunks=[];let bytes=0;
        for await(const chunk of req){bytes+=chunk.length;if(bytes>16*1024*1024)throw new Error('Fixture request too large');chunks.push(chunk);}
        const body=JSON.parse(Buffer.concat(chunks).toString('utf8')),value=await fixture(body.method,decodeStorageValue(body.args));
        if(body.dropResponse){res.destroy();return;}
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,value:encodeStorageValue(value)}));return;
      }
      const target=path.resolve(root,'.'+pathname),relative=path.relative(root,target);
      if(relative.startsWith('..')||path.isAbsolute(relative)||!pathname.endsWith('.js')||!/^\/(src|tests\/browser)\//.test(pathname)){res.writeHead(404).end();return;}
      res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(await fs.readFile(target));
    }catch(error){if(!res.destroyed){res.setHeader('Content-Type','application/json');res.statusCode=409;res.end(JSON.stringify({ok:false,message:error.message}));}}
  });tail=run.catch(()=>{});
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try {
  browser=await chromium.launch({headless:true,...(process.env.BOXED_BROWSER_PATH?{executablePath:process.env.BOXED_BROWSER_PATH}:{channel:'msedge'})});
  const context=await browser.newContext(),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/transfer-batch-contract`);
  await page.waitForFunction(()=>typeof globalThis.runTransferBatchContract==='function');
  const result=await page.evaluate(()=>globalThis.runTransferBatchContract());assert.deepEqual(errors,[]);
  console.log(JSON.stringify({...result,browser:browser.version(),pageErrors:errors},null,2));
}finally{
  await browser?.close();await new Promise(resolve=>server.close(resolve));repo?.close();
  const resolved=await fs.realpath(directory);assert.equal(path.dirname(resolved),tempRoot);assert.ok(path.basename(resolved).startsWith('boxed-batch-browser-'));await fs.rm(resolved,{recursive:true});
}
