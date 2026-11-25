import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageRecord,createStructuralPendingRecord } from '../src/backup/pending.js';
import { canonicalizeMessage } from '../src/backup/canonicalize.js';
import { createPendingRestorePlan,selectPendingRestoreBranch,validateRestorePlan } from '../src/backup/restore.js';
import { executeRestorePlan } from '../src/backup/restore-executor.js';
import { buildLegacyBranchModel } from '../src/ui/legacy-branch-dialog.js';
import { alignLegacySequences } from '../src/backup/legacy-recovery.js';
import { createPendingObserver } from '../src/backup/pending-journal.js';
const chatKey='character:legacy-sequence.png:test';
const old='2026-11-25T01:00:00.000Z',checkpoint='2026-11-25T01:01:00.000Z',later='2026-11-25T01:02:00.000Z';
const msg=mes=>({mes,send_date:'message-'+mes,is_user:false});
const chat=text=>text.split(' ').map(msg);
const backup=(values,start=0)=>values.map((raw,index)=>({...canonicalizeMessage(raw,index+start,later),chatKey}));
const numeric=(values,start=0,now=old)=>values.map((message,index)=>createMessageRecord({chatKey,messageIndex:start+index,kind:'new_message',message,now}));
const structural=(values,now=checkpoint)=>createStructuralPendingRecord({chatKey,chat:values,kind:'message_delete',now});
function recover(before,target,start){
  const pending=[...numeric(before),structural(target)],recent=backup(target.slice(start),start),original=structuredClone(pending);
  const plan=createPendingRestorePlan({chat:before,chatKey,pending,recent});
  assert.equal(plan.blockedReason,'');assert.deepEqual(plan.targetChat,target);assert.deepEqual(pending,original);return plan;
}

test('middle deletion is one shifted sequence, including a deletion before the first available new segment',()=>{
  const before=chat('A B C D E F'),target=chat('A C D E F G H');
  recover(before,target,2);
  const links=alignLegacySequences(before,target);assert.deepEqual(links.map(pair=>[pair.left,pair.right]),[[0,0],[2,1],[3,2],[4,3],[5,4]]);
});
test('multiple adjacent middle deletions keep the following sequence together',()=>recover(chat('A B C D E F G'),chat('A B E F G H'),3));
for(const tail of ['E','E F'])test('delete latest '+tail+' then continue without restoring deleted tail',()=>{
  const base=chat('A B C D'),target=chat('A B C D G H I'),before=chat('A B C D '+tail);
  const pending=[...numeric(before),structural(base),...numeric(target.slice(4),4,later)];
  const deduped=[...new Map(pending.map(row=>[row.id,row])).values()];
  const plan=createPendingRestorePlan({chat:before,chatKey,pending:deduped});assert.equal(plan.blockedReason,'');assert.deepEqual(plan.targetChat,target);
});
test('an edited continuous branch is never reconstructed as independently selected floors',()=>{
  const before=chat('A B C D1 E1'),target=chat('A B C D2 E2 F');
  recover(before,target,3);
});
test('branch divergence and rejoining leave common suffix outside the choice range',()=>{
  const f=ambiguous(),model=buildLegacyBranchModel(f.plan);
  assert.equal(model.firstIndex,3);assert.equal(model.commonSuffix,2);assert.equal(model.choices.length,2);
});
test('middle delete, continue, delete tail, continue uses the last complete state',()=>{
  const before=chat('A B C D E F'),base=chat('A C D E F'),target=chat('A C D E F I J');
  const pending=[...numeric(base),structural(base),...numeric(target.slice(5),5,later)];
  const plan=createPendingRestorePlan({chat:before,chatKey,pending});assert.equal(plan.blockedReason,'');assert.deepEqual(plan.targetChat,target);
});
test('dozens of shifted floors with theoretical per-floor combinations above 64 still recover one coherent state',()=>{
  const before=Array.from({length:90},(_,i)=>msg('message-'+i)),target=[...before.slice(0,20),...before.slice(21),msg('next-1'),msg('next-2')];
  const pending=[...numeric(target.slice(15),15),structural(target)],original=structuredClone(pending);
  const plan=createPendingRestorePlan({chat:before,chatKey,pending,recent:backup(target.slice(-20),target.length-20),full:backup(before)});
  assert.equal(plan.blockedReason,'');assert.deepEqual(plan.targetChat,target);assert.deepEqual(pending,original);
});
test('messages from old coordinates can move as one continuous segment',()=>{
  const target=chat('A C D E F G H'),before=chat('A C D E F');
  const pending=[...numeric(target.slice(1),2),structural(target)];
  const plan=createPendingRestorePlan({chat:before,chatKey,pending});assert.equal(plan.blockedReason,'');assert.deepEqual(plan.targetChat,target);
});
test('two complete reliable histories require a choice and never create D1 E2 or D2 E1',()=>{
  const {a,b,plan}=ambiguous();assert.equal(plan.selectionRequired,true);assert.equal(plan.branchChoices.length,2);
  assert.deepEqual(new Set(plan.branchChoices.map(choice=>choice.plan.targetChat.map(raw=>raw.mes).join(' '))),new Set([a,b].map(value=>value.map(raw=>raw.mes).join(' '))));
  assert.equal(selectPendingRestoreBranch(plan,'missing'),null);
});
for(const option of [0,1])test('choose complete branch '+option+'; protect originals before changing chat and save only that branch',async()=>{
  const f=ambiguous(),choice=f.plan.branchChoices[option],selected=selectPendingRestoreBranch(f.plan,choice.id),original=structuredClone(f.pending),pending=f.pending.slice(),current=structuredClone(f.a);
  let saved;const result=await executeRestorePlan({plan:selected,readCurrent:async()=>({ok:true,chat:current,identity:{chatKey}}),readPending:async()=>pending,
    writePending:async rows=>{assert.deepEqual(current,f.a);pending.push(...rows);},render:async()=>{},save:async()=>{saved=structuredClone(current);}});
  assert.equal(result.ok,true);assert.deepEqual(saved,choice.plan.targetChat);assert.deepEqual(pending.slice(0,original.length),original);
  assert.equal(pending.filter(row=>row.pendingType==='operation').length,1);
});
test('missing message text is blocked without changing original records',()=>{
  const before=chat('A B'),target=chat('A B MISSING C'),pending=[structural(target)],snapshot=structuredClone(pending);
  const plan=createPendingRestorePlan({chat:before,chatKey,pending,recent:backup(chat('C'),3)});assert(plan.blockedReason);assert.equal(plan.selectionRequired,undefined);assert.deepEqual(pending,snapshot);
});
test('a selected branch is still guarded against chat changes, pending changes and altered target payloads',()=>{
  const f=ambiguous(),selected=selectPendingRestoreBranch(f.plan,f.plan.branchChoices[1].id);
  assert.equal(validateRestorePlan({plan:selected,chat:f.a,chatKey,pending:f.pending}).ok,true);
  assert.equal(validateRestorePlan({plan:selected,chat:[...f.a,msg('new')],chatKey,pending:f.pending}).ok,false);
  assert.equal(validateRestorePlan({plan:selected,chat:f.a,chatKey,pending:[]}).ok,false);
  selected.targetChat[3].mes='forged';assert.equal(validateRestorePlan({plan:selected,chat:f.a,chatKey,pending:f.pending}).ok,false);
});
test('an unselected branch plan cannot execute or write protection records',async()=>{
  const f=ambiguous();let writes=0;
  const result=await executeRestorePlan({plan:f.plan,readCurrent:async()=>({ok:true,chat:f.a,identity:{chatKey}}),readPending:async()=>f.pending,writePending:async()=>writes++,render:async()=>{},save:async()=>{}});
  assert.equal(result.ok,false);assert.equal(writes,0);
});

test('a newer backup timestamp alone cannot overrule the reliable whole-chat result',()=>{
  const a=chat('A B C D1 E1'),b=chat('A B C D2 E2');
  const plan=createPendingRestorePlan({chat:a,chatKey,pending:[structural(a)],full:backup(b)});
  assert.equal(plan.blockedReason,'');assert.deepEqual(plan.targetChat,a);
});
test('later imported cohorts remain whole branches instead of selecting each floor or the latest timestamp',()=>{
  const base=chat('A B C'),a=chat('D1 E1'),b=chat('D2 E2');
  const pending=[structural(base),...numeric(a,3,later).map(row=>({...row,id:row.id+':a'})),...numeric(b,3,'2026-11-25T01:03:00.000Z').map(row=>({...row,id:row.id+':b'}))];
  const plan=createPendingRestorePlan({chat:base,chatKey,pending});assert.equal(plan.selectionRequired,true);assert.equal(plan.branchChoices.length,2);
  assert.deepEqual(new Set(plan.branchChoices.map(choice=>choice.plan.targetChat.map(raw=>raw.mes).join(' '))),new Set(['A B C D1 E1','A B C D2 E2']));
});
test('a new ordered operation can disambiguate and follow an old complete branch',()=>{
  const f=ambiguous(),live={ok:true,chat:structuredClone(f.b),identity:{chatKey,meta:{}}},observer=createPendingObserver({readCurrent:()=>live,now:()=>later});
  observer.reset();live.chat.pop();const records=observer.capture({eventName:'message_deleted',args:[]}).records;
  const plan=createPendingRestorePlan({chat:f.a,chatKey,pending:[...f.pending,...records],full:backup(f.b)});
  assert.equal(plan.blockedReason,'');assert.deepEqual(plan.targetChat,live.chat);assert.equal(plan.selectionRequired,undefined);
});
test('contiguous-deletion checksum filtering handles first/middle/last prefix positions, multiple deletions and UTF-16 text',()=>{
  for(const count of [1,2,3])for(const start of [0,1,4,7]){
    const before=Array.from({length:15},(_,i)=>msg(`中文🙂 ${i}`)),target=[...before.slice(0,start),...before.slice(start+count),msg('后续🦋')];
    recover(before,target,target.length-3);
  }
});
test('a protected continuation is completed by an overlapping recent sequence beyond the old structural length',()=>{
  const before=chat('A B C D E'),base=chat('A B C D'),target=chat('A B C D G H I');
  const pending=[structural(base),...numeric(chat('G'),4,later)];
  const plan=createPendingRestorePlan({chat:before,chatKey,pending,recent:backup(target.slice(3),3)});
  assert.equal(plan.blockedReason,'');assert.deepEqual(plan.targetChat,target);
});
test('a fresh backup alone cannot silently reinsert a deleted old tail; require a complete-state choice',()=>{
  const before=chat('A B C D E'),base=chat('A B C D'),pending=[structural(base)];
  const plan=createPendingRestorePlan({chat:before,chatKey,pending,recent:backup(before.slice(3),3)});
  assert.equal(plan.selectionRequired,true);assert.deepEqual(new Set(plan.branchChoices.map(choice=>choice.plan.targetChat.length)),new Set([4,5]));
});
test('divergent backed-up continuations are not decided by timestamp or mixed across messages',()=>{
  const base=chat('A B C D'),a=chat('A B C D G H1 I1'),b=chat('A B C D G H2 I2'),pending=[structural(base),...numeric(chat('G'),4,later)];
  const plan=createPendingRestorePlan({chat:base,chatKey,pending,recent:backup(a.slice(3),3),full:backup(b)});
  assert.equal(plan.selectionRequired,true);assert.equal(plan.branchChoices.length,2);
  assert.deepEqual(new Set(plan.branchChoices.map(choice=>choice.plan.targetChat.map(raw=>raw.mes).join(' '))),new Set([a,b].map(value=>value.map(raw=>raw.mes).join(' '))));
});
test('an unrelated edit is not evidence to reinsert a previously deleted tail',()=>{
  const base=chat('A B C D'),before=chat('A B C D E'),edited=chat('A2 B C D E');
  const pending=[structural(base),createMessageRecord({chatKey,messageIndex:0,kind:'message_edit',message:edited[0],now:later})];
  const plan=createPendingRestorePlan({chat:before,chatKey,pending,recent:backup(edited)});
  assert.equal(plan.selectionRequired,true);assert.deepEqual(new Set(plan.branchChoices.map(choice=>choice.plan.targetChat.length)),new Set([4,5]));
});
test('a second equally dated known branch with missing bodies cannot be silently discarded',()=>{
  const f=ambiguous(),plan=createPendingRestorePlan({chat:f.a,chatKey,pending:f.pending});
  assert(plan.blockedReason);assert.equal(plan.selectionRequired,undefined);assert.equal(plan.targetChat,undefined);
});

function ambiguous(){
  const a=chat('A B C D1 E1 F G'),b=chat('A B C D2 E2 F G');
  const pending=[{...structural(a),id:chatKey+':old-a'},{...structural(b),id:chatKey+':old-b'}];
  const plan=createPendingRestorePlan({chat:a,chatKey,pending,full:backup(b)});return {a,b,pending,plan};
}
