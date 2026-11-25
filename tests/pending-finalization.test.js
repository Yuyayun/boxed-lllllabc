import test from 'node:test';
import assert from 'node:assert/strict';
import {createPendingObserver,pendingRecordFingerprint} from '../src/backup/pending-journal.js';
import {nativeChatHash} from '../src/backup/native-content.js';
import {comparePendingWithBackend} from '../src/verifier/compare.js';
import {createBackendVerifier} from '../src/controllers/backend-verifier.js';

function fixture(){
 const current={ok:true,identity:{chatKey:'finalization-test',meta:{chatIntegrity:'file-one'}},chat:[{mes:'greeting',is_user:false,extra:{reasoning:''}}]};
 const observer=createPendingObserver({readCurrent:()=>current});observer.reset();return {current,observer};
}
function turn(f,legacy=false){
 const {current,observer}=f,records=[];
 current.chat.push({mes:'user '+current.chat.length,is_user:true,extra:{isSmallSys:false}});
 records.push(...observer.capture({eventName:'message_sent',args:[current.chat.length-1]}).records);
 const early=structuredClone(records);
 current.chat.at(-1).extra.reasoning='';
 current.chat.push({mes:'AI '+current.chat.length,is_user:false,extra:{reasoning:''}});
 records.push(...observer.capture({eventName:'message_received',args:[current.chat.length-1]}).records);
 Object.assign(current.chat.at(-1),{swipe_id:0,swipes:[current.chat.at(-1).mes],swipe_info:[{extra:{reasoning:''}}]});
 records.push(...observer.capture(legacy?{eventName:'message_updated',args:[current.chat.length-1]}:{eventName:'generation_ended',args:[current.chat.length]}).records);
 assert.deepEqual(records.slice(0,early.length),early);return records;
}
const confirmed=(rows,chat)=>comparePendingWithBackend(rows,chat,{recentLimit:20});

test('原生收发：早期操作不变，结束时观察全部层，最终文件确认后全部可核销',()=>{
 const f=fixture(),records=turn(f),fingerprints=records.map(pendingRecordFingerprint);
 assert.equal(records.filter(row=>row.pendingType==='operation').at(-1).afterNativeHash,nativeChatHash(f.current.chat));
 assert.equal(confirmed(records,f.current.chat).remaining.length,0);
 assert.deepEqual(records.map(pendingRecordFingerprint),fingerprints);
});

test('异步渲染在事件后补的真实字段由收尾另记，停止生成同样完整观察',()=>{
 for(const stopped of [false,true]){
  const f=fixture(),records=turn(f);
  f.current.chat[1].extra.custom_extension={real:'keep this'};
  const late=stopped?f.observer.capture({eventName:'generation_stopped',args:[f.current.chat.length]}):f.observer.settle();
  assert(late.records.length>0);records.push(...late.records);
  assert.equal(confirmed(records,f.current.chat).remaining.length,0);
  const disk=structuredClone(f.current.chat);delete disk[1].extra.custom_extension;
  assert(confirmed(records,disk).remaining.length>0);
 }
});

test('旧1.0.5积累三轮、重载及新活动接续：只兼容用户空reasoning默认值',()=>{
 const f=fixture(),old=[];for(let n=0;n<3;n++)old.push(...turn(f,true));
 assert.equal(old.length,18);
 assert(old.filter(row=>row.pendingType==='operation').every(row=>row.afterNativeHash!==nativeChatHash(f.current.chat)));
 const before=structuredClone(old);f.observer.reset();
 assert.equal(f.observer.settle().records.length,0);
 assert.equal(confirmed(old,f.current.chat).remaining.length,0);
 const fresh=turn(f);assert.equal(confirmed([...old,...fresh],f.current.chat).remaining.length,0);
 assert.deepEqual(old,before);
});

test('用户记录先已核销、AI根仍留存，以及部分核销丢失副本时安全接续',()=>{
 const f=fixture(),records=turn(f,true),withoutUser=records.filter(row=>!(row.kind==='new_message'&&row.pendingType==='message_part'&&row.raw.is_user));
 assert.equal(confirmed(withoutUser,f.current.chat).remaining.length,0);
 const userRoot=records.find(row=>row.pendingType==='operation'&&row.kind==='new_message');
 const afterUserRetired=records.filter(row=>row.id!==userRoot.id&&!userRoot.insertIds.includes(row.id));
 assert.equal(confirmed(afterUserRetired,f.current.chat).remaining.length,0);
});

test('正文、非空reasoning及其他extra变化均不当作默认字段差异忽略',()=>{
 for(const mutate of [chat=>{chat[1].mes='missing actual edit';},chat=>{chat[1].extra.reasoning='real reasoning';},chat=>{chat[1].extra.another='real extension data';}]){
  const f=fixture(),records=turn(f,true),disk=structuredClone(f.current.chat);mutate(disk);
  assert(confirmed(records,disk).remaining.length>0);
 }
});

test('旧文件与页面相同不能清除未保存编辑，删尾不能被较长旧文件的前缀冒充',()=>{
 const f=fixture(),old=structuredClone(f.current.chat);f.current.chat[0].mes='protected B';
 const edit=f.observer.capture({eventName:'message_edited',args:[0]}).records;
 f.current.chat=old;assert.equal(f.observer.settle().records.length,0);
 assert.equal(confirmed(edit,old).remaining.length,edit.length);
 const g=fixture();g.current.chat.push({mes:'user',is_user:true,extra:{reasoning:''}},{mes:'delete me',is_user:false});g.observer.reset();
 const longer=structuredClone(g.current.chat);g.current.chat.pop();
 const deletion=g.observer.capture({eventName:'message_deleted',args:[2]}).records;
 assert.equal(confirmed(deletion,longer).remaining.length,deletion.length);
});

test('收尾观察不跨聊天或文件身份，分叉中的未保存正文保留',()=>{
 const f=fixture(),rows=turn(f,true);
 f.current.identity={chatKey:'different',meta:{chatIntegrity:'new'}};
 assert.equal(f.observer.settle().records.length,0);
 const other=fixture();other.current.chat[0].mes='another protected branch';
 const branch=other.observer.capture({eventName:'message_edited',args:[0]}).records;
 const result=confirmed([...rows,...branch],f.current.chat);
 assert(branch.every(row=>result.remaining.some(item=>item.id===row.id)));
});

test('保存核对使用收尾后的稳定终态；读取期间无事件的变化也不核销',async()=>{
 const f=fixture(),pending=turn(f),file=structuredClone(f.current.chat),removed=[];let latest={code:'checking'},prepared=0;
 const verifier=createBackendVerifier({getSettings:()=>({enabled:true}),getContextReader:()=>({readCurrentChat:()=>f.current}),getLatestStatus:()=>latest,setStatus:s=>latest=s,
  refreshVisiblePanel:async()=>{},prioritizeFullBackupStatus:async(_key,status)=>status,readCurrentPending:async()=>pending,updateBackendMeta:async()=>{},
  createDisplayStatus:(code,shortText)=>({code,shortText}),preparePendingVerification:async()=>{prepared++;},
  readBackend:async()=>{f.current.chat[1].mes='changed without event during read';return {ok:true,chat:file};},
  deleteConfirmedPending:async records=>{removed.push(...records);return records.map(row=>row.id);},retryDelays:[]});
 await verifier.verifyBackendNow({chatKey:f.current.identity.chatKey});verifier.clearScheduledVerification();
 assert.equal(prepared,1);assert.equal(removed.length,0);assert.equal(latest.code,'unconfirmed');
});

test('准备收尾期间换聊天或同名文件身份时，旧核对不会开始读取或核销',async()=>{
 for(const change of [f=>{f.current.identity.chatKey='other';},f=>{f.current.identity.meta.chatIntegrity='file-two';}]){
  const f=fixture();let reads=0;
  const verifier=createBackendVerifier({getSettings:()=>({enabled:true}),getContextReader:()=>({readCurrentChat:()=>f.current}),getLatestStatus:()=>({code:'checking'}),
   preparePendingVerification:async()=>change(f),readCurrentPending:async()=>{reads++;return [];}});
  await verifier.verifyBackendNow({chatKey:'finalization-test'});verifier.clearScheduledVerification();assert.equal(reads,0);
 }
});

test('条件核销之后页面又变化时不发布已保存或备份待补全',async()=>{
 const f=fixture(),rows=turn(f),file=structuredClone(f.current.chat);let pending=rows,latest={code:'checking'};
 const verifier=createBackendVerifier({getSettings:()=>({enabled:true}),getContextReader:()=>({readCurrentChat:()=>f.current}),getLatestStatus:()=>latest,setStatus:s=>latest=s,
  refreshVisiblePanel:async()=>{},prioritizeFullBackupStatus:async(_key,status)=>status,readCurrentPending:async()=>pending,updateBackendMeta:async()=>{},
  createDisplayStatus:(code,shortText)=>({code,shortText}),readBackend:async()=>({ok:true,chat:file}),
  deleteConfirmedPending:async records=>{pending=[];f.current.chat[1].mes='later C';return records.map(row=>row.id);},retryDelays:[]});
 await verifier.verifyBackendNow({chatKey:f.current.identity.chatKey});verifier.clearScheduledVerification();
 assert.equal(latest.code,'unconfirmed');assert.doesNotMatch(latest.shortText,/酒馆已保存/);
});

test('生成尚未完成时，即使暂时文件相同也不核销；结束后才确认',async()=>{
 const f=fixture(),rows=turn(f);let pending=rows,generating=true,reads=0,latest={code:'checking'};
 const verifier=createBackendVerifier({getSettings:()=>({enabled:true}),getContextReader:()=>({readCurrentChat:()=>f.current}),getLatestStatus:()=>latest,setStatus:s=>latest=s,
  refreshVisiblePanel:async()=>{},prioritizeFullBackupStatus:async(_key,status)=>status,readCurrentPending:async()=>pending,updateBackendMeta:async()=>{},isGenerating:()=>generating,
  createDisplayStatus:(code,shortText)=>({code,shortText}),readBackend:async()=>{reads++;return {ok:true,chat:structuredClone(f.current.chat)};},
  deleteConfirmedPending:async records=>{pending=[];return records.map(row=>row.id);},retryDelays:[]});
 await verifier.verifyBackendNow({chatKey:f.current.identity.chatKey});assert.equal(reads,0);assert.equal(pending.length,rows.length);assert.equal(latest.code,'unconfirmed');
 generating=false;await verifier.verifyBackendNow({chatKey:f.current.identity.chatKey});verifier.clearScheduledVerification();assert.equal(pending.length,0);assert.equal(latest.code,'saved');
});
