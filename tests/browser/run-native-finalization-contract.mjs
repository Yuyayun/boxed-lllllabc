import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import assert from 'node:assert/strict';

const root=process.cwd(),older=process.env.BOXED_AUDIT_OLDER==='1',runtime=path.join(root,older?'.local-test/runtime-1.15.0-accepted':'.local-test/runtime/SillyTavern');
const audit=path.join(root,'.local-test/yellow-fix-20261125'),run=path.join(audit,(older?'1.15.0-':'1.19.0-')+randomUUID());
const data=path.join(run,'data'),config=path.join(run,'config.yaml'),port=older?18109:18108;
await fs.mkdir(run,{recursive:true});
await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(port,'127.0.0.1',()=>server.close(resolve));});
for(const file of ['index.js','style.css','settings.html','manifest.json','package.json','src','styles'])await fs.cp(path.join(root,file),path.join(runtime,'public/scripts/extensions/third-party/boxed-lllllabc',file),{recursive:true,force:true});
for(const file of ['index.mjs','package.json','src','vendor'])await fs.cp(path.join(root,'.local-test/boxed-lllllabc-server-dev',file),path.join(runtime,'plugins/boxed-lllllabc-server',file),{recursive:true,force:true});
let yaml=await fs.readFile(path.join(runtime,'default/config.yaml'),'utf8');
yaml=yaml.replace(/^dataRoot:.*$/m,`dataRoot: ${data.replaceAll('\\','/')}`).replace(/^port:.*$/m,`port: ${port}`)
 .replace(/^enableServerPlugins:.*$/m,'enableServerPlugins: true').replace(/^enableServerPluginsAutoUpdate:.*$/m,'enableServerPluginsAutoUpdate: false');
yaml+=`\nboxedLllllabc:\n  databaseDirectory: ${path.join(run,'sqlite').replaceAll('\\','/')}\n`;await fs.writeFile(config,yaml);
const settings=JSON.parse(await fs.readFile(path.join(runtime,'default/content/settings.json'),'utf8'));
settings.firstRun=false;settings.main_api='openai';settings.extension_settings??={};settings.extension_settings['boxed-lllllabc']={enabled:false};
await fs.mkdir(path.join(data,'default-user'),{recursive:true});await fs.writeFile(path.join(data,'default-user/settings.json'),JSON.stringify(settings));
const child=spawn(path.join(root,'.local-test/runtime/node.exe'),['server.js','--configPath',config,'--dataRoot',data,'--port',String(port),'--listen','false','--browserLaunchEnabled','false'],{cwd:runtime,windowsHide:true,env:{...process.env,NODE_ENV:'production'},stdio:['ignore','pipe','pipe']});
const logs=[];child.stdout.on('data',chunk=>logs.push(String(chunk)));child.stderr.on('data',chunk=>logs.push(String(chunk)));
 let browser,browserServer,watchdog,lastStage,provider;
try{
 const deadline=Date.now()+60000;while(Date.now()<deadline){if(child.exitCode!==null)throw new Error('native exited '+logs.join('').slice(-2000));if(await fetch(`http://127.0.0.1:${port}/csrf-token`).then(r=>r.ok).catch(()=>false))break;await new Promise(resolve=>setTimeout(resolve,200));}
 const {chromium,webkit}=await import(pathToFileURL(process.env.BOXED_PLAYWRIGHT_PATH).href),engine=process.env.BOXED_AUDIT_BROWSER==='webkit'?webkit:chromium;
 browserServer=await engine.launchServer({headless:true,...(engine===chromium?{channel:'msedge'}:{})});browser=await engine.connect(browserServer.wsEndpoint());
 const context=await browser.newContext({viewport:{width:1200,height:800}}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 let generated=0;
 provider=http.createServer(async(request,response)=>{
  response.setHeader('Access-Control-Allow-Origin',`http://127.0.0.1:${port}`);response.setHeader('Access-Control-Allow-Credentials','true');response.setHeader('Access-Control-Allow-Headers','content-type,x-csrf-token');
  if(request.method==='OPTIONS'){response.end();return;}
  let body='';for await(const chunk of request)body+=chunk;
  const input=JSON.parse(body),number=++generated,delay=Number(process.env.BOXED_AUDIT_GENERATE_DELAY??0);
  const pause=()=>new Promise(resolve=>setTimeout(resolve,delay));
  if(input.stream){
   response.writeHead(200,{'Content-Type':'text/event-stream'});
   for(const content of ['isolated native ',`response ${number}`]){await pause();response.write(`data: ${JSON.stringify({choices:[{index:0,delta:{content}}]})}\n\n`);}
   await pause();response.end('data: [DONE]\n\n');
  }else{await pause();response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({choices:[{index:0,message:{role:'assistant',content:'isolated native response '+number},finish_reason:'stop'}]}));}
 });
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
 await page.route('**/api/backends/chat-completions/generate',async route=>{
  return route.continue({url:`http://127.0.0.1:${provider.address().port}/generate`});
 });
 await page.route('**/yellow-audit.js',async route=>route.fulfill({contentType:'text/javascript',body:await fs.readFile(path.join(root,'tests/browser/native-finalization-contract.js'),'utf8')}));
 await page.route('**/boxed-yellow-release/src/**',async route=>{
  const relative=new URL(route.request().url()).pathname.split('/boxed-yellow-release/')[1];
  assert(relative.startsWith('src/')&&!relative.split('/').includes('..'));
  await route.fulfill({contentType:'text/javascript',body:await fs.readFile(path.join(root,'.local-test/boxed-lllllabc-frontend-dev',relative),'utf8')});
 });
 let blockSave=false;
 await page.route('**/api/chats/save',route=>blockSave?route.fulfill({status:503,contentType:'application/json',body:'{"error":"isolated audit save block"}'}):route.continue());
 await page.exposeFunction('auditBlockSave',value=>{blockSave=value;});
 await page.exposeFunction('auditDisk',async({avatar,name,current,expectedEqual=true})=>{
  const file=path.join(data,'default-user/chats',avatar.replace(/\.png$/i,''),name+'.jsonl');
  const rows=(await fs.readFile(file,'utf8')).trim().split('\n').map(JSON.parse);if(expectedEqual)assert.deepEqual(rows.slice(1),current);else assert.notDeepEqual(rows.slice(1),current);return {currentMatchesSavedFile:expectedEqual,messages:rows.length-1,bytes:(await fs.stat(file)).size};
 });
 await page.route('**/script.js',async route=>{
  if(new URL(route.request().url()).pathname!=='/script.js')return route.continue();
  const script=await fs.readFile(path.join(runtime,'public/script.js'),'utf8'),ready='await eventSource.emit(event_types.APP_READY);';
  assert(script.includes(ready));
  await route.fulfill({contentType:'text/javascript',body:script.replace(ready,ready+'globalThis.boxedNativeFixtureReady=true;')+'\nexport { StreamingProcessor as BoxedFixtureStreamingProcessor };\n'});
 });
 await page.exposeFunction('finalizationProgress',row=>{lastStage=row;console.log(JSON.stringify(row));});
 await page.exposeFunction('auditTrace',async row=>{await fs.appendFile(path.join(run,'trace.jsonl'),JSON.stringify(row)+'\n');});
 await page.goto(`http://127.0.0.1:${port}/`);await page.waitForFunction(()=>Boolean(globalThis.boxedLllllabcDebug&&globalThis.boxedNativeFixtureReady),null,{timeout:45000});
 const result=await Promise.race([page.evaluate(async options=>(await import('/yellow-audit.js')).runNativeFinalizationContract(options),{scenarios:process.env.BOXED_FINALIZATION_SCENARIOS?.split(','),modes:process.env.BOXED_AUDIT_MODES?.split(',')}),new Promise((_,reject)=>{watchdog=setTimeout(()=>reject(new Error('Native finalization test timed out: '+JSON.stringify(lastStage))),Number(process.env.BOXED_AUDIT_TIMEOUT_MS??120000));})]);
 assert.deepEqual(errors,[]);assert.equal(generated,result.filter(row=>row.scenario.startsWith('swipe')).length*2,'existing swipe switches must not generate extra replies');await fs.writeFile(path.join(run,'results.json'),JSON.stringify({browser:process.env.BOXED_AUDIT_BROWSER??'edge',generated,delayMs:Number(process.env.BOXED_AUDIT_GENERATE_DELAY??0),result,errors},null,2));await page.screenshot({path:path.join(run,'last-state.png')});
 console.log(JSON.stringify({run,result,errors}));
}finally{
 clearTimeout(watchdog);browserServer?.process()?.kill('SIGKILL');await browser?.close().catch(()=>{});await browserServer?.kill().catch(()=>{});provider?.closeAllConnections();await new Promise(resolve=>provider?provider.close(resolve):resolve());child.kill();await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));await fs.writeFile(path.join(run,'server.log'),logs.join(''));
}
