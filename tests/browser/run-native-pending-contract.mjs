import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import net from 'node:net';
import {randomUUID} from 'node:crypto';

const root=process.cwd(),older=process.env.BOXED_NATIVE_VERSION==='1.15.0',workerLockout=process.env.BOXED_NATIVE_WORKER_LOCKOUT==='1';
const caseRoot=path.join(root,'.local-test/review-1.0.5-20261124',workerLockout?'native-worker-lockout/'+randomUUID():older?'native115':'.'),runtime=path.join(root,older?'.local-test/runtime-1.15.0-accepted':'.local-test/runtime/SillyTavern');
await fs.mkdir(caseRoot,{recursive:true});
if(workerLockout)await fs.writeFile(path.join(root,'.local-test/review-1.0.5-20261124/native-worker-lockout/latest-run.json'),JSON.stringify({caseRoot}));
const data=path.join(caseRoot,'native-data'),config=path.join(caseRoot,'native-config.yaml'),port=workerLockout?18007:older?18006:18005;
await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',reject);probe.listen(port,'127.0.0.1',()=>probe.close(resolve));});
for(const [source,target] of [
 ...['index.js','style.css','settings.html','manifest.json','package.json','src','styles'].map(file=>[path.join(root,file),path.join(runtime,'public/scripts/extensions/third-party/boxed-lllllabc',file)]),
 ...['index.mjs','package.json','src','vendor'].map(file=>[path.join(root,'.local-test/boxed-lllllabc-server-dev',file),path.join(runtime,'plugins/boxed-lllllabc-server',file)])
])await fs.cp(source,target,{recursive:true,force:true});
let yaml=await fs.readFile(path.join(runtime,'default/config.yaml'),'utf8');
yaml=yaml.replace(/^dataRoot:.*$/m,`dataRoot: ${data.replaceAll('\\','/')}`).replace(/^port:.*$/m,`port: ${port}`)
 .replace(/^enableServerPlugins:.*$/m,'enableServerPlugins: true').replace(/^enableServerPluginsAutoUpdate:.*$/m,'enableServerPluginsAutoUpdate: false');
yaml+=`\nboxedLllllabc:\n  databaseDirectory: ${path.join(caseRoot,'native-sqlite').replaceAll('\\','/')}\n`;
await fs.writeFile(config,yaml);await fs.mkdir(path.join(data,'default-user'),{recursive:true});
if(!(await fs.stat(path.join(data,'default-user/settings.json')).catch(()=>null))){const settings=JSON.parse(await fs.readFile(path.join(runtime,'default/content/settings.json'),'utf8'));settings.firstRun=false;settings.main_api='openai';settings.extension_settings??={};settings.extension_settings['boxed-lllllabc']={enabled:false};await fs.writeFile(path.join(data,'default-user/settings.json'),JSON.stringify(settings));}
const {chromium}=await import(pathToFileURL(process.env.BOXED_PLAYWRIGHT_PATH).href);
const child=spawn(path.join(root,'.local-test/runtime/node.exe'),['server.js','--configPath',config,'--dataRoot',data,'--port',String(port),'--listen','false','--browserLaunchEnabled','false'],{cwd:runtime,windowsHide:true,env:{...process.env,NODE_ENV:'production',GIT_CEILING_DIRECTORIES:caseRoot},stdio:['ignore','pipe','pipe']});
const log=[];child.stdout.on('data',chunk=>log.push(String(chunk)));child.stderr.on('data',chunk=>log.push(String(chunk)));
let browser;
try {
 const deadline=Date.now()+60000;while(Date.now()<deadline){if(child.exitCode!==null)throw new Error(`测试酒馆退出 ${child.exitCode}: ${log.join('').slice(-3000)}`);if(await fetch(`http://127.0.0.1:${port}/csrf-token`).then(r=>r.ok).catch(()=>false))break;await new Promise(r=>setTimeout(r,200));}
 browser=await chromium.launch({headless:true,channel:'msedge'});const context=await browser.newContext({viewport:{width:1200,height:800}}),page=await context.newPage();page.setDefaultTimeout(15000);
 let block=false;const errors=[],diskChecks=[];page.on('pageerror',error=>errors.push(error.message));
 let workerUnavailable=false;
 if(workerLockout)await page.route('**/api/plugins/boxed-lllllabc/**',async route=>{
  const endpoint=new URL(route.request().url()).pathname.split('/').at(-1);
  if(workerUnavailable&&['status','operation','batch-transfer','transfer'].includes(endpoint))return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({protocol:6,ok:false,code:'database-unavailable',reason:'SQLite 工作线程不可用，请检查日志后重启插件。'})});
  return route.continue();
 });
 const updateCompatibility=process.env.BOXED_NATIVE_UPDATE_COMPAT==='1';let serveOld=updateCompatibility;const oldFiles=new Map();
 if(updateCompatibility)await page.route('**/scripts/extensions/third-party/boxed-lllllabc/**',async route=>{
  if(!serveOld)return route.continue();
  const relative=new URL(route.request().url()).pathname.split('/boxed-lllllabc/')[1];
  if(!relative||relative.split('/').includes('..'))return route.abort();
  if(!oldFiles.has(relative))oldFiles.set(relative,execFileSync('git',['show','main:'+relative],{cwd:root,maxBuffer:4*1024*1024}));
  await route.fulfill({status:200,contentType:relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':relative.endsWith('.json')?'application/json':relative.endsWith('.html')?'text/html':'text/plain',body:oldFiles.get(relative)});
 });
 await page.route('**/api/chats/**',async route=>{if(block&&route.request().url().endsWith('/save'))return route.fulfill({status:503,contentType:'application/json',body:'{"error":"synthetic save interruption"}'});return route.continue();});
 await page.exposeFunction('fixtureBlockSave',value=>{block=value;});
 await page.exposeFunction('fixtureDisk',async({avatar,chatId,chat,integrity,stage,group=false})=>{
  const file=group?path.join(data,'default-user/group chats',chatId+'.jsonl'):path.join(data,'default-user/chats',avatar.replace(/\.png$/i,''),chatId+'.jsonl'),rows=(await fs.readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].chat_metadata.integrity,integrity);assert.deepEqual(rows.slice(1),chat);diskChecks.push({stage,messages:chat.length,bytes:(await fs.stat(file)).size});
 });
 await page.goto(`http://127.0.0.1:${port}/`);await page.waitForFunction(()=>Boolean(globalThis.boxedLllllabcDebug),null,{timeout:45000});
 if(workerLockout){
  await page.waitForFunction(()=>document.querySelector('#boxed-lllllabc-refresh'));
  const pending=await page.evaluate(async()=>{
   const base='/scripts/extensions/third-party/boxed-lllllabc/src/',{getRequestHeaders}=await import('/script.js');
   const {createStorageControl}=await import(base+'storage/control.js'),control=createStorageControl();
   const adapters={indexeddb:(await import(base+'storage/indexeddb-adapter.js')).createIndexedDbStorage(),sqlite:(await import(base+'storage/sqlite-client.js')).createSqliteStorage({getRequestHeaders})};
   let session=await adapters.indexeddb.open();try{await session.putChatMeta({chatKey:'native-worker-fixture'});await session.putFullMessages({chatKey:'native-worker-fixture',messages:[0,1,2].map(messageIndex=>({chatKey:'native-worker-fixture',messageIndex,raw:{mes:`保护正文 ${messageIndex}`}}))});}finally{session.close();}
   session=await adapters.sqlite.open();try{await session.putChatMeta({chatKey:'native-target-original',keep:true});}finally{session.close();}
   const {createTransferCoordinator}=await import(base+'storage/transfer.js');const transfer=createTransferCoordinator({control,adapters,hook:async stage=>{if(stage==='batch-verified')throw Object.assign(new Error('fixture interrupted transfer'),{simulateCrash:true});}});
   try{await transfer.switchTo('sqlite',{confirmed:true});}catch(error){if(!error.simulateCrash)throw error;}
   sessionStorage.setItem('boxed-lllllabc:update-check:boxed-lllllabc',JSON.stringify({isUpToDate:false,isGlobal:false}));return (await control.read()).journal;
  });assert(pending?.id);workerUnavailable=true;await page.setViewportSize({width:390,height:760});await page.reload();
  await page.getByRole('button',{name:'继续核对并恢复',exact:true}).click();await page.getByRole('button',{name:'暂时关闭（备份仍暂停）',exact:true}).waitFor();
  assert.match(await page.locator('#boxed-lllllabc-transfer-dialog').innerText(),/SQLite 工作线程不可用/);
  await page.screenshot({path:path.join(caseRoot,'worker-unavailable-mobile.png')});await page.getByRole('button',{name:'暂时关闭（备份仍暂停）',exact:true}).click();
  assert.equal(await page.locator('#boxed-lllllabc-transfer-dialog').count(),0);await page.locator('#send_textarea').fill('故障提示关闭后，酒馆输入仍能使用');
  const paused=await page.evaluate(async()=>{const {createStorageControl}=await import('/scripts/extensions/third-party/boxed-lllllabc/src/storage/control.js');return {state:await createStorageControl().read(),blocked:await globalThis.boxedLllllabcDebug.refreshNow().then(status=>status.shortText.includes('备份暂停'),()=>true),notice:!document.querySelector('#boxed-lllllabc-storage-recovery').hidden};});assert.equal(paused.state.journal.id,pending.id);assert(paused.blocked&&paused.notice);
  if(!await page.locator('#rm_extensions_block').isVisible())await page.locator('#extensions-settings-button .drawer-toggle').click();
  if(!await page.locator('#boxed-lllllabc-resume-storage').isVisible())await page.locator('#boxed-lllllabc-settings > .inline-drawer > .inline-drawer-toggle').click();
  await page.waitForFunction(()=>!document.querySelector('#boxed-lllllabc-update-available').hidden);await page.locator('#boxed-lllllabc-update-available').click();await page.locator('#boxed-lllllabc-update-dialog button[aria-label="关闭"]').click();
  workerUnavailable=false;
  await page.locator('#boxed-lllllabc-status-line').click();await page.getByRole('button',{name:'继续核对并恢复',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#boxed-lllllabc-storage-recovery').hidden);
  const restored=await page.evaluate(async()=>{const base='/scripts/extensions/third-party/boxed-lllllabc/src/',{getRequestHeaders}=await import('/script.js'),{createStorageControl}=await import(base+'storage/control.js'),{createSqliteStorage}=await import(base+'storage/sqlite-client.js');const state=await createStorageControl().read(),s=await createSqliteStorage({getRequestHeaders}).open();try{return {state,bodies:(await s.getFullMessages('native-worker-fixture')).map(row=>row.raw.mes)};}finally{s.close();}});
  assert.equal(restored.state.journal,null);assert.equal(restored.state.active,'sqlite');assert.deepEqual(restored.bodies,['保护正文 0','保护正文 1','保护正文 2']);assert.deepEqual(errors,[]);
  const report={failure:'SQLite worker unavailable injected at HTTP boundary',dismissed:true,nativeInputUsable:true,frontendUpdateAccessible:true,writeGateRemainedPaused:true,journalRetained:true,recoveryEntry:'native chat status line',recovered:true,originalBodies:restored.bodies,pageErrors:errors};await fs.writeFile(path.join(caseRoot,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }else if(updateCompatibility){
  const boot=async(version)=>{
   await page.waitForFunction(version=>document.querySelector('#boxed-lllllabc-version')?.textContent.includes(version),version);
   await page.waitForFunction(()=>document.querySelector('#boxed-lllllabc-refresh')&&!document.querySelector('#boxed-lllllabc-refresh').disabled);
   assert.equal(await page.locator('#send_textarea').isEnabled(),true);
  };
  await boot('1.0.4');
  const first=await page.evaluate(async()=>{const base='/scripts/extensions/third-party/boxed-lllllabc/src/',{createIndexedDbStorage}=await import(base+'storage/indexeddb-adapter.js');const s=await createIndexedDbStorage().open();s.close();const db=(await indexedDB.databases()).find(item=>item.name==='boxed-lllllabc');const {createStorageControl}=await import(base+'storage/control.js');await createStorageControl().update(state=>({...state,active:'sqlite'}));return {frontend:'1.0.4',localSchema:db.version};});
  assert.equal(first.localSchema,8);await page.reload();await boot('1.0.4');
  const health=await page.evaluate(async()=>{const {getRequestHeaders}=await import('/script.js');return fetch('/api/plugins/boxed-lllllabc/status',{headers:getRequestHeaders()}).then(r=>r.json());});assert.equal(health.pluginVersion,'1.0.5');assert.equal(health.database.schema,4);
  serveOld=false;await page.reload();await boot('1.0.5');
  const upgraded=await page.evaluate(async()=>{const {openBackupDatabase}=await import('/scripts/extensions/third-party/boxed-lllllabc/src/db/index.js');const db=await openBackupDatabase();const version=db.version;db.close();return version;});assert.equal(upgraded,9);
  serveOld=true;await page.reload();await boot('1.0.4');
  if(!await page.locator('#rm_extensions_block').isVisible())await page.locator('#extensions-settings-button .drawer-toggle').click();
  if(!await page.locator('#boxed-lllllabc-refresh').isVisible())await page.locator('#boxed-lllllabc-settings > .inline-drawer > .inline-drawer-toggle').click();
  await page.locator('#boxed-lllllabc-refresh').click();await page.waitForFunction(()=>!document.querySelector('#boxed-lllllabc-refresh').disabled);
  await page.evaluate(async()=>{const {createStorageControl}=await import('/scripts/extensions/third-party/boxed-lllllabc/src/storage/control.js');await createStorageControl().update(state=>({...state,active:'indexeddb'}));sessionStorage.removeItem('boxed-lllllabc:storage-warning-shown');sessionStorage.setItem('boxed-lllllabc:update-check:boxed-lllllabc',JSON.stringify({isUpToDate:false,isGlobal:false}));});
  await page.reload();await boot('1.0.4');
  // Cached v8 code cannot open local v9, but its update controls must stay usable.
  const warning=page.locator('#boxed-lllllabc-storage-warning-dialog');await warning.waitFor({state:'visible'});await warning.locator('button').filter({hasText:'稍后处理'}).click();
  if(!await page.locator('#rm_extensions_block').isVisible())await page.locator('#extensions-settings-button .drawer-toggle').click();
  await page.waitForFunction(()=>!document.querySelector('#boxed-lllllabc-update-available')?.hidden);
  if(!await page.locator('#boxed-lllllabc-update-available').isVisible())await page.locator('#boxed-lllllabc-settings > .inline-drawer > .inline-drawer-toggle').click();
  await page.locator('#boxed-lllllabc-update-available').click();await page.locator('#boxed-lllllabc-update-dialog button[aria-label="关闭"]').click();
  serveOld=false;await page.reload();await boot('1.0.5');assert.deepEqual(errors,[]);
  const report={checks:['native-old-frontend-local8-starts-with-new-backend','native-old-frontend-sqlite4-starts-with-new-backend','native-new-frontend-opens-local9','native-cached-old-frontend-sqlite-still-interactive-with-local9','native-cached-old-frontend-local9-can-open-update-dialog','native-update-to-new-frontend-still-interactive'],first,serverVersion:health.pluginVersion,sqliteSchema:health.database.schema,pageErrors:errors};await fs.writeFile(path.join(caseRoot,'native-update-compat-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }else{
 const results=await page.evaluate(async({skipLarge})=>{
  const base='/scripts/extensions/third-party/boxed-lllllabc/src/',st=await import('/script.js'),ext=await import('/scripts/extensions.js');
  ext.extension_settings['boxed-lllllabc'].enabled=false;
  const post=async(url,body)=>{const r=await fetch(url,{method:'POST',headers:st.getRequestHeaders(),body:JSON.stringify(body)});if(!r.ok)throw new Error(`${url}: ${r.status}`);return r.json();};
  const avatar=(await post('/api/characters/duplicate',{avatar_url:'default_Seraphina.png'})).path;await ext.getContext().getCharacters();await st.selectCharacterById(ext.getContext().characters.findIndex(c=>c.avatar===avatar));
  const {createContextReader}=await import(base+'context.js'),reader=createContextReader({getContext:ext.getContext});
  const {createBackupCoordinator}=await import(base+'controllers/backup-coordinator.js'),{createBackendVerifier}=await import(base+'controllers/backend-verifier.js'),{registerBackupEvents}=await import(base+'events.js');
  const {readBackupRecords}=await import(base+'storage/backup-batches.js'),{createPendingRestorePlan}=await import(base+'backup/restore.js'),{executeRestorePlan}=await import(base+'backup/restore-executor.js');
  const {renderRestoredMessages}=await import(base+'controllers/restore-controller.js'),{saveNativeChatSnapshot}=await import(base+'backup/native-save.js'),{protectPendingRecord}=await import(base+'backup/pending-protection.js'),{nativeChatHash}=await import(base+'backup/native-content.js');
  const assert=(v,m)=>{if(!v)throw new Error(m);},results=[];
  for(const mode of ['indexeddb','sqlite']) {
   const name=`journal-native-${mode}-${crypto.randomUUID()}`,integrity=crypto.randomUUID(),original=Array.from({length:6},(_,i)=>({name:i%2?'测试用户':'测试角色',is_user:Boolean(i%2),mes:`虚构正文 ${i}`,send_date:'2026-11-24',extra:{fixture:true},original_avatar:'synthetic.png',swipes:[`虚构正文 ${i}`,'候选乙'],swipe_id:0}));
   await post('/api/chats/save',{avatar_url:avatar,file_name:name,ch_name:'隔离测试',force:false,chat:[{chat_metadata:{integrity}},...original]});
   await ext.getContext().openCharacterChat(name);const current=reader.readCurrentChat(),key=current.identity.chatKey;
   const adapter=mode==='indexeddb'?(await import(base+'storage/indexeddb-adapter.js')).createIndexedDbStorage():(await import(base+'storage/sqlite-client.js')).createSqliteStorage({getRequestHeaders:st.getRequestHeaders});
   const storage={getMode:()=>mode,open:()=>adapter.open()},use=async fn=>{const s=await storage.open();try{return await fn(s);}finally{s.close();}},read=store=>use(s=>readBackupRecords(s,key,store));
   let status,verifier;const settings={enabled:true,fullBackupEnabled:false,recentBackupEnabled:true,historicalBackupEnabled:true,recentLimit:2,backendVerifyDelayMs:0};
   const coordinator=createBackupCoordinator({storage,getContextReader:()=>reader,getSettings:()=>settings,getLatestStatus:()=>status,setStatus:s=>status=s,refreshVisiblePanel:async()=>{},prepareBackup:async()=>{verifier?.clearScheduledVerification();await verifier?.whenIdle();},clearScheduledVerification(){},scheduleBackendVerification(){},scheduleBackendSnapshotVerification(){},readChatCatalog:async()=>({ok:true,entries:[]})});
   verifier=createBackendVerifier({storage,getContextReader:()=>reader,getSettings:()=>settings,getLatestStatus:()=>status,setStatus:s=>status=s,refreshVisiblePanel:async()=>{},readCurrentPending:coordinator.readCurrentPending,updateBackendMeta:coordinator.updateBackendMeta,createDisplayStatus:coordinator.createDisplayStatus,prioritizeFullBackupStatus:coordinator.prioritizeFullBackupStatus,needsFullBackupConfirmation:coordinator.needsFullBackupConfirmation,confirmFullBackup:coordinator.confirmFullBackupAfterBackendVerification,ensurePendingBackups:coordinator.ensurePendingBackups,retryDelays:[]});
   const events=registerBackupEvents({eventSource:st.eventSource,eventTypes:st.event_types,debounceMs:100000,captureTrigger:coordinator.captureTrigger,onObserved:()=>{coordinator.noteSourceChange();verifier.clearScheduledVerification();},onBackupNeeded:coordinator.runBackupNow});
   try{
    await coordinator.runBackupNow({eventName:'extension-loaded',args:[]});await window.fixtureBlockSave(true);
    await st.deleteMessage(2);let c=ext.getContext();c.chat[0].mes='删除后立即编辑';c.chat[0].swipes[0]=c.chat[0].mes;await st.eventSource.emit(st.event_types.MESSAGE_EDITED,0);
    c.chat.push({name:'测试用户',is_user:true,mes:'紧接着的新楼层',extra:{fixture:true}});await st.eventSource.emit(st.event_types.MESSAGE_RECEIVED,c.chat.length-1);await events.flush();
    const target=structuredClone(c.chat),pending=await read('pending_changes');assert(pending.filter(row=>row.pendingType==='operation').length===3,'原生事件捕获不完整');
    await verifier.verifyBackendNow({chatKey:key});assert((await read('pending_changes')).length===pending.length,'原生文件尚旧却提前核销');
    events.pause();await window.fixtureBlockSave(false);await ext.getContext().openCharacterChat(name);c=ext.getContext();assert(nativeChatHash(c.chat)!==nativeChatHash(target),'未重载真实旧文件');
    const plan=createPendingRestorePlan({chat:c.chat,chatKey:key,pending:await read('pending_changes'),chatIntegrity:reader.readCurrentChat().identity.meta.chatIntegrity});assert(!plan.blockedReason,plan.blockedReason);
    const restored=await executeRestorePlan({plan,readCurrent:()=>reader.readCurrentChat(),readPending:()=>read('pending_changes'),writePending:rows=>use(s=>s.putPendingChanges(rows.map(row=>protectPendingRecord(row,settings,target.length)))),afterApply:()=>coordinator.resetObservation(),render:renderRestoredMessages,save:({current})=>saveNativeChatSnapshot({current})});
    assert(restored.ok,restored.reason+' '+restored.error?.message);await coordinator.runBackupNow({eventName:'restore-complete',args:[]});await verifier.verifyBackendNow({chatKey:key});assert(!(await read('pending_changes')).length,'原生文件核对后未核销');
    await window.fixtureDisk({avatar,chatId:name,chat:JSON.parse(JSON.stringify(target)),integrity,stage:mode});await ext.getContext().openCharacterChat(name);assert(nativeChatHash(ext.getContext().chat)===nativeChatHash(target),'重开真实文件内容变化');
    results.push({mode,operations:3,nativeSave:true,fileReread:true,pendingCleared:true});
   }finally{events.unregister();verifier.clearScheduledVerification();await window.fixtureBlockSave(false);}
  }
  const {createPendingObserver}=await import(base+'backup/pending-journal.js'),{warmNativeChat}=await import(base+'backup/native-content.js');
  const local=(await import(base+'storage/indexeddb-adapter.js')).createIndexedDbStorage(),use=async fn=>{const session=await local.open();try{return await fn(session);}finally{session.close();}};
  for(const length of skipLarge?[]:[3000,10000]) {
   const name=`journal-large-${length}-${crypto.randomUUID()}`,integrity=crypto.randomUUID(),text='fictional '.repeat(100);
   const original=Array.from({length},(_,i)=>({name:'测试角色',is_user:false,mes:`${i} ${text}`,swipes:[`${i} ${text}`],swipe_id:0,extra:{fixture:true}}));
   await post('/api/chats/save',{avatar_url:avatar,file_name:name,ch_name:'隔离测试',force:false,chat:[{chat_metadata:{integrity}},...original]});await ext.getContext().openCharacterChat(name);
   const watcher=createPendingObserver({readCurrent:()=>reader.readCurrentChat(),deferHashes:true});watcher.reset();const c=ext.getContext(),key=reader.readCurrentChat().identity.chatKey;
   c.chat.splice(Math.floor(length/2),3);let time=performance.now();const deletion=watcher.capture({eventName:'message_deleted',args:[c.chat.length]});const captureMs=performance.now()-time;await deletion.ready;
   c.chat[0].mes='大聊天删后编辑';c.chat[0].swipes[0]=c.chat[0].mes;const edit=watcher.capture({eventName:'message_edited',args:[0]});c.chat.push({name:'测试用户',is_user:true,mes:'大聊天接续'});const append=watcher.capture({eventName:'message_received',args:[c.chat.length-1]});await Promise.all([edit.ready,append.ready]);
   const pending=[...deletion.records,...edit.records,...append.records],target=structuredClone(c.chat),deletionBytes=new TextEncoder().encode(JSON.stringify(deletion.records)).length;
   await use(s=>s.putPendingChanges(pending));await ext.getContext().openCharacterChat(name);await warmNativeChat(ext.getContext().chat);time=performance.now();
   const plan=createPendingRestorePlan({chat:ext.getContext().chat,chatKey:key,pending});const previewMs=performance.now()-time;assert(!plan.blockedReason,plan.blockedReason);time=performance.now();
   const result=await executeRestorePlan({plan,readCurrent:()=>reader.readCurrentChat(),readPending:()=>use(s=>s.getPendingChanges(key)),writePending:rows=>use(s=>s.putPendingChanges(rows)),render:renderRestoredMessages,save:({current})=>saveNativeChatSnapshot({current})});
   if(!result.ok){const live=ext.getContext().chat,diffs=live.flatMap((row,i)=>JSON.stringify(row)!==JSON.stringify(target[i])?[{index:i,fields:Object.keys({...row,...target[i]}).filter(key=>JSON.stringify(row[key])!==JSON.stringify(target[i]?.[key])).map(key=>[key,JSON.stringify(row[key]).slice(0,180),JSON.stringify(target[i]?.[key])?.slice(0,180)])}]:[]).slice(0,4);throw new Error(result.reason+' '+result.error?.message+' '+JSON.stringify(diffs));}const applyRenderSaveMs=performance.now()-time;
   await window.fixtureDisk({avatar,chatId:name,chat:JSON.parse(JSON.stringify(target)),integrity,stage:`large-${length}`});
   const backend=await (await import(base+'verifier/backend-reader.js')).readBackendChat({current:reader.readCurrentChat()});assert(backend.ok&&nativeChatHash(backend.chat.slice(1))===nativeChatHash(target),'大聊天原生文件核对失败');
   results.push({length,deletionBytes,captureMs:Math.round(captureMs),previewMs:Math.round(previewMs),applyRenderSaveMs:Math.round(applyRenderSaveMs),nativeFileVerified:true});
  }
  const groupName=`journal-group-${crypto.randomUUID()}`,groupIntegrity=crypto.randomUUID(),groupChat=[{name:'群聊角色',mes:'群聊保存内容',extra:{fixture:true}}];
  const groupCurrent={ok:true,chat:groupChat,identity:{chatKey:`group:fixture:${groupName}`,meta:{chatType:'group',chatId:groupName,groupId:'fixture'}},context:{chatMetadata:{integrity:groupIntegrity},getRequestHeaders:st.getRequestHeaders}};
  await saveNativeChatSnapshot({current:groupCurrent});await window.fixtureDisk({group:true,chatId:groupName,chat:groupChat,integrity:groupIntegrity,stage:'group-save'});results.push({groupNativeSave:true});
  return results;
 },{skipLarge:older});
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(caseRoot,'native-pending-report.json'),JSON.stringify({results,diskChecks,pageErrors:errors},null,2));console.log(JSON.stringify({results,diskChecks,pageErrors:errors}));
 }
 await context.close();
}catch(error){
 const failedPage=browser?.contexts()[0]?.pages()[0];
 if(failedPage)try{
  await failedPage.screenshot({path:path.join(caseRoot,'failure.png')});
  const geometry=await failedPage.evaluate(()=>Object.fromEntries(['#rm_extensions_block','#boxed-lllllabc-settings > .inline-drawer > .inline-drawer-content','#boxed-lllllabc-resume-storage','#chat'].map(selector=>{const node=document.querySelector(selector);if(!node)return [selector,null];const box=node.getBoundingClientRect(),style=getComputedStyle(node),top=document.elementFromPoint(Math.min(innerWidth-1,Math.max(1,box.x+box.width/2)),Math.min(innerHeight-1,Math.max(1,box.y+box.height/2)));return [selector,{className:node.className,display:style.display,visibility:style.visibility,zIndex:style.zIndex,pointerEvents:style.pointerEvents,box:{x:box.x,y:box.y,width:box.width,height:box.height},top:top?.id||top?.className}];})));
  await fs.writeFile(path.join(caseRoot,'failure-geometry.json'),JSON.stringify(geometry,null,2));
 }catch{}
 throw error;
}finally{await browser?.close();child.kill();await fs.writeFile(path.join(caseRoot,'native-server.log'),log.join(''));}
