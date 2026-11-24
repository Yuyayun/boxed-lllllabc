import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=process.cwd(),backend=path.resolve('.local-test/boxed-lllllabc-server-dev'),temp=await fs.mkdtemp(path.join(os.tmpdir(),'boxed-completed-upgrade-')),nonce=randomUUID();
let routes,handlers,oldTag,currentCase,browser,offline=false;const files=new Map();let transferRequests=0;
async function snapshot(tag){
 const target=path.join(temp,'server-'+tag);await fs.mkdir(target,{recursive:true});
 const list=execFileSync('git',['-c','safe.directory='+backend,'ls-tree','-r','--name-only',tag],{cwd:backend,encoding:'utf8'}).trim().split('\n').filter(file=>file==='package.json'||file.startsWith('src/')||file.startsWith('vendor/'));
 for(const file of list){const dest=path.join(target,file);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,execFileSync('git',['-c','safe.directory='+backend,'show',tag+':'+file],{cwd:backend,maxBuffer:4*1024*1024}));}return target;
}
const snapshots=new Map();for(const tag of ['v1.0.0','v1.0.1'])snapshots.set(tag,await snapshot(tag));
async function activate(tag){
 await routes?.close();handlers=new Map();const serverRoot=snapshots.get(tag)??backend;
 const {installRoutes}=await import(pathToFileURL(path.join(serverRoot,'src/router.js')));
 const host={root:currentCase,dataRoot:path.join(currentCase,'data'),defaultHandle:'default-user',users:async()=>[],csrfEnabled:()=>true,config:(key,fallback)=>key==='boxedLllllabc.databaseDirectory'?path.join(currentCase,'storage'):key==='enableUserAccounts'?false:fallback};
 routes=installRoutes({get:(name,fn)=>handlers.set('GET '+name,fn),post:(name,fn)=>handlers.set('POST '+name,fn)},{host});
}
const server=http.createServer(async(req,res)=>{
 const pathname=new URL(req.url,'http://127.0.0.1').pathname;
 try{
  if(pathname.startsWith('/api/plugins/boxed-lllllabc/')){
   if(req.headers['x-test-nonce']!==nonce){res.writeHead(403).end();return;}
   const chunks=[];for await(const chunk of req)chunks.push(chunk);req.body=chunks.length?JSON.parse(Buffer.concat(chunks)):undefined;req.protocol='http';req.get=name=>req.headers[name.toLowerCase()];req.user={profile:{handle:'default-user',enabled:true}};req.session={handle:'default-user'};
   if(pathname.endsWith('/transfer')||pathname.endsWith('/batch-transfer'))transferRequests++;
   res.set=(key,value)=>res.setHeader(key,value);res.status=code=>{res.statusCode=code;return res;};res.json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
   if(offline){res.status(503).json({protocol:6,ok:false,code:'database-unavailable',reason:'fixture: SQLite 暂不可用'});return;}
   const handler=handlers.get(req.method+' '+pathname.slice('/api/plugins/boxed-lllllabc'.length));if(!handler){res.writeHead(404).end();return;}await handler(req,res);return;
  }
  if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<meta name="viewport" content="width=device-width"><textarea id="chat-input"></textarea><button id="update-button">更新前端</button><p id="boxed-lllllabc-transfer-result"></p><p id="boxed-lllllabc-clear-result"></p>');return;}
  const old=pathname.startsWith('/old/'),relative=old?pathname.slice(5):pathname.slice(1);if(!/^(src|tests\/browser)\/[a-zA-Z0-9_./-]+\.js$/.test(relative)||relative.split('/').includes('..')){res.writeHead(404).end();return;}
  res.setHeader('Content-Type','text/javascript');if(old){const key=oldTag+':'+relative;if(!files.has(key))files.set(key,execFileSync('git',['show',key],{cwd:root,maxBuffer:4*1024*1024}));res.end(files.get(key));}else res.end(await fs.readFile(path.join(root,relative)));
 }catch(error){if(!res.headersSent)res.writeHead(500).end(error.message);else res.destroy(error);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const {chromium}=await import(pathToFileURL(process.env.BOXED_PLAYWRIGHT_PATH));const reports=[];
try{
 browser=await chromium.launch({headless:true,channel:'msedge'});
 for(const [from,to] of [['v1.0.0','v1.0.1'],['v1.0.0','current'],['v1.0.1','current']]){
  currentCase=path.join(temp,from+'-to-'+to);await fs.mkdir(path.join(currentCase,'storage'),{recursive:true});oldTag=from;await activate(from);const context=await browser.newContext(),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const load=async()=>{await page.goto(`http://127.0.0.1:${server.address().port}`);await page.evaluate(async nonce=>(await import('/tests/browser/completed-upgrade-contract.js')).installCompletedUpgradeFixture({nonce}),nonce);};
  try{
   await load();const completed=await page.evaluate(()=>completedUpgrade.complete());
   await activate(to);transferRequests=0;
   const live=await page.evaluate(()=>completedUpgrade.startOld());await load();const reloaded=await page.evaluate(()=>completedUpgrade.startOld());assert.equal(transferRequests,0,'已完成迁移在后端更新后被重新搬运或恢复');
   if(from==='v1.0.0'){assert.equal(live.health.code,'protocol-incompatible');assert.equal(reloaded.health.code,'protocol-incompatible');}else{assert.equal(live.health.ok,true);assert.equal(reloaded.health.ok,true);}
   offline=true;const unavailable=await page.evaluate(()=>completedUpgrade.startOld()),latestOffline=await page.evaluate(()=>completedUpgrade.latest({read:false}));offline=false;assert.equal(transferRequests,0,'连接失败不能自动重建已完成任务');await page.locator('#chat-input').fill('迁移已完成，页面仍可操作');await page.locator('#update-button').click();
   const latest=await page.evaluate(()=>completedUpgrade.latest());assert.equal(transferRequests,0,'更新前端后不应重跑已完成迁移');assert.deepEqual(errors,[]);
   const noRepeatTransferRequests=transferRequests,reconciled=await page.evaluate(()=>completedUpgrade.reconcileFinishedReceipt());assert.deepEqual(errors,[]);
   reports.push({from,to,completed,live,reloaded,unavailable,latestOffline,latest,noRepeatTransferRequests,reconciled,pageErrors:errors});
  }finally{offline=false;await context.close();}
 }
 console.log(JSON.stringify(reports,null,2));await fs.writeFile(path.join(root,'.local-test/review-1.0.5-20261124/completed-upgrade-report.json'),JSON.stringify(reports,null,2));
}finally{await browser?.close();await routes?.close();await new Promise(resolve=>server.close(resolve));const resolved=await fs.realpath(temp);assert.equal(path.dirname(resolved),await fs.realpath(os.tmpdir()));assert(path.basename(resolved).startsWith('boxed-completed-upgrade-'));await fs.rm(resolved,{recursive:true});}
