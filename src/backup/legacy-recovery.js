import { hashCanonicalChat, hashCanonicalMessage,canonicalizeComparableMessage,stableStringify } from './canonicalize.js';
import { nativeChatHash, nativeMessageHash } from './native-content.js';

const rawOf = row => row?.message?.raw ?? row?.raw;
const timeOf = row => row?.updatedAt ?? row?.backedUpAt ?? row?.message?.backedUpAt ?? row?.createdAt ?? '';
const blocked = (reason,code='legacy-recovery-unconfirmed') => ({ ok:false,code, reason:`${reason}原数据已保留。` });
const validRaw = raw => raw && typeof raw === 'object' && !Array.isArray(raw);

// A segment retains an observed order. Its old starting floor is a coordinate
// hint, not a permanent message identity. No per-floor alternatives are mixed.
function segments(rows, source) {
  const ordered = rows.filter(row=>Number.isSafeInteger(row.messageIndex)&&row.messageIndex>=0&&validRaw(rawOf(row)))
    .sort((a,b)=>a.messageIndex-b.messageIndex);
  const result=[];
  for(const row of ordered){
    let segment=result.at(-1);
    if(!segment || row.messageIndex!==segment.start+segment.raws.length){
      segment={source,start:row.messageIndex,raws:[],records:[]};result.push(segment);
    }
    segment.raws.push(rawOf(row));segment.records.push(row);
  }
  return result;
}

// Sparse LCS through unique message identities. Repeated messages do not become
// arbitrary anchors; exact source order and the whole-chat checksum still apply.
export function alignLegacySequences(left,right) {
  const index=values=>{
    const map=new Map();values.forEach((raw,i)=>{if(!validRaw(raw))return;const key=nativeMessageHash(raw);map.set(key,map.has(key)?-1:i);});return map;
  };
  const a=index(left),b=index(right),pairs=[];
  for(const [key,j] of b){const i=a.get(key);if(i!==undefined&&i>=0&&j>=0)pairs.push({left:i,right:j});}
  pairs.sort((x,y)=>x.right-y.right);
  const tails=[],last=[],previous=[];
  pairs.forEach((pair,i)=>{
    let low=0,high=tails.length;
    while(low<high){const mid=(low+high)>>1;if(tails[mid]<pair.left)low=mid+1;else high=mid;}
    previous[i]=low?last[low-1]:-1;tails[low]=pair.left;last[low]=i;
  });
  const result=[];for(let i=last.at(-1)??-1;i>=0;i=previous[i])result.push(pairs[i]);
  return result.reverse();
}

const advanceHash=(state,text)=>{for(let i=0;i<text.length;i++)state=Math.imul(state^text.charCodeAt(i),16777619)>>>0;return state;};
const reverseHash=(state,text)=>{for(let i=text.length-1;i>=0;i--)state=(Math.imul(state,0x359c449b)^text.charCodeAt(i))>>>0;return state;};
function deletionStarts(prefix,tail,removed,constraint) {
  const remaining=prefix.length-removed,needed=constraint.chatLength-remaining;
  if(needed<0||tail.length<needed||!prefix.every(validRaw)||!tail.slice(0,needed).every(validRaw))return null;
  if(!/^[a-f\d]{8}$/i.test(constraint.canonicalChatHash))return [];
  const chunks=prefix.map(raw=>stableStringify(canonicalizeComparableMessage(raw))+','),forward=[advanceHash(2166136261,'[')],backward=[];
  for(const chunk of chunks)forward.push(advanceHash(forward.at(-1),chunk));
  const ending=tail.slice(0,needed).map(raw=>stableStringify(canonicalizeComparableMessage(raw))).join(',')+']';
  backward[prefix.length]=reverseHash(Number.parseInt(constraint.canonicalChatHash,16),ending);
  for(let index=prefix.length-1;index>=0;index--)backward[index]=reverseHash(backward[index+1],chunks[index]);
  const result=[];
  // The old checksum is reversible as a running state. This compares every
  // contiguous deletion boundary in linear text work; it never derives a body
  // from a checksum. Every match is rechecked with hashCanonicalChat below.
  for(let start=0;start+removed<=prefix.length;start++)if(forward[start]===backward[start+removed])result.push(start);
  return result;
}

function* spliceSegment(base,segment,constraint) {
  const links=alignLegacySequences(base,segment.raws),positions=new Set([segment.start]);
  for(const pair of links)positions.add(pair.left-pair.right);
  for(const start of positions){
    if(start<0||start>base.length)continue;
    const ends=new Set([Math.min(base.length,start+segment.raws.length)]);
    const last=links.at(-1);
    if(last)ends.add(Math.min(base.length,last.left+segment.raws.length-last.right));
    for(const end of ends)if(end>=start)yield [...base.slice(0,start),...segment.raws,...base.slice(end)];
  }
  const first=links[0],last=links.at(-1);
  if(!first)return;
  const oldStart=first.left-first.right,removed=oldStart-segment.start;
  if(removed<=0||oldStart>base.length)return;
  const suffix=base.slice(Math.min(base.length,last.left+segment.raws.length-last.right));
  // A shifted observed suffix can locate the size, but not the place, of one
  // contiguous deletion. Test complete deletion histories against the checksum;
  // never choose independently between the remaining messages.
  const starts=deletionStarts(base.slice(0,oldStart),[...segment.raws,...suffix],removed,constraint)
    ??Array.from({length:oldStart-removed+1},(_,index)=>index);
  for(const start of starts){
    yield [...base.slice(0,start),...base.slice(start+removed,oldStart),...segment.raws,...suffix];
  }
}

function uniqueBodies(rows) {
  const byIndex=new Map();
  for(const row of rows){
    if(!Number.isSafeInteger(row.messageIndex)||row.messageIndex<0||!validRaw(rawOf(row)))continue;
    const raw=rawOf(row),prior=byIndex.get(row.messageIndex);
    if(prior===null)continue;
    if(prior&&nativeMessageHash(prior)!==nativeMessageHash(raw))byIndex.set(row.messageIndex,null);
    else byIndex.set(row.messageIndex,raw);
  }
  return byIndex;
}

function complete(candidate,length,uncontested) {
  const result=candidate.slice(0,length);result.length=length;
  for(let index=0;index<length;index++){
    if(!validRaw(result[index]))result[index]=uncontested.get(index);
    if(!validRaw(result[index]))return null;
  }
  return result;
}

function numericVariants(rows) {
  const byIndex=new Map();let duplicate=false;
  for(const row of rows){if(byIndex.has(row.messageIndex)&&nativeMessageHash(rawOf(byIndex.get(row.messageIndex)))!==nativeMessageHash(rawOf(row)))duplicate=true;byIndex.set(row.messageIndex,row);}
  if(!duplicate)return [[...byIndex.values()].sort((a,b)=>a.messageIndex-b.messageIndex)];
  // Duplicate floors are not produced by the normal old store. If imported
  // records retain complete timestamp cohorts, keep those cohorts intact.
  const groups=new Map();
  for(const row of rows){const time=timeOf(row);if(!time)return [];if(!groups.has(time))groups.set(time,[]);groups.get(time).push(row);}
  const result=[...groups.values()].map(group=>group.sort((a,b)=>a.messageIndex-b.messageIndex));
  const shape=JSON.stringify(result[0].map(row=>row.messageIndex));
  return result.every(group=>new Set(group.map(row=>row.messageIndex)).size===group.length&&JSON.stringify(group.map(row=>row.messageIndex))===shape)?result:[];
}

function continuedCopies(target,runs,constraint,hasLaterPending) {
  const result=new Map(),baseHash=nativeChatHash(target);
  for(const run of runs){
    if(!['recent','full'].includes(run.source)||run.start>=target.length||run.start+run.raws.length<=target.length)continue;
    const overlap=target.length-run.start;
    if(run.raws.slice(0,overlap).some((raw,index)=>nativeMessageHash(raw)!==nativeMessageHash(target[run.start+index])))continue;
    if(run.records.slice(overlap).some(row=>!timeOf(row)||timeOf(row)<=constraint.updatedAt))continue;
    const candidate=[...target,...run.raws.slice(overlap)];result.set(nativeChatHash(candidate),candidate);
  }
  if(!result.size)return [target];
  // A strict extension is a continuation, not a second fork. Two different
  // tails remain separate even if one backup has a newer timestamp.
  const copies=[...result.values()].filter((candidate,_index,all)=>!all.some(other=>other.length>candidate.length&&candidate.every((raw,index)=>nativeMessageHash(raw)===nativeMessageHash(other[index]))));
  // Without a later protected message, a newly copied rollback is also
  // possible. Keep the proven deletion checkpoint as a manual alternative.
  if(!hasLaterPending&&!result.has(baseHash))copies.push(target);
  return copies;
}

export function recoverLegacyPending({chat,chatKey,records,recent=[],full=[],historical=[]}) {
  const structural=records.filter(row=>!Number.isInteger(row.messageIndex));
  let numeric=records.filter(row=>Number.isSafeInteger(row.messageIndex)&&row.messageIndex>=0);
  if(!structural.length){
    const target=structuredClone(chat);
    for(const row of [...numeric].sort((a,b)=>a.messageIndex-b.messageIndex)){
      if(!validRaw(rawOf(row))||row.messageIndex>target.length)return blocked('未保存消息不完整或尾部楼层不连续，');
      target[row.messageIndex]=structuredClone(rawOf(row));
    }
    return {ok:true,targetChat:target,coveredIds:records.map(row=>row.id)};
  }
  if(structural.some(row=>row.snapshotSaveProof||row.hashVersion!==2||!row.canonicalChatHash||!Number.isSafeInteger(row.chatLength)||row.chatLength<0||!row.updatedAt))return blocked('旧记录缺少足以确认聊天结果的内容或校验依据，','legacy-proof-missing');
  const latestTime=[...structural].map(row=>row.updatedAt).sort().at(-1);
  const constraints=structural.filter(row=>row.updatedAt===latestTime);
  const sameChat=rows=>rows.filter(row=>!row.chatKey||row.chatKey===chatKey);
  const sources={recent:sameChat(recent),full:sameChat(full),historical:sameChat(historical)};
  const copies=[...chat.map((raw,messageIndex)=>({raw,messageIndex,chatKey})),...sources.recent,...sources.full,...sources.historical,...numeric];
  // A missing old payload can be supplied by an identical message elsewhere,
  // including a copy whose old floor moved after deletion.
  const byCanonical=new Map();
  for(const row of copies)if(validRaw(rawOf(row))){const raw=rawOf(row),key=hashCanonicalMessage(raw);if(!byCanonical.has(key))byCanonical.set(key,new Map());byCanonical.get(key).set(nativeMessageHash(raw),raw);}
  numeric=numeric.map(row=>{
    if(validRaw(rawOf(row)))return row;
    const matches=byCanonical.get(row.canonicalHash);
    return matches?.size===1?{...row,message:{...row.message,raw:[...matches.values()][0]}}:row;
  });
  const runs=[...segments(sources.recent,'recent'),...segments(sources.full,'full')];
  const variants=numericVariants(numeric.filter(row=>validRaw(rawOf(row))));
  for(const variant of variants)runs.push(...segments(variant,'pending'));
  const historicalGroups=new Map();
  for(const row of sources.historical){const key=timeOf(row);if(!key)continue;if(!historicalGroups.has(key))historicalGroups.set(key,[]);historicalGroups.get(key).push(row);}
  for(const rows of historicalGroups.values())runs.push(...segments(rows,'historical').filter(run=>run.raws.length>1));
  const uncontested=uniqueBodies([...chat.map((raw,messageIndex)=>({raw,messageIndex})),...copies,...numeric]);
  const seeds=[chat,...runs.filter(run=>run.start===0).map(run=>run.raws)];
  const targets=new Map();
  for(const constraint of constraints){
    const tested=new Set(),checkpoints=new Map(),length=constraint.chatLength;
    const consider=candidate=>{
      const target=complete(candidate,length,uncontested);if(!target)return;
      const id=nativeChatHash(target);if(tested.has(id))return;tested.add(id);
      if(hashCanonicalChat(target)===constraint.canonicalChatHash)checkpoints.set(id,target);
    };
    for(const seed of seeds){
      consider(seed);
      // Each patch is an entire observed segment. A snapshot with gaps only
      // fills uncontested missing positions; gaps do not create new branches.
      for(const run of runs){
        const sparse=seed.slice();
        for(let index=0;index<run.raws.length;index++)sparse[run.start+index]=run.raws[index];
        consider(sparse);
        for(const candidate of spliceSegment(seed,run,constraint))consider(candidate);
      }
    }
    if(!checkpoints.size)return blocked('现有副本不足以核对某套完整旧聊天，','legacy-proof-mismatch');
    for(const checkpoint of checkpoints.values()){
      const present=new Set(checkpoint.map(nativeMessageHash));
      if(numeric.some(row=>(!row.updatedAt||row.updatedAt===constraint.updatedAt)&&validRaw(rawOf(row))&&!present.has(nativeMessageHash(rawOf(row)))
        &&(!checkpoint[row.messageIndex]||nativeMessageHash(checkpoint[row.messageIndex])!==nativeMessageHash(rawOf(row)))))return blocked('部分旧消息的先后关系无法确认，','legacy-order-uncertain');
      const later=numeric.filter(row=>row.updatedAt&&row.updatedAt>constraint.updatedAt);
      if(later.some(row=>!validRaw(rawOf(row))))return blocked('后续未保存消息缺少正文，','legacy-body-missing');
      const continuations=numericVariants(later);
      if(!continuations.length)return blocked('后续记录缺少可确认的连续分支，','legacy-order-uncertain');
      for(const rows of continuations){
        const target=checkpoint.slice();let continuous=true;
        for(const row of rows){if(row.messageIndex>target.length){continuous=false;break;}target[row.messageIndex]=rawOf(row);}
        if(continuous)for(const candidate of continuedCopies(target,runs,constraint,rows.some(row=>row.messageIndex>=constraint.chatLength)))targets.set(nativeChatHash(candidate),candidate);
      }
    }
  }
  if(!targets.size)return blocked('现有连续记录无法组成符合旧聊天校验的完整内容，');
  const choices=[...targets].map(([id,targetChat])=>({id,targetChat:structuredClone(targetChat),coveredIds:records.map(row=>row.id)}));
  if(choices.length===1)return {ok:true,...choices[0]};
  return {ok:false,needsChoice:true,reason:'发现多套完整的连续内容，请选择最后实际使用的一套。',choices};
}
