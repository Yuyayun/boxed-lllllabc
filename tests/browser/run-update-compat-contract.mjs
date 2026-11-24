import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=process.cwd(),serverRoot=path.resolve(process.env.BOXED_SERVER_REPOSITORY??'.local-test/boxed-lllllabc-server-dev'),nonce=randomUUID(),oldFiles=new Map();
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'boxed-update-compat-')),handlers=new Map();await fs.mkdir(path.join(directory,'storage'));
const {installRoutes}=await import(pathToFileURL(path.join(serverRoot,'src/router.js')));
const host={root:directory,dataRoot:path.join(directory,'data'),defaultHandle:'default-user',users:async()=>[],csrfEnabled:()=>true,config:(key,fallback)=>key==='boxedLllllabc.databaseDirectory'?path.join(directory,'storage'):key==='enableUserAccounts'?false:fallback};
const routes=installRoutes({get:(name,fn)=>handlers.set('GET '+name,fn),post:(name,fn)=>handlers.set('POST '+name,fn)},{host});
const server=http.createServer(async(request,response)=>{
 const pathname=new URL(request.url,'http://127.0.0.1').pathname;
 try{
  if(pathname.startsWith('/api/plugins/boxed-lllllabc/')) {
   if(request.headers['x-test-nonce']!==nonce){response.writeHead(403).end();return;}
   const chunks=[];for await(const chunk of request)chunks.push(chunk);request.body=chunks.length?JSON.parse(Buffer.concat(chunks)):undefined;request.protocol='http';request.get=name=>request.headers[name.toLowerCase()];request.user={profile:{handle:'default-user',enabled:true}};request.session={handle:'default-user'};
   response.set=(key,value)=>response.setHeader(key,value);response.status=code=>{response.statusCode=code;return response;};response.json=value=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify(value));};
   const handler=handlers.get(request.method+' '+pathname.slice('/api/plugins/boxed-lllllabc'.length));if(!handler){response.writeHead(404).end();return;}await handler(request,response);return;
  }
  if(pathname==='/'){response.setHeader('Content-Type','text/html');response.end('<meta name="viewport" content="width=device-width"><button id="host-button">酒馆操作</button>');return;}
  const old=pathname.startsWith('/old/'),relative=(old?pathname.slice(5):pathname.slice(1));
  if(!/^(src|tests)\/[a-zA-Z0-9_./-]+\.js$/.test(relative)||relative.split('/').includes('..')){response.writeHead(404).end();return;}
  response.setHeader('Content-Type','text/javascript');
  if(old){if(!oldFiles.has(relative))oldFiles.set(relative,execFileSync('git',['show','main:'+relative],{cwd:root,maxBuffer:4*1024*1024}));response.end(oldFiles.get(relative));}
  else response.end(await fs.readFile(path.join(root,relative)));
 }catch(error){if(!response.headersSent)response.writeHead(500).end(error.message);else response.destroy(error);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const {chromium}=await import(pathToFileURL(process.env.BOXED_PLAYWRIGHT_PATH));let browser;
try{
 browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
 const checks=await page.evaluate(async nonce=>(await import('/tests/browser/update-compat-contract.js')).runUpdateCompatibilityContract({nonce}),nonce);
 assert.deepEqual(errors,[]);assert.equal(checks.length,6);await page.locator('#host-button').click();console.log(JSON.stringify({checks,pageErrors:errors,hostInteractive:true}));
}finally{await browser?.close();await routes.close();await new Promise(resolve=>server.close(resolve));const resolved=await fs.realpath(directory);assert.equal(path.dirname(resolved),await fs.realpath(os.tmpdir()));assert(path.basename(resolved).startsWith('boxed-update-compat-'));await fs.rm(resolved,{recursive:true});}
