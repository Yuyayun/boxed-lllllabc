import { nativeChatHash, nativeMessageHash } from './native-content.js';
import { isJournalRecord, recoverPendingJournal, confirmedJournalRecords } from './pending-journal.js';
import { recoverLegacyPending as legacyTarget } from './legacy-recovery.js';

const blocked = reason => ({ ok: false, reason: `${reason}原数据已保留。` });
const rawOf = row => row?.message?.raw ?? row?.raw;
function includeMetadata(result,pending) {
  if(!result.ok)return result;
  const covered=new Set(result.coveredIds),roots=pending.filter(row=>covered.has(row.id)&&row.pendingType==='operation');
  const replaced=new Set(roots.flatMap(row=>(row.supersedes??[]).map(item=>item.id)));
  const metadata=roots.filter(row=>row.restoreMetadata&&row.snapshotSaveProof&&!replaced.has(row.id));
  if(metadata.length>1)return blocked('聊天设置存在多个无法区分的恢复结果，');
  return metadata.length?{...result,targetMetadata:structuredClone(metadata[0].restoreMetadata),targetSnapshotSaveProof:structuredClone(metadata[0].snapshotSaveProof)}:result;
}

export function recoverPendingTarget({chat,chatKey,pending,recent=[],full=[],historical=[]}) {
  if(pending.some(row=>row.pendingFormat&&row.pendingFormat!==1))return blocked('这些保护记录来自更新的版本，请先更新箱装，');
  if(pending.some(row=>row.chatKey!==chatKey))return blocked('保护记录不属于当前聊天，');
  const journal=pending.filter(isJournalRecord),legacy=pending.filter(row=>!isJournalRecord(row));
  if(!journal.length)return legacyTarget({chat,chatKey,records:legacy,recent,full,historical});
  const gaps=journal.filter(row=>row.pendingType==='observation_gap');
  if(gaps.length)return blocked('操作发生时缺少可靠的前一次观察，无法确定删除位置，');
  const bases=[{chat,legacyIds:[]}];
  let legacyChoices=false;
  if(full.length&&full.every((row,index)=>row.messageIndex===index&&rawOf(row)))bases.push({chat:full.map(rawOf),legacyIds:[]});
  if(legacy.length) {
    const prepared=legacyTarget({chat,chatKey,records:legacy,recent,full,historical});
    if(prepared.ok)bases.push({chat:prepared.targetChat,legacyIds:prepared.coveredIds});
    else if(prepared.needsChoice){legacyChoices=true;for(const choice of prepared.choices)bases.push({chat:choice.targetChat,legacyIds:choice.coveredIds});}
  }
  const candidates=new Map();
  for(const {chat:base,legacyIds} of bases) {
    const result=recoverPendingJournal({chat:base,chatKey,records:pending});
    if(!result.ok)continue;
    const proof=confirmedJournalRecords(pending,chatKey,result.targetChat);
    const covered=new Set([...result.coveredIds,...proof.ids,...legacyIds]);
    // An old numeric snapshot can be the verified pre-operation baseline.
    for(const row of legacy)if(Number.isInteger(row.messageIndex)&&rawOf(row)&&base[row.messageIndex]
      && nativeMessageHash(rawOf(row))===nativeMessageHash(base[row.messageIndex]))covered.add(row.id);
    if(legacy.some(row=>!covered.has(row.id)))continue;
    candidates.set(result.targetHash,{...result,coveredIds:[...covered]});
  }
  if(candidates.size>1&&legacyChoices){
    const choices=[...candidates.values()].map(result=>includeMetadata(result,pending));
    if(choices.every(choice=>choice.ok))return {ok:false,needsChoice:true,reason:'发现多套完整的连续内容，请选择最后实际使用的一套。',choices};
  }
  if(candidates.size!==1)return blocked(candidates.size?'存在多个无法区分的恢复结果，':'现有聊天与新旧保护记录无法安全接续，');
  return includeMetadata([...candidates.values()][0],pending);
}
