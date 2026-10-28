import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';

const front=fileURLToPath(new URL('../../',import.meta.url)),run=promisify(execFile),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
if(!process.env.BOXED_STAGE5_ROOT)throw new Error('Set BOXED_STAGE5_ROOT to a freshly prepared disposable host tree');
const root=await fs.realpath(process.env.BOXED_STAGE5_ROOT),prepared=JSON.parse(await fs.readFile(path.join(root,'prepared.json'),'utf8'));
assert.equal(await fs.realpath(prepared.root),root);assert.ok(path.basename(root).startsWith('1.0.1-stage5-'));assert.equal(path.dirname(root),await fs.realpath(path.join(front,'.local-test')));
const backend=process.env.BOXED_SERVER_REPOSITORY??path.join(front,'.local-test/boxed-lllllabc-server-dev');
const {chromium}=await import(process.env.BOXED_PLAYWRIGHT_PATH?pathToFileURL(process.env.BOXED_PLAYWRIGHT_PATH).href:'playwright');
const cases=JSON.parse(process.env.BOXED_STAGE5_CASES??'[{"name":"479MiB","version":"1.15.0","bodyBytes":502477620},{"name":"1GiB","version":"1.15.0","bodyBytes":1073741824}]');
const origin='http://127.0.0.1:18101',results=[];
async function freePort(){const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(18101,'127.0.0.1',resolve);});await new Promise(resolve=>server.close(resolve));}
async function directoryBytes(directory){let total=0,entries;try{entries=await fs.readdir(directory,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return 0;throw error;}for(const entry of entries){const file=path.join(directory,entry.name);if(entry.isDirectory())total+=await directoryBytes(file);else if(entry.isFile())try{total+=(await fs.stat(file)).size;}catch(error){if(error.code!=='ENOENT')throw error;}}return total;}
async function syncSources(runtime){
  const extension=path.join(runtime,'public/scripts/extensions/third-party/boxed-lllllabc'),plugin=path.join(runtime,'plugins/boxed-lllllabc-server');
  for(const name of ['index.js','manifest.json','settings.html','style.css','package.json','LICENSE','README.md','CHANGELOG.md'])await fs.copyFile(path.join(front,name),path.join(extension,name));
  for(const name of ['src','styles'])await fs.cp(path.join(front,name),path.join(extension,name),{recursive:true,force:true});
  for(const name of ['index.mjs','package.json','LICENSE'])await fs.copyFile(path.join(backend,name),path.join(plugin,name));
  for(const name of ['src','vendor'])await fs.cp(path.join(backend,name),path.join(plugin,name),{recursive:true,force:true});
}
async function sourceHashes(directory,names){const hashes={};async function visit(relative){const file=path.join(directory,relative),stat=await fs.stat(file);if(stat.isDirectory()){for(const name of await fs.readdir(file))await visit(path.join(relative,name));}else hashes[relative.replaceAll('\\','/')]=createHash('sha256').update(await fs.readFile(file)).digest('hex');}for(const name of names)await visit(name);return hashes;}
for(const config of cases){
  assert.match(config.name,/^[a-zA-Z0-9_-]+$/);assert.ok(['1.15.0','1.19.0'].includes(config.version));assert.ok(Number.isSafeInteger(config.bodyBytes)&&config.bodyBytes>0);
  const runtime=path.join(root,'runtime-'+config.version),caseRoot=path.join(root,'cases',config.name+'-'+Date.now()),data=path.join(caseRoot,'data'),storage=path.join(caseRoot,'boxed-storage'),profile=path.join(caseRoot,'browser-profile'),nonce=randomUUID();
  await fs.mkdir(storage,{recursive:true});await fs.mkdir(data,{recursive:true});await syncSources(runtime);
  const publicDir=path.join(runtime,'public/boxed-stage5');await fs.mkdir(publicDir,{recursive:true});await fs.copyFile(path.join(front,'tests/browser/large-migration-contract.js'),path.join(publicDir,'large-migration-contract.js'));await fs.writeFile(path.join(publicDir,'authorization.json'),JSON.stringify({purpose:'boxed-stage5-disposable',nonce}));
  const yamlFile=path.join(caseRoot,'config.yaml'),yamlPath=p=>JSON.stringify(p.replaceAll('\\','/'));
  let yaml=await fs.readFile(prepared.configTemplate,'utf8');yaml=yaml.replace(/^dataRoot:.*$/m,'dataRoot: '+yamlPath(data)).replace(/^port:.*$/m,'port: 18101').replace(/^(\s*databaseDirectory:).*$/m,'$1 '+yamlPath(storage)).replace(/autoDownload: true/g,'autoDownload: false');await fs.writeFile(yamlFile,yaml);
  const report={name:config.name,version:config.version,startedAt:new Date().toISOString(),node:prepared.node,cpu:os.cpus()[0].model,ram:os.totalmem(),samples:[],pageErrors:[],monitorErrors:[],caseRoot};
  report.sourceHashes={frontend:await sourceHashes(path.join(runtime,'public/scripts/extensions/third-party/boxed-lllllabc'),['index.js','manifest.json','settings.html','style.css','src','styles']),backend:await sourceHashes(path.join(runtime,'plugins/boxed-lllllabc-server'),['index.mjs','src','vendor'])};
  let host,context,monitoring=false,monitor,stdout,stderr;
  const save=()=>fs.writeFile(path.join(caseRoot,'report.json'),JSON.stringify(report,null,2));
  async function startHost(){
    await freePort();const {createWriteStream}=await import('node:fs');stdout=createWriteStream(path.join(caseRoot,'host.stdout.log'),{flags:'a'});stderr=createWriteStream(path.join(caseRoot,'host.stderr.log'),{flags:'a'});
    host=spawn(prepared.node,['server.js','--configPath',yamlFile,'--dataRoot',data,'--port','18101','--listen','false','--browserLaunchEnabled','false'],{cwd:runtime,env:{...process.env,NODE_ENV:'production',GIT_CEILING_DIRECTORIES:root},windowsHide:true,stdio:['ignore','pipe','pipe']});host.stdout.pipe(stdout);host.stderr.pipe(stderr);host.on('error',error=>{report.hostError=error.message;});
    for(let i=0;i<180;i++){if(host.exitCode!==null)throw new Error('Disposable Tavern exited: '+host.exitCode);try{const response=await fetch(origin+'/');if(response.ok){await fs.writeFile(path.join(caseRoot,'host.pid'),String(host.pid));return;}}catch{}await pause(500);}throw new Error('Disposable Tavern startup timed out');
  }
  async function stopHost(){if(!host)return;const child=host;host=null;if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('close',resolve));}stdout?.end();stderr?.end();}
  try{
    console.log('CASE',JSON.stringify({name:config.name,version:config.version,caseRoot}));await startHost();
    // Fresh Tavern defaults select Horde and contact it automatically. Keep
    // this acceptance host offline; no model endpoint is needed for storage.
    const settingsFile=path.join(data,'default-user/settings.json'),settings=JSON.parse(await fs.readFile(settingsFile,'utf8'));settings.main_api='kobold';settings.api_server='';await fs.writeFile(settingsFile,JSON.stringify(settings));
    context=await chromium.launchPersistentContext(profile,{headless:true,channel:'msedge',viewport:{width:1200,height:900},args:['--enable-precise-memory-info']});const page=await context.newPage();page.on('pageerror',error=>{report.pageErrors.push(error.message);(report.pageErrorDetails??=[]).push(error.stack);});page.on('response',response=>{if(response.status()>=400)(report.httpErrors??=[]).push({url:response.url(),status:response.status()});});
    await page.goto(origin+'/');await page.waitForFunction(()=>!!globalThis.boxedLllllabcDebug&&!!document.querySelector('#boxed-lllllabc-check-storage'),{timeout:60000});
    report.installed=await page.evaluate(async input=>{const module=await import('/boxed-stage5/large-migration-contract.js');return module.installLargeMigrationContract(input);},{nonce,origin,chats:config.chats??175,snapshots:config.snapshots??44,bodyBytes:config.bodyBytes});
    const browserCdp=await context.browser().newBrowserCDPSession(),pageCdp=await context.newCDPSession(page);let lastProgress='',sample=0;
    const sampleLoop=async()=>{while(monitoring){try{
      const progress=await page.evaluate(()=>globalThis.stage5Progress),label=JSON.stringify([progress?.stage,Math.floor((progress?.count??0)/Math.max(1,progress?.total??1)*10)]);if(label!==lastProgress){lastProgress=label;console.log('PROGRESS',JSON.stringify(progress));await fs.writeFile(path.join(caseRoot,'progress.json'),JSON.stringify(progress));}
      const now=performance.now();const probe=await fetch(origin+'/');await probe.arrayBuffer();const homeMs=performance.now()-now;
      const ids=(await browserCdp.send('SystemInfo.getProcessInfo')).processInfo.map(p=>p.id).filter(Number.isSafeInteger),heap=await pageCdp.send('Runtime.getHeapUsage');
      const sizes={};for(const suffix of ['','-wal','-shm']){try{sizes[suffix||'main']=(await fs.stat(path.join(storage,'boxed-lllllabc.sqlite'+suffix))).size;}catch{sizes[suffix||'main']=0;}}
      let memory={};if(sample++%2===0&&host?.pid){assert.ok(Number.isSafeInteger(host.pid));const {stdout:memoryText}=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$s=Get-Process -Id ${host.pid} -ErrorAction Stop;$b=Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue;@{host=$s.WorkingSet64;hostPeak=$s.PeakWorkingSet64;browser=($b|Measure-Object WorkingSet64 -Sum).Sum}|ConvertTo-Json -Compress`],{windowsHide:true});memory=JSON.parse(memoryText);}
      report.samples.push({ms:Date.now(),progress,homeMs,jsHeap:heap.usedSize,sqlite:sizes,...memory});
    }catch(error){report.monitorErrors.push(error.message);}await pause(2000);}};monitoring=true;monitor=sampleLoop();
    report.result=await page.evaluate(()=>stage5Contract.run());console.log('ROUNDTRIP',JSON.stringify({name:config.name,timings:report.result.timings,source:report.result.source}));await save();
    if(config.capacity){await page.evaluate(()=>stage5Contract.prepareCapacity());await page.evaluate(()=>stage5Contract.quotaEstimate(true));try{report.quota=await page.evaluate(()=>stage5Contract.expectCapacityRefusal());}finally{await page.evaluate(()=>stage5Contract.quotaEstimate(false));}report.quota.emulation='injected navigator storage estimate; not physical browser quota';assert.ok(report.quota.preflight,'Expected quota preflight refusal');assert.equal(report.quota.state.active,'sqlite');report.quota.retained=await page.evaluate(()=>stage5Contract.restoreCapacity());await page.evaluate(()=>stage5Contract.prepareCapacity());report.quotaWrite=await page.evaluate(()=>stage5Contract.injectedQuotaWrite());report.quotaWrite.retained=await page.evaluate(()=>stage5Contract.restoreCapacity());console.log('QUOTA_REFUSAL',JSON.stringify({reason:report.quota.reason,writeFault:report.quotaWrite.name,retained:true}));}
    monitoring=false;await monitor;await stopHost();await startHost();monitoring=true;monitor=sampleLoop();
    report.restart=await page.evaluate(()=>stage5Contract.restartCheck());monitoring=false;await monitor;assert.equal(report.restart.summary.digest,report.result.source.digest);assert.deepEqual(report.pageErrors,[]);
    report.browser=await context.browser().version();report.profileBytes=await directoryBytes(profile);report.peakHostWorkingSet=Math.max(0,...report.samples.map(s=>s.host??0));report.peakBrowserWorkingSet=Math.max(0,...report.samples.map(s=>s.browser??0));report.peakRendererJsHeap=Math.max(0,...report.samples.map(s=>s.jsHeap??0));report.peakSqliteAndWal=Math.max(0,...report.samples.map(s=>Object.values(s.sqlite).reduce((sum,n)=>sum+n,0)));report.maxHomeMs=Math.max(0,...report.samples.map(s=>s.homeMs));report.completedAt=new Date().toISOString();report.ok=true;await save();results.push({name:config.name,report:path.join(caseRoot,'report.json'),ok:true});console.log('PASS',JSON.stringify({name:config.name,peakHost:report.peakHostWorkingSet,peakBrowser:report.peakBrowserWorkingSet,peakJs:report.peakRendererJsHeap,peakDisk:report.peakSqliteAndWal,restartMs:report.restart.elapsedMs}));
  }catch(error){report.ok=false;report.error=error.stack;await save();console.error('FAIL',config.name,error);throw error;}
  finally{monitoring=false;await monitor?.catch(()=>{});await context?.close();await stopHost();await save();}
}
await fs.writeFile(path.join(root,'summary-'+Date.now()+'.json'),JSON.stringify(results,null,2));console.log('ALL_CASES_PASSED',JSON.stringify(results));
