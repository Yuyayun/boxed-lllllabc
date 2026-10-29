import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';

// This explicit fixture marker is never created by production code. Only copy
// a closed synthetic test database here, with WAL/SHM when present.
for(const key of ['BOXED_SERVER_REPOSITORY','BOXED_PROFILE_FIXTURE','BOXED_PROFILE_OUTPUT'])assert.ok(process.env[key],`Set ${key}`);
const front=await fs.realpath(process.env.BOXED_FRONT_REPOSITORY??fileURLToPath(new URL('../../',import.meta.url))),backend=await fs.realpath(process.env.BOXED_SERVER_REPOSITORY);
const fixture=await fs.realpath(process.env.BOXED_PROFILE_FIXTURE),root=path.resolve(process.env.BOXED_PROFILE_OUTPUT),variant=process.argv[2]??'current';assert.match(variant,/^[a-zA-Z0-9_-]+$/);
const marker=JSON.parse(await fs.readFile(path.join(fixture,'profile-fixture.json'),'utf8'));assert.equal(marker.purpose,'boxed-synthetic-profile');assert.ok(Number.isSafeInteger(marker.records)&&marker.records>0);
assert.ok(!root.startsWith(fixture+path.sep)&&root!==fixture,'Output must not be inside the source fixture');await fs.mkdir(root,{recursive:true});
const load=(base,file)=>import(pathToFileURL(path.join(base,file)).href);
const {SqliteRepository}=await load(backend,'src/sqlite.js'),{RuntimeLog}=await load(backend,'src/runtime-log.js'),{createTransferCoordinator}=await load(front,'src/storage/transfer-v3.js');

const reports=[];
const originalOpen=fs.open.bind(fs);let logMetrics;
fs.open=async(...args)=>{const handle=await originalOpen(...args);if(logMetrics&&String(args[0]).includes('boxed-lllllabc-log-')){const sync=handle.sync.bind(handle);handle.sync=async()=>{const start=performance.now();logMetrics.syncs++;try{return await sync();}finally{logMetrics.syncMs+=performance.now()-start;}};}return handle;};
function instrument(repo){const totals={},prepare=repo.db.prepare.bind(repo.db);let current='setup';repo.db.prepare=sql=>{const statement=prepare(sql);return new Proxy(statement,{get(target,key){if(!['get','all','iterate'].includes(key))return typeof target[key]==='function'?target[key].bind(target):target[key];const count=row=>{if(row&&Object.hasOwn(row,'payload')){const item=totals[current]??={calls:0,rows:0,bytes:0,ms:0};item.rows++;item.bytes+=Buffer.byteLength(row.payload);}};if(key==='iterate')return function*(...args){for(const row of target.iterate(...args)){count(row);yield row;}};return (...args)=>{const value=target[key](...args);if(Array.isArray(value))value.forEach(count);else count(value);return value;};}});};return {totals,async call(action,fn){current=action;const item=totals[action]??={calls:0,rows:0,bytes:0,ms:0};item.calls++;const start=performance.now();try{return await fn();}finally{item.ms+=performance.now()-start;current='outside';}}};}
function digest(repo){const hash=createHash('sha256'),table=repo.activeDataset()===0?'records':'records_next',statement=repo.db.prepare(`SELECT store,primary_key,payload FROM ${table} ORDER BY store,primary_key`);let count=0;for(const row of statement.iterate()){hash.update(JSON.stringify(row));count++;}return {digest:hash.digest('hex'),count};}
for(const direction of ['to-sqlite','to-indexeddb']){
  const dir=path.join(root,'runs',variant+'-'+direction+'-'+Date.now());await fs.mkdir(path.join(dir,'source'),{recursive:true});await fs.mkdir(path.join(dir,'target'),{recursive:true});
  for(const file of await fs.readdir(fixture))if(/^boxed-lllllabc\.sqlite(?:-(?:wal|shm))?$/.test(file))await fs.copyFile(path.join(fixture,file),path.join(dir,'source',file));
  const source=new SqliteRepository(path.join(dir,'source/boxed-lllllabc.sqlite')),target=new SqliteRepository(path.join(dir,'target/boxed-lllllabc.sqlite'));
  const a=instrument(source),b=instrument(target),logger=new RuntimeLog(path.join(dir,'logs'));logMetrics={syncs:0,syncMs:0,requests:0,requestMs:0};
  const report={variant,direction,fixture:'closed synthetic fixture; SQLite repository ports emulate adapter directions, not browser performance',node:process.version,dir};
  try{
    const start=performance.now();await a.call('initialize',()=>source.initialize());report.startupMs=performance.now()-start;
    await target.execute('putChatMeta',[{chatKey:'old-target',keep:true}]);const expected=digest(source);assert.equal(expected.count,marker.records);
    const from=direction==='to-sqlite'?'indexeddb':'sqlite',to=from==='indexeddb'?'sqlite':'indexeddb';let state={active:from,previous:null,lastTransfer:null,journal:null};
    const control={read:async()=>structuredClone(state),update:async fn=>(state=fn(structuredClone(state)))};
    const adapters={};for(const [mode,repo,meter]of [[from,source,a],[to,target,b]])adapters[mode]={batchVersion:3,status:async()=>({ok:true,database:{batchTransfer:3}}),batchTransfer:(action,args)=>meter.call(action,()=>repo.batchTransfer[action](...args))};
    adapters[to].checkCapacity=async()=>{report.capacityRequests=(report.capacityRequests??0)+1;const start=performance.now();try{return await target.status();}finally{report.capacityMs=(report.capacityMs??0)+performance.now()-start;}};
    adapters.sqlite.logEvent=async event=>{logMetrics.requests++;const start=performance.now();try{return await logger.record(event);}finally{logMetrics.requestMs+=performance.now()-start;}};
    const coordinator=createTransferCoordinator({control,adapters,locks:{request:async(_n,_o,fn)=>fn()},budget:{limit:100,bytes:2*1024*1024}});
    const started=performance.now();await coordinator.switchTo(to,{confirmed:true});report.migrationMs=performance.now()-started;
    await logger.tail;if(logger.close)await logger.close();report.log={...logMetrics};report.source=a.totals;report.target=b.totals;
    const actual=digest(target),retained=digest(source);assert.deepEqual(actual,expected);assert.deepEqual(retained,expected);assert.equal(state.active,to);assert.equal(state.journal,null);report.content=expected;
    const files=await fs.readdir(path.join(dir,'logs'));report.log.lines=0;for(const file of files)if(file.endsWith('.jsonl'))report.log.lines+=(await fs.readFile(path.join(dir,'logs',file),'utf8')).split('\n').filter(Boolean).length;
    report.ok=true;await fs.writeFile(path.join(dir,'report.json'),JSON.stringify(report,null,2));reports.push(report);console.log('BENCH_PASS',JSON.stringify({variant,direction,migrationMs:report.migrationMs,startupMs:report.startupMs,source:report.source,target:report.target,log:report.log,capacityRequests:report.capacityRequests}));
  }finally{await logger.tail;source.close();target.close();logMetrics=null;}
}
await fs.writeFile(path.join(root,variant+'-benchmark.json'),JSON.stringify(reports,null,2));
