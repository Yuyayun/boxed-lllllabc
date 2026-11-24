const assert=(value,message)=>{if(!value)throw new Error(message);};
export async function installCompletedUpgradeFixture({nonce}) {
 const old='/old/src/',headers=()=>({'X-Test-Nonce':nonce,'X-CSRF-Token':nonce});
 const {createStorageControl}=await import(old+'storage/control.js'),control=createStorageControl();
 const adapters={indexeddb:(await import(old+'storage/indexeddb-adapter.js')).createIndexedDbStorage(),sqlite:(await import(old+'storage/sqlite-client.js')).createSqliteStorage({getRequestHeaders:headers})};
 const {createTransferCoordinator}=await import(old+'storage/transfer.js');
 const use=async(mode,fn)=>{const session=await adapters[mode].open();try{return await fn(session);}finally{session.close();}};
 globalThis.completedUpgrade={
  async complete(){
   const key='character:completed-fixture.png:'+crypto.randomUUID(),bodies=Array.from({length:12},(_,index)=>`已经搬完的正文 ${index}`);let activated;
   await use('indexeddb',async s=>{await s.putChatMeta({chatKey:key});await s.putFullMessages({chatKey:key,messages:bodies.map((mes,messageIndex)=>({chatKey:key,messageIndex,raw:{mes}}))});});
   const coordinator=createTransferCoordinator({control,adapters,hook:async(stage,journal)=>{if(stage==='activated')activated=structuredClone(journal);}});
   const result=await coordinator.switchTo('sqlite',{confirmed:true}),state=await control.read();
   assert(result.ok&&state.active==='sqlite'&&state.journal===null&&state.lastTransfer,'必须先真正完成迁移及前端登记');
   const target=await adapters.sqlite.transfer('status',{id:state.lastTransfer});assert(target.phase==='finished','目标收尾必须已完成');
   assert(JSON.stringify((await use('sqlite',s=>s.getFullMessages(key))).map(row=>row.raw.mes))===JSON.stringify(bodies),'搬完后正文不一致');
   const expected={key,bodies,state,activated:activated?{...activated,phase:'activated'}:null};sessionStorage.setItem('completed-upgrade-fixture',JSON.stringify(expected));return {state,targetPhase:target.phase,messages:bodies.length};
  },
  async startOld(){
   const expected=JSON.parse(sessionStorage.getItem('completed-upgrade-fixture'));let pauses=0;
   const {createStorageSwitchUi}=await import(old+'ui/storage-switch.js');let ui;
   const coordinator=createTransferCoordinator({control,adapters,pause:async()=>{pauses++;ui.block();},resume:async()=>ui.close()});
   ui=createStorageSwitchUi({control,sqlite:adapters.sqlite,coordinator});ui.bind();
   let recovery,error;try{recovery=await coordinator.recover();await ui.refresh();}catch(cause){error={message:cause.message,code:cause.code};await ui.failure(cause);}
   const state=await control.read(),health=await adapters.sqlite.status();
   assert(state.journal===null&&state.active===expected.state.active&&state.lastTransfer===expected.state.lastTransfer,'只升级后端不得重建或改写已完成的前端登记');
   assert(pauses===0&&!document.querySelector('#boxed-lllllabc-transfer-dialog'),'已完成且无待处理登记，不能因后端升级被锁成迁移中');
   return {state,pauses,recovery,error,health:{ok:health.ok,code:health.code,reason:health.reason}};
  },
  async latest({read=true}={}){
   const base='/src/',{createStorageControl}=await import(base+'storage/control.js'),newControl=createStorageControl();
   const newAdapters={indexeddb:(await import(base+'storage/indexeddb-adapter.js')).createIndexedDbStorage(),sqlite:(await import(base+'storage/sqlite-client.js')).createSqliteStorage({getRequestHeaders:headers})};
   const {createTransferCoordinator}=await import(base+'storage/transfer.js');let pauses=0;
   const expected=JSON.parse(sessionStorage.getItem('completed-upgrade-fixture')),coordinator=createTransferCoordinator({control:newControl,adapters:newAdapters,pause:async()=>{pauses++;}});
   const result=await coordinator.recover(),state=await newControl.read();assert(!state.journal&&pauses===0,'新前端不得把已完成的迁移重新执行');
   const {createStorageSwitchUi}=await import(base+'ui/storage-switch.js');const ui=createStorageSwitchUi({control:newControl,sqlite:newAdapters.sqlite,coordinator});await ui.refresh();assert(!document.querySelector('#boxed-lllllabc-transfer-dialog'),'连接不可用不能把无待处理任务的页面锁成迁移恢复');
   if(read){const s=await newAdapters.sqlite.open();try{assert(JSON.stringify((await s.getFullMessages(expected.key)).map(row=>row.raw.mes))===JSON.stringify(expected.bodies),'数据库升级后正文有变化');}finally{s.close();}}
   return {result,state,pauses};
  },
  async reconcileFinishedReceipt(){
   const base='/src/',expected=JSON.parse(sessionStorage.getItem('completed-upgrade-fixture'));
   const {createStorageControl}=await import(base+'storage/control.js'),newControl=createStorageControl(),actions=[];
   const real=(await import(base+'storage/sqlite-client.js')).createSqliteStorage({getRequestHeaders:headers}),source=(await import(base+'storage/indexeddb-adapter.js')).createIndexedDbStorage();
   let session=await real.open();try{await session.putFullMessages({chatKey:expected.key,messages:[{chatKey:expected.key,messageIndex:0,raw:{mes:'搬完以后新增的改动'}}]});}finally{session.close();}
   // Only recreate a stale completion-registration acknowledgement. Both real
   // stores have already finished; the target has even accepted newer data.
   assert(expected.activated,'夹具必须留有真实激活阶段的登记');await newControl.update(state=>({...state,journal:expected.activated}));
   const track=adapter=>({...adapter,transfer:(action,...args)=>{actions.push(action);return adapter.transfer(action,...args);},batchTransfer:(action,...args)=>{actions.push(action);return adapter.batchTransfer(action,...args);}});
   const {createTransferCoordinator}=await import(base+'storage/transfer.js');const coordinator=createTransferCoordinator({control:newControl,adapters:{indexeddb:track(source),sqlite:track(real)}});
   await coordinator.recover({confirmed:true});const state=await newControl.read();assert(!state.journal&&state.active==='sqlite','已完成任务的遗留登记未能收尾');
   assert(!actions.some(action=>['source','prepare','append','commit','begin','captureStep'].includes(action)),'已完成的任务被重新复制或提交');
   session=await real.open();try{const bodies=(await session.getFullMessages(expected.key)).map(row=>row.raw.mes);assert(bodies[0]==='搬完以后新增的改动'&&bodies.slice(1).every((body,i)=>body===expected.bodies[i+1]),'收尾覆盖了搬完以后的新数据');}finally{session.close();}
   return {state,actions,newerTargetContentPreserved:true};
  },
 };
}
