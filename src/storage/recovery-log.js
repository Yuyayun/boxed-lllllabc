import {chatLogRef} from './runtime-log-labels.js';

export const newRecoveryLogId=()=>globalThis.crypto?.randomUUID?.()??`recovery-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
export function recordRecoverySafely(record,event){try{Promise.resolve(record(event)).catch(()=>{});}catch{/* Diagnostics cannot change recovery/save outcomes. */}}

// Diagnostic events never wait in the backup/save path. Bound both remembered
// outcomes and queued sends, and cool down after a failed connection.
export function createRecoveryLogRecorder({send=async()=>false,getStorageMode=()=> 'indexeddb',now=()=>Date.now(),maxQueued=32}={}){
 const seen=new Map(),contexts=new Map();let tail=Promise.resolve(),queued=0,unavailableUntil=0;
 function record(details){
  const chatRef=chatLogRef(details.chatKey),key=details.stage==='restore-blocked'?chatRef+':'+details.errorCode:details.recoveryId+':'+details.stage;
  const previous=seen.get(key);
  if(!chatRef||queued>=maxQueued||now()<unavailableUntil||previous!==undefined&&(details.stage!=='restore-blocked'||now()-previous<60000))return;
  if(seen.size>=256)seen.delete(seen.keys().next().value);seen.set(key,now());
  if(details.recoverySource){if(contexts.size>=256&&!contexts.has(details.recoveryId))contexts.delete(contexts.keys().next().value);contexts.set(details.recoveryId,details.recoverySource);}
  const event={kind:'restore',recoveryId:details.recoveryId,chatRef,stage:details.stage,recoverySource:details.recoverySource??contexts.get(details.recoveryId)??'unknown',storageMode:getStorageMode()};
  for(const field of ['targetCount','selectedOption','candidateCount','errorCode'])if(details[field]!==undefined)event[field]=details[field];
  queued++;
  tail=tail.then(async()=>{if(now()<unavailableUntil)return;try{await send(event);}catch{unavailableUntil=now()+60000;}}).finally(()=>{queued--;});
 }
 return {record,idle:()=>tail};
}
