import { hashCanonicalChat } from './canonicalize.js';
import { nativeChatHash, nativeMessageHash } from './native-content.js';
import { isJournalRecord, recoverPendingJournal, confirmedJournalRecords } from './pending-journal.js';

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

// Legacy structural hashes are constraints, never substitutes for message text.
// Enumerate only bounded combinations of actual available message copies.
function legacyTarget({ chat, chatKey, records, recent, full, historical }) {
  const structural = records.filter(row => !Number.isInteger(row.messageIndex));
  const numeric = records.filter(row => Number.isSafeInteger(row.messageIndex) && row.messageIndex >= 0);
  if (!structural.length) {
    const target = structuredClone(chat);
    for (const row of [...numeric].sort((a,b)=>a.messageIndex-b.messageIndex)) {
      if (!rawOf(row) || row.messageIndex > target.length) return blocked('未保存消息不完整或尾部楼层不连续，');
      target[row.messageIndex] = structuredClone(rawOf(row));
    }
    return { ok: true, targetChat: target, coveredIds: records.map(row=>row.id) };
  }
  if (structural.some(row=>row.snapshotSaveProof || row.hashVersion !== 2 || !row.canonicalChatHash || !Number.isSafeInteger(row.chatLength) || row.chatLength < 0 || !row.updatedAt)) return blocked('旧记录缺少足以确认聊天结果的内容或校验依据，');
  const ordered = [...structural].sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt));
  const latest = ordered.at(-1);
  if (ordered.some(row=>row.updatedAt===latest.updatedAt && row.canonicalChatHash!==latest.canonicalChatHash)) return blocked('旧记录的先后关系无法确定，');
  const pools = Array.from({length:latest.chatLength},()=>new Map());
  const add = (index, raw) => {
    if(!Number.isSafeInteger(index)||index<0||index>=pools.length||!raw||typeof raw!=='object')return;
    pools[index].set(nativeMessageHash(raw),raw);
  };
  chat.forEach((raw,index)=>add(index,raw));
  for(const row of [...recent,...full,...historical,...numeric]) if(!row.chatKey||row.chatKey===chatKey) add(row.messageIndex,rawOf(row));
  let combinations=1;
  for(const pool of pools) {
    if(!pool.size)return blocked('无法找到组成完整聊天所需的消息正文，');
    combinations*=pool.size;
    if(combinations>64)return blocked('可用副本存在过多无法确定的组合，');
  }
  let candidates=[[]];
  for(const pool of pools)candidates=candidates.flatMap(prefix=>[...pool.values()].map(raw=>[...prefix,raw]));
  const matches=new Map();
  for(const candidate of candidates)if(hashCanonicalChat(candidate)===latest.canonicalChatHash)matches.set(nativeChatHash(candidate),candidate);
  if(matches.size!==1)return blocked(matches.size?'存在多个无法区分的聊天结果，':'现有消息副本与旧记录的校验信息不一致，');
  const target=structuredClone([...matches.values()][0]);
  for(const row of [...numeric].sort((a,b)=>a.messageIndex-b.messageIndex)) {
    if(row.updatedAt && row.updatedAt>latest.updatedAt) {
      if(!rawOf(row)||row.messageIndex>target.length)return blocked('后续未保存消息不完整或无法连续接续，');
      target[row.messageIndex]=structuredClone(rawOf(row));
    } else if((!row.updatedAt||row.updatedAt===latest.updatedAt)&&(!rawOf(row)||!target[row.messageIndex]||nativeMessageHash(rawOf(row))!==nativeMessageHash(target[row.messageIndex])))return blocked('旧消息与结构记录的先后关系无法确定，');
  }
  return {ok:true,targetChat:target,coveredIds:records.map(row=>row.id)};
}

export function recoverPendingTarget({chat,chatKey,pending,recent=[],full=[],historical=[]}) {
  if(pending.some(row=>row.pendingFormat&&row.pendingFormat!==1))return blocked('这些保护记录来自更新的版本，请先更新箱装，');
  if(pending.some(row=>row.chatKey!==chatKey))return blocked('保护记录不属于当前聊天，');
  const journal=pending.filter(isJournalRecord),legacy=pending.filter(row=>!isJournalRecord(row));
  if(!journal.length)return legacyTarget({chat,chatKey,records:legacy,recent,full,historical});
  const gaps=journal.filter(row=>row.pendingType==='observation_gap');
  if(gaps.length)return blocked('操作发生时缺少可靠的前一次观察，无法确定删除位置，');
  const bases=[chat];
  if(full.length&&full.every((row,index)=>row.messageIndex===index&&rawOf(row)))bases.push(full.map(rawOf));
  if(legacy.length) {
    const prepared=legacyTarget({chat,chatKey,records:legacy,recent,full,historical});
    if(prepared.ok)bases.push(prepared.targetChat);
  }
  const candidates=new Map();
  for(const base of bases) {
    const result=recoverPendingJournal({chat:base,chatKey,records:pending});
    if(!result.ok)continue;
    const proof=confirmedJournalRecords(pending,chatKey,result.targetChat);
    const covered=new Set([...result.coveredIds,...proof.ids]);
    // An old numeric snapshot can be the verified pre-operation baseline.
    for(const row of legacy)if(Number.isInteger(row.messageIndex)&&rawOf(row)&&base[row.messageIndex]
      && nativeMessageHash(rawOf(row))===nativeMessageHash(base[row.messageIndex]))covered.add(row.id);
    if(legacy.some(row=>!covered.has(row.id)))continue;
    candidates.set(result.targetHash,{...result,coveredIds:[...covered]});
  }
  if(candidates.size!==1)return blocked(candidates.size?'存在多个无法区分的恢复结果，':'现有聊天与新旧保护记录无法安全接续，');
  return includeMetadata([...candidates.values()][0],pending);
}
