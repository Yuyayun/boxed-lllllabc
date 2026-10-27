import { createIndexedDbStorage } from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/indexeddb-adapter.js';
import { createSqliteStorage } from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/sqlite-client.js';
import { emptyManifest } from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/transfer-format.js';
import { buildBackupCatalog } from '/scripts/extensions/third-party/boxed-lllllabc/src/backup/catalog.js';
import { createBackupStorage } from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/service.js';
import { createCatalogController } from '/scripts/extensions/third-party/boxed-lllllabc/src/controllers/catalog-controller.js';
import { createStorageControl } from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/control.js';
import { createTransferCoordinator } from '/scripts/extensions/third-party/boxed-lllllabc/src/storage/transfer.js';
import { captureSnapshot } from '/scripts/extensions/third-party/boxed-lllllabc/src/snapshots/model.js';
import { readSnapshot } from '/scripts/extensions/third-party/boxed-lllllabc/src/snapshots/service.js';
import { openBackupCatalogDialog,renderBackupCatalogDialog,closeBackupCatalogDialog } from '/scripts/extensions/third-party/boxed-lllllabc/src/ui/backup-catalog-dialog.js';

export async function prepareStress(mode) {
  if(location.origin!=='http://127.0.0.1:18000')throw new Error('仅限隔离实例');
  const token=(await(await fetch('/csrf-token')).json()).token;
  const adapter=mode==='indexeddb'?createIndexedDbStorage():createSqliteStorage({getRequestHeaders:()=>({'X-CSRF-Token':token})});
  const id=crypto.randomUUID();await adapter.transfer('prepare',{id,manifest:await emptyManifest()});await adapter.transfer('seal',{id});await adapter.transfer('commit',{id});await adapter.transfer('finish',{id});
  let ordinary=0,bodyBytes=0;const start=performance.now(),session=await adapter.open();
  try{
    for(let chat=0;chat<175;chat++){
      const chatKey=`character:p7-${chat%9}.png:${chat}`,meta={chatKey,chatType:'character',characterAvatar:`p7-${chat%9}.png`,characterName:`压测角色${chat%9}`,chatDisplayName:`虚构聊天${chat}`,fullBackupState:chat%3===0?'frozen':chat%3===1?'awaiting-confirmation':'active'};
      const record=i=>({chatKey,messageIndex:i,raw:{name:'虚构角色',mes:`第${chat}段-${i}层：`+'x'.repeat(60000),swipes:['甲','乙'],swipe_id:1,extra:{nil:null,missing:undefined,date:new Date(0)}},backedUpAt:'2026-10-27T00:00:00Z'});
      const recent=Array.from({length:chat===174?8:10},(_,i)=>record(i)),full=Array.from({length:10},(_,i)=>record(i));
      const historical=Array.from({length:4},(_,i)=>record(i)),pending=[{...record(0),id:`${chatKey}:pending`,canonicalHash:'p7-retain'}];
      await session.replaceRecentSnapshot({meta,messages:recent});await session.replaceFullSnapshot({chatKey,meta,messages:full});await session.updateChatMetaSummary(chatKey,meta);await session.putHistoricalChanges(historical);await session.putPendingChanges(pending);
      ordinary+=recent.length+full.length+historical.length+pending.length;bodyBytes+=(recent.length+full.length+historical.length+pending.length)*60000;
    }
    return {mode,chats:175,ordinary,bodyBytes,seedMs:Math.round(performance.now()-start)};
  }finally{session.close();}
}
export async function inspectStress(mode) {
  const token=(await(await fetch('/csrf-token')).json()).token;
  const adapter=mode==='indexeddb'?createIndexedDbStorage():createSqliteStorage({getRequestHeaders:()=>({'X-CSRF-Token':token})});const session=await adapter.open(),start=performance.now();
  try{const catalog=session.getBackupCatalog?await session.getBackupCatalog():buildBackupCatalog(await session.getBackupCatalogData());return {ok:true,mode,chats:catalog.chatCount,records:catalog.recordCount,bytes:catalog.storageBytes,readMs:Math.round(performance.now()-start)};}
  catch(error){return {ok:false,mode,code:error.code,reason:error.message,readMs:Math.round(performance.now()-start)};}finally{session.close();}
}

export async function exerciseStress() {
 if(location.origin!=='http://127.0.0.1:18000')throw new Error('仅限隔离实例');
 const token=(await(await fetch('/csrf-token')).json()).token,adapters={indexeddb:createIndexedDbStorage(),sqlite:createSqliteStorage({getRequestHeaders:()=>({'X-CSRF-Token':token})})};
 const times={},assert=(v,m)=>{if(!v)throw new Error(m);},use=async(mode,fn)=>{const s=await adapters[mode].open();try{return await fn(s);}finally{s.close();}};
 const measure=async(name,fn)=>{const start=performance.now();const result=await fn();times[name]=Math.round(performance.now()-start);return result;};
 const catalog=await use('indexeddb',s=>s.getBackupCatalog());assert(catalog.chatCount===175&&catalog.recordCount===4373,'初始规模错误');
 await measure('render175',async()=>{openBackupCatalogDialog();renderBackupCatalogDialog({catalog});});
 await measure('search',async()=>{const input=document.querySelector('.boxed-lllllabc-catalog-search input');input.value='虚构聊天174';input.dispatchEvent(new Event('input'));assert(document.querySelectorAll('.boxed-lllllabc-catalog-entry').length===1,'搜索不正确');input.value='';input.dispatchEvent(new Event('input'));document.querySelector('.boxed-lllllabc-catalog-group summary').click();});closeBackupCatalogDialog();
 const saved=[];
 await measure('create100Snapshots',async()=>{await use('indexeddb',async s=>{for(let i=0;i<100;i++){const snap=await captureSnapshot({ok:true,identity:{chatKey:'character:p7-0.png:0'},chat:[{mes:`不可变快照${i}:`+'s'.repeat(60000),swipes:['甲','乙'],swipe_id:1}],context:{chatMetadata:{variables:{i}}}},{name:`压测快照${i}`});await s.beginSnapshot({header:snap.header,identityMeta:{chatKey:snap.header.chatKey}});await s.appendSnapshotMessages({id:snap.header.id,messages:snap.messages});await s.publishSnapshot({id:snap.header.id});saved.push(snap.header.id);}});});
 const control=createStorageControl();await control.update(()=>({active:'indexeddb',journal:null,previous:null,lastTransfer:null}));const coordinator=createTransferCoordinator({control,adapters});
 await measure('toSqlite',()=>coordinator.switchTo('sqlite',{confirmed:true}));
 const remote=await use('sqlite',s=>s.getBackupCatalog());assert(remote.chatCount===175&&remote.recordCount===4373,'迁移后目录不等价');
 await use('sqlite',async s=>{assert((await s.listSnapshots({})).items.length===50,'快照分页错误');assert((await readSnapshot(s,saved[99])).chat[0].mes.startsWith('不可变快照99:'),'快照内容错误');});
 await measure('toIndexedDb',()=>coordinator.switchTo('indexeddb',{confirmed:true}));
 for(const mode of ['indexeddb','sqlite']){
  const controller=createCatalogController({storage:createBackupStorage({adapter:adapters[mode]}),renderDialog:()=>{}});
  const plan=await measure(`${mode}Preview`,()=>controller.previewBatch({range:'all'}));assert(plan.chatCount===175&&plan.protectedRecords===1345,'保护数量错误');
  const result=await measure(`${mode}Delete`,()=>controller.executeBatch(plan,{confirmed:true}));assert(result.ok&&!result.unknown&&result.deletedRecords===3028,result.reason||'批量删除错误');
  const after=await use(mode,s=>s.getBackupCatalog());assert(after.recordCount===1345,'受保护记录丢失');
  await use(mode,async s=>{let count=0,after='';do{const page=await s.listSnapshots({after});count+=page.items.length;after=page.after;}while(after);assert(count===100,'批量清理改变快照');assert((await readSnapshot(s,saved[0])).chat[0].mes.startsWith('不可变快照0:'),'原快照损坏');});
 }
 return {times,sourceBytes:catalog.storageBytes,initialChats:175,initialRecords:4373,snapshots:100,retainedProtected:1345,deletedPerPort:3028,active:(await control.read()).active};
}
