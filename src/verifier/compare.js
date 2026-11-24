import {
  CANONICAL_HASH_VERSION,
  canonicalizeMessage,
  hashCanonicalChat,
  hashCanonicalMessage,
  stableStringify,
  stripChatHeader,
} from "../backup/canonicalize.js";
import { confirmedJournalRecords, isJournalRecord, pendingRecordFingerprint } from '../backup/pending-journal.js';
import { nativeChatHash, nativeMessageHash } from '../backup/native-content.js';

export function comparePendingWithBackend(pendingRecords, backendChat, { recentLimit,snapshotIds=new Set() } = {}) {
  const backendMessages = stripChatHeader(backendChat);
  const confirmedIds = [];
  const remaining = [];
  const records=pendingRecords??[], journal=confirmedJournalRecords(records,records[0]?.chatKey,backendMessages,{snapshotIds});
  const journalIds=new Set(journal.ids),proofs=new Map(),byId=new Map(records.map(row=>[row.id,row]));

  for (const record of pendingRecords ?? []) {
    // Snapshot restores additionally require the asynchronous metadata proof.
    if (record.snapshotSaveProof&&!snapshotIds.has(record.id)) { remaining.push(record); continue; }
    const observedSaved=record.pendingFormat===1&&record.pendingType==='observation_gap'&&record.chatLength===backendMessages.length&&record.nativeChatHash===nativeChatHash(backendMessages);
    if(journalIds.has(record.id)||observedSaved) {
      const detail=journal.proofs?.get(record.id),limit=Math.max(1,Math.min(200,Number.parseInt(recentLimit??record.recentLimit,10)||20)),recentCount=Math.min(limit,backendMessages.length);
      proofs.set(record.id,{verifiedNativeHash:observedSaved?record.nativeChatHash:journal.hash,verifiedRecordHash:pendingRecordFingerprint(record),
        verifiedLength:backendMessages.length,verifiedRecentHash:nativeChatHash(backendMessages.slice(-limit)),
        verifiedRecentCount:recentCount,verifiedRecentFirstIndex:recentCount?backendMessages.length-recentCount:null,verifiedRecentLastIndex:recentCount?backendMessages.length-1:null,
        verifiedHistoricalCopies:(detail?.historical??[]).filter(item=>item.messageIndex<backendMessages.length-limit),
        ...(detail?.superseded?{verifiedSupersededBy:detail.via,verifiedSupersedingHash:pendingRecordFingerprint(byId.get(detail.via)),
          verifiedSupersedingHistoricalCopies:(journal.proofs?.get(detail.via)?.historical??[]).filter(item=>item.messageIndex<backendMessages.length-limit)}:{})});
      confirmedIds.push(record.id);continue;
    }
    if(record.pendingFormat){remaining.push(record);continue;}
    if (!Number.isInteger(record.messageIndex)) {
      const length=record.chatLength;
      const postDeleteTail=record.kind==='message_delete'&&Number.isInteger(length)&&backendMessages.length>length
        &&hashCanonicalChat(backendMessages.slice(0,length))===record.canonicalChatHash
        &&backendMessages.slice(length).every((message,offset)=>records.some(row=>row.messageIndex===length+offset&&row.kind==='new_message'
          &&row.updatedAt>record.updatedAt&&row.message?.raw&&nativeMessageHash(row.message.raw)===nativeMessageHash(message)));
      const unresolvedEarlier=records.some(row=>Number.isInteger(row.messageIndex)&&row.updatedAt<record.updatedAt&&row.message?.raw
        &&(!backendMessages[row.messageIndex]||nativeMessageHash(row.message.raw)!==nativeMessageHash(backendMessages[row.messageIndex])));
      if (!unresolvedEarlier&&record.hashVersion === CANONICAL_HASH_VERSION && record.canonicalChatHash
        && (hashCanonicalChat(backendMessages) === record.canonicalChatHash||postDeleteTail)) {
        confirmedIds.push(record.id);
        proofs.set(record.id,{verifiedFullChatHash:hashCanonicalChat(backendMessages)});
      } else {
        remaining.push(record);
      }
      continue;
    }

    const backendMessage = backendMessages[record.messageIndex];
    if (!backendMessage) {
      remaining.push(record);
      continue;
    }

    const backendHash = hashCanonicalMessage(backendMessage);
    const isExactMatch = backendHash === record.canonicalHash && (!record.message?.raw || nativeMessageHash(record.message.raw)===nativeMessageHash(backendMessage));
    const isLegacyMatch = record.hashVersion !== CANONICAL_HASH_VERSION
      && matchesLegacyMessage(record, backendMessage);
    if (isExactMatch || isLegacyMatch) {
      confirmedIds.push(record.id);
    } else {
      remaining.push(record);
    }
  }

  for(const [id,proof] of proofs)if(proof.verifiedSupersededBy&&proofs.has(proof.verifiedSupersededBy)) {
    const source=proofs.get(proof.verifiedSupersededBy);(source.verifiedDependencies??=[]).push({id,fingerprint:pendingRecordFingerprint(byId.get(id))});
  }
  return {
    confirmedIds,
    remaining,
    proofs,
  };
}

function matchesLegacyMessage(record, backendMessage) {
  if (!record.message || !backendMessage) {
    return false;
  }

  const backendSnapshot = canonicalizeMessage(
    backendMessage,
    record.messageIndex,
    record.message.backedUpAt,
  );
  return stableStringify(toLegacyComparable(record.message))
    === stableStringify(toLegacyComparable(backendSnapshot));
}

function toLegacyComparable(message) {
  return {
    role: message?.role ?? "",
    name: message?.name ?? "",
    isUser: Boolean(message?.isUser),
    isSystem: Boolean(message?.isSystem),
    sendDate: message?.sendDate ?? "",
    text: message?.text ?? "",
    swipeIndex: Number(message?.swipeIndex) || 0,
    swipes: (Array.isArray(message?.swipes) ? message.swipes : []).map((swipe) => ({
      index: Number(swipe?.index) || 0,
      text: String(swipe?.text ?? ""),
      raw: swipe?.raw,
    })),
  };
}
