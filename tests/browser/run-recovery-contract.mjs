import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { encodeStorageValue, decodeStorageValue } from '../../src/storage/protocol.js';

if(!process.env.BOXED_SERVER_REPOSITORY)throw new Error('Set BOXED_SERVER_REPOSITORY');
const backend=process.env.BOXED_SERVER_REPOSITORY;
const {installRoutes}=await import(pathToFileURL(path.join(backend,'src/router.js')).href);
const {SqliteWorker}=await import(pathToFileURL(path.join(backend,'src/worker-client.js')).href);
const {SqliteRepository}=await import(pathToFileURL(path.join(backend,'src/sqlite.js')).href);
const {chromium}=await import(process.env.BOXED_PLAYWRIGHT_PATH?pathToFileURL(process.env.BOXED_PLAYWRIGHT_PATH).href:'playwright');
const root=fileURLToPath(new URL('../../',import.meta.url)),tempRoot=await fs.realpath(os.tmpdir()),directory=await fs.mkdtemp(path.join(tempRoot,'boxed-formal-browser-')),nonce=randomUUID();
let routes,handlers,worker,file,index=0,browser;
async function install(reset=false) {
  await routes?.close();if(reset)index++;
  const instance=path.join(directory,'case-'+index),storage=path.join(instance,'boxed-storage');await fs.mkdir(storage,{recursive:true});file=path.join(storage,'boxed-lllllabc.sqlite');
  handlers=new Map();
  const router={get:(url,fn)=>handlers.set('GET '+url,fn),post:(url,fn)=>handlers.set('POST '+url,fn)};
  const host={root:instance,dataRoot:path.join(instance,'data'),defaultHandle:'default-user',users:async()=>[],csrfEnabled:()=>true,config:(key,fallback)=>key==='boxedLllllabc.databaseDirectory'?storage:key==='enableUserAccounts'?false:fallback};
  routes=installRoutes(router,{host,createWorker:database=>worker=new SqliteWorker(database)});
}
const server=http.createServer(async(req,res)=>{
  try{
    const pathname=new URL(req.url,'http://127.0.0.1').pathname;
    if(pathname==='/settings.html'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await fs.readFile(path.join(root,'settings.html')));return;}
    if(pathname==='/recovery-contract'){
      res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tavern/style.css"><link rel="stylesheet" href="/styles/settings.css"><link rel="stylesheet" href="/styles/runtime-log.css"><link rel="stylesheet" href="/styles/storage-switch.css"><style>body{font-family:system-ui,sans-serif;font-size:16px}#boxed-lllllabc-transfer-dialog{overflow-wrap:anywhere}</style><body><script type="module">import {installRecoveryContract} from '/tests/browser/recovery-contract.js';installRecoveryContract(${JSON.stringify(nonce)});</script></body></html>`);return;
    }
    if(pathname==='/fixture'||pathname.startsWith('/api/plugins/boxed-lllllabc/')){
      if(req.headers['x-test-nonce']!==nonce)throw new Error('Fixture nonce mismatch');
      const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>16*1024*1024)throw new Error('Body limit');chunks.push(chunk);}
      const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):undefined;
      if(pathname==='/fixture'){
        const args=decodeStorageValue(body.args);let result;
        if(body.method==='reset'){await install(true);result=true;}
        else if(body.method==='restart-worker'){
          if(worker){worker.fail(Object.assign(new Error('fixture-process-exit'),{code:'database-unavailable'}));await worker.worker.terminate();}
          await install(false);result=true;
        }else{
          const repo=new SqliteRepository(file,{readOnly:body.method!=='mutate-source'});
          try{
            if(body.method==='peek'){
              const area=args[0];if(area!==0&&area!==1)throw new Error('Area mismatch');result=Object.fromEntries(['chat_meta','recent_messages','pending_changes','full_messages','historical_changes','snapshots','snapshot_messages'].map(n=>[n,[]]));
              for(const row of repo.db.prepare(`SELECT store,payload FROM ${area===0?'records':'records_next'} ORDER BY store,primary_key`).all())result[row.store].push(decodeStorageValue(JSON.parse(row.payload)));
            }else if(body.method==='mutate-source'){
              repo.db.prepare("UPDATE records SET payload=? WHERE store='chat_meta'").run(JSON.stringify(encodeStorageValue({chatKey:'source',changedDuringRestart:true})));result=true;
            }else throw new Error('Fixture method mismatch');
          }finally{repo.close();}
        }
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,value:encodeStorageValue(result)}));return;
      }
      const route=handlers.get(req.method+' '+pathname.slice('/api/plugins/boxed-lllllabc'.length));if(!route){res.writeHead(404).end();return;}
      req.body=body;req.protocol='http';req.get=name=>req.headers[name.toLowerCase()];req.user={profile:{handle:'default-user',enabled:true}};req.session={handle:'default-user'};
      res.set=(name,value)=>res.setHeader(name,value);res.status=code=>{res.statusCode=code;return res;};res.json=value=>{if(req.headers['x-test-drop']==='1'){res.destroy();return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
      const originalWrite=res.write.bind(res);res.write=(chunk,...args)=>{if(req.headers['x-test-drop']==='1'&&String(chunk).includes('"type":"result"')){res.destroy();return false;}return originalWrite(chunk,...args);};
      await route(req,res);return;
    }
    let base=root,relativeUrl=pathname;
    if(pathname.startsWith('/tavern/')){
      if(!process.env.BOXED_TAVERN_PUBLIC){res.writeHead(404).end();return;}base=process.env.BOXED_TAVERN_PUBLIC;relativeUrl=pathname.slice('/tavern'.length);
    }else if(!/^\/(src|tests\/browser|styles)\//.test(pathname)){res.writeHead(404).end();return;}
    const target=path.resolve(base,'.'+relativeUrl),relative=path.relative(base,target);if(relative.startsWith('..')||path.isAbsolute(relative)){res.writeHead(404).end();return;}
    const extension=path.extname(target).toLowerCase(),types={'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.png':'image/png','.svg':'image/svg+xml'};
    if(!types[extension]){res.writeHead(404).end();return;}res.setHeader('Content-Type',types[extension]);res.end(await fs.readFile(target));
  }catch(error){if(!res.destroyed){res.statusCode=409;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:false,message:error.message}));}}
});
await install(true);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const results=[],uiChecks=[];
try{
  browser=await chromium.launch({headless:true,...(process.env.BOXED_BROWSER_PATH?{executablePath:process.env.BOXED_BROWSER_PATH}:{channel:'msedge'})});
  const context=await browser.newContext(),page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  const url=`http://127.0.0.1:${server.address().port}/recovery-contract`;
  const load=async()=>{await page.goto(url);await page.waitForFunction(()=>!!globalThis.recoveryContract);};await load();
  if(!process.env.BOXED_UI_ONLY){
  assert.equal(await page.evaluate(()=>recoveryContract.protocolMismatch()),true);
  assert.equal(await page.evaluate(()=>recoveryContract.controlSchemaTest()),true);
  for(const from of ['indexeddb','sqlite'])for(const stage of ['inventory','append','batch-verified','committed','activated','finish-target','release-target']){
    await page.evaluate(({from,stage})=>recoveryContract.start(from,stage),{from,stage});
    await page.evaluate(()=>recoveryContract.restartWorker());await load();
    const result=await page.evaluate(cancelled=>recoveryContract.recover({cancelled}),stage==='inventory');results.push({from,stage,...result});
  }
  for(const from of ['indexeddb','sqlite']){
    await page.evaluate(from=>recoveryContract.start(from,'committed'),from);await page.evaluate(()=>recoveryContract.mutateSource());await page.evaluate(()=>recoveryContract.restartWorker());await load();
    const result=await page.evaluate(()=>recoveryContract.recover({cancelled:true}));results.push({from,stage:'source-mutated-after-commit',...result});
  }
  await page.evaluate(()=>recoveryContract.start('indexeddb',null,{lostCommit:true}));await load();results.push({stage:'HTTP-commit-response-lost',...await page.evaluate(()=>recoveryContract.recover())});
  assert.equal((await page.evaluate(()=>recoveryContract.pauseTest())).cancelled,true);
  }
  for(const viewport of [{width:1024,height:900},{width:390,height:760}]){
    await page.setViewportSize(viewport);await page.evaluate(()=>recoveryContract.uiCase());
    const dialog=page.locator('#boxed-lllllabc-transfer-dialog');await dialog.waitFor();
    const geometry=await dialog.evaluate(node=>({width:node.getBoundingClientRect().width,client:node.clientWidth,scroll:node.scrollWidth,text:node.textContent,buttons:[...node.querySelectorAll('button')].map(b=>({text:b.textContent,disabled:b.disabled}))}));
    assert.ok(geometry.scroll<=geometry.client+1);assert.match(geometry.text,/继续核对并恢复/);uiChecks.push({viewport,geometry});
    if(process.env.BOXED_TEST_OUTPUT){await fs.mkdir(process.env.BOXED_TEST_OUTPUT,{recursive:true});await page.screenshot({path:path.join(process.env.BOXED_TEST_OUTPUT,`recovery-${viewport.width}.png`)});}
    await page.getByRole('button',{name:'放弃本次迁移',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'确认放弃并撤销'}).isDisabled(),true);
    await page.locator('dialog input[type=checkbox]').check();await page.getByRole('button',{name:'确认放弃并撤销'}).click();await page.waitForFunction(()=>globalThis.recoveryUiFinished);
    assert.equal((await page.evaluate(()=>recoveryContract.state())).journal,null);
  }
  await page.evaluate(()=>recoveryContract.uiCase('indexeddb','activated'));assert.equal(await page.getByRole('button',{name:'放弃本次迁移',exact:true}).count(),0);
  await page.getByRole('button',{name:'继续完成收尾'}).click();await page.waitForFunction(()=>globalThis.recoveryUiFinished);
  for(const viewport of [{width:1024,height:900},{width:390,height:760}]){
    await page.setViewportSize(viewport);await page.evaluate(()=>recoveryContract.logCase());
    const root=page.locator('#boxed-lllllabc-runtime-logs');assert.equal(await root.isVisible(),false);
    await page.evaluate(()=>recoveryContract.logConnection(true));assert.equal(await root.isVisible(),true);assert.equal(await root.getAttribute('open'),null);
    await root.locator('summary').click();await page.waitForFunction(()=>document.querySelector('[data-log-message]').textContent.startsWith('本页'));
    assert.match(await root.locator('textarea').inputValue(),/injected/);
    await root.locator('select').selectOption('all');await page.waitForFunction(()=>document.querySelector('[data-log-message]').textContent.includes('本页 50 条'));
    await page.getByRole('button',{name:'复制当前页'}).click();await page.waitForFunction(()=>document.querySelector('[data-log-message]').textContent.includes('已复制'));assert.equal(await page.evaluate(()=>globalThis.copiedLogs),await root.locator('textarea').inputValue());
    await page.getByRole('button',{name:'更早记录'}).click();await page.waitForFunction(()=>document.querySelector('[data-log-message]').textContent.includes('已到最早'));assert.ok((await root.locator('textarea').inputValue()).split('\n').length<=50);
    const geometry=await root.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));assert.ok(geometry.scroll<=geometry.client+1);uiChecks.push({viewport,logGeometry:geometry});
    if(process.env.BOXED_TEST_OUTPUT)await page.screenshot({path:path.join(process.env.BOXED_TEST_OUTPUT,`logs-${viewport.width}.png`)});
    await page.evaluate(()=>recoveryContract.logConnection(false));assert.equal(await root.isVisible(),true);assert.match(await root.locator('[data-log-message]').textContent(),/无法读取/);
    await page.evaluate(()=>recoveryContract.logRecreate());assert.equal(await root.isVisible(),true);
    await page.evaluate(()=>recoveryContract.logConnection(true));assert.equal(await page.getByRole('button',{name:'清理已结束日志'}).isDisabled(),true);await root.locator('input').check();await page.getByRole('button',{name:'清理已结束日志'}).click();await page.waitForFunction(()=>document.querySelector('[data-log-message]').textContent.startsWith('已清理'));
    assert.equal(await page.evaluate(()=>recoveryContract.logRemaining()),true);
    await page.evaluate(()=>recoveryContract.logOpen());await page.locator('#boxed-lllllabc-log-dialog').waitFor();await page.getByRole('button',{name:'返回',exact:true}).click();await root.locator('[data-log-body]').waitFor();assert.equal(await root.locator('[data-log-body]').count(),1);
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({results,uiChecks,browser:browser.version(),pageErrors:errors},null,2));
}finally{
  await browser?.close();await routes?.close();await new Promise(resolve=>server.close(resolve));
  const resolved=await fs.realpath(directory);assert.equal(path.dirname(resolved),tempRoot);assert.ok(path.basename(resolved).startsWith('boxed-formal-browser-'));await fs.rm(resolved,{recursive:true});
}
