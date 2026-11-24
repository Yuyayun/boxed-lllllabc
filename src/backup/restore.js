import { canonicalizeMessage, hashCanonicalChat, stableStringify } from "./canonicalize.js";
import { createMessageRecord, createStructuralPendingRecord } from "./pending.js";
import { recoverPendingTarget } from './pending-recovery.js';
import { nativeChatHash, sameNativeChat,nativeMessageHash,nativeMessageText,cacheNativeHash,sha256Text } from './native-content.js';
import { pendingRecordFingerprint } from './pending-journal.js';

export function createPendingRestorePlan({ chat, chatKey, pending, recent = [], full = [], historical = [],chatIntegrity }) {
  const safeChat = Array.isArray(chat) ? chat : [];
  const records = sortPending(pending);
  const base = createPlanBase({
    source: "pending",
    chat: safeChat,
    chatKey,
    pending: records,
    pendingScopeIndexes: null,
  });
  if(chatIntegrity!==undefined)base.baseIntegrity=chatIntegrity;
  if(chatIntegrity!==undefined&&records.some(row=>row.chatIntegrity&&row.chatIntegrity!==chatIntegrity))return blockPlan(base,'聊天文件身份已经变化，不能直接合并这些保护记录；原数据已保留。');

  if (!records.length) {
    return blockPlan(base, "没有可恢复的未保存变更。");
  }
  if(records.some(row=>row?.chatKey!==chatKey||Number.isInteger(row.messageIndex)&&(row.messageIndex<0||!Number.isSafeInteger(row.messageIndex))))return blockPlan(base,'未保存变更的聊天归属或楼层信息无效，原数据已保留。');

  if (records.some((record) => !Number.isInteger(record?.messageIndex))) {
    const result = recoverPendingTarget({chat:safeChat,chatKey,pending:records,recent,full,historical});
    if(!result.ok)return blockPlan(base,result.reason);
    return {...createTargetPlan(base,safeChat,result.targetChat,result.coveredIds),...(result.targetMetadata?{targetMetadata:result.targetMetadata,targetSnapshotSaveProof:result.targetSnapshotSaveProof,targetMetadataHash:sha256Text(nativeMessageText(result.targetMetadata))}:{})};
  }

  if (hasDuplicateIndexes(records)) {
    return blockPlan(base, "未保存变更包含重复楼层，无法确定恢复顺序。");
  }

  if (records.some((record) => !hasRestorableRaw(record?.message))) {
    return blockPlan(base, "未保存变更缺少完整消息，无法安全恢复。");
  }

  const replacements = records
    .filter((record) => record.messageIndex < safeChat.length)
    .map((record) => toRestoreItem(record.messageIndex, record.message));
  const appendRecords = records.filter((record) => record.messageIndex >= safeChat.length);

  if (appendRecords.length && appendRecords[0].messageIndex !== safeChat.length) {
    return blockPlan(base, `未保存变更缺少第 ${safeChat.length} 层，无法从当前末尾连续恢复。`);
  }

  if (!isContinuous(appendRecords.map((record) => record.messageIndex))) {
    return blockPlan(base, "未保存变更的尾部楼层不连续，无法安全恢复。");
  }

  return finishPlan(base, {
    replacements,
    appends: appendRecords.map((record) => toRestoreItem(record.messageIndex, record.message)),
  });
}

export function createRecentRestoreOptions({ chat, recent }) {
  const startIndex = Array.isArray(chat) ? chat.length : 0;
  const byIndex = new Map(
    (Array.isArray(recent) ? recent : [])
      .filter((record) => Number.isInteger(record?.messageIndex))
      .map((record) => [record.messageIndex, record]),
  );
  const endIndexes = [];

  for (let index = startIndex; ; index += 1) {
    const record = byIndex.get(index);
    if (!record || !hasRestorableRaw(record)) {
      break;
    }
    endIndexes.push(index);
  }

  return {
    startIndex,
    endIndexes,
    lastIndex: endIndexes.at(-1) ?? null,
  };
}

export function createRecentRestorePlan({ chat, chatKey, recent, pending, endIndex }) {
  const safeChat = Array.isArray(chat) ? chat : [];
  const safeRecent = Array.isArray(recent) ? recent : [];
  const options = createRecentRestoreOptions({ chat: safeChat, recent: safeRecent });
  const selectedEnd = Number(endIndex);
  const selectedIndexes = options.endIndexes.filter((index) => index <= selectedEnd);
  const base = createPlanBase({
    source: "recent",
    chat: safeChat,
    chatKey,
    pending,
    pendingScopeIndexes: selectedIndexes,
  });

  if (!options.endIndexes.length) {
    return blockPlan(base, `最近楼层备份中没有可从第 ${options.startIndex} 层开始恢复的连续内容。`);
  }

  if (!options.endIndexes.includes(selectedEnd)) {
    return blockPlan(base, "请选择有效的连续恢复终点。");
  }

  const byIndex = new Map(safeRecent.map((record) => [record.messageIndex, record]));
  const conflicts = sortPending(pending).filter((record) => selectedIndexes.includes(record?.messageIndex));

  return finishPlan({
    ...base,
    pendingConflicts: conflicts,
  }, {
    replacements: [],
    appends: selectedIndexes.map((index) => toRestoreItem(index, byIndex.get(index))),
  });
}

export function createHistoricalRestorePlan({ chat, chatKey, historical, pending, messageIndex }) {
  const safeChat = Array.isArray(chat) ? chat : [];
  const safeHistorical = Array.isArray(historical) ? historical : [];
  const selectedIndex = Number(messageIndex);
  const base = createPlanBase({
    source: "historical",
    chat: safeChat,
    chatKey,
    pending,
    pendingScopeIndexes: Number.isInteger(selectedIndex) ? [selectedIndex] : [],
  });

  if (!Number.isInteger(selectedIndex) || selectedIndex < 0) {
    return blockPlan(base, "请选择有效的历史楼层备份。");
  }

  const record = safeHistorical.find((item) => item?.messageIndex === selectedIndex);
  if (!record || record.chatKey !== chatKey) {
    return blockPlan(base, `没有找到第 ${selectedIndex} 层的历史备份。`);
  }

  if (selectedIndex >= safeChat.length) {
    return blockPlan(base, `当前聊天不存在第 ${selectedIndex} 层，历史备份只支持同编号替换。`);
  }

  if (!hasRestorableRaw(record.message)) {
    return blockPlan(base, `第 ${selectedIndex} 层历史备份缺少完整消息，无法安全恢复。`);
  }

  const conflicts = sortPending(pending).filter((item) => item?.messageIndex === selectedIndex);
  return finishPlan({
    ...base,
    pendingConflicts: conflicts,
  }, {
    replacements: [toRestoreItem(selectedIndex, record.message)],
    appends: [],
  });
}

export function createFullRestorePlan({ chat, chatKey, fullMessages, pending }) {
  const safeChat = Array.isArray(chat) ? chat : [];
  const records = Array.isArray(fullMessages) ? fullMessages : [];
  const base = createPlanBase({
    source: "full",
    chat: safeChat,
    chatKey,
    pending,
    pendingScopeIndexes: null,
  });

  if (!records.length) {
    return blockPlan(base, "没有可恢复的完整聊天备份。");
  }

  if (records.some((record, index) => record?.messageIndex !== index)) {
    return blockPlan(base, "完整聊天备份楼层不连续，无法安全覆盖恢复。");
  }

  if (records.some((record) => record?.chatKey && record.chatKey !== chatKey)) {
    return blockPlan(base, "完整聊天备份不属于当前聊天。");
  }

  if (records.some((record) => !hasRestorableRaw(record))) {
    return blockPlan(base, "完整聊天备份缺少完整消息，无法安全恢复。");
  }

  const targetChat = records.map((record) => {const raw=cloneValue(record.raw);cacheNativeHash(raw,nativeMessageText(record.raw),nativeMessageHash(record.raw));return raw;});
  const overlapLength = Math.min(safeChat.length, records.length);
  const replacements = [];
  for (let index = 0; index < overlapLength; index += 1) {
    if (!sameNativeChat([safeChat[index]],[targetChat[index]])) {
      replacements.push(toRestoreItem(index, records[index]));
    }
  }
  const appends = records
    .slice(safeChat.length)
    .map((record) => toRestoreItem(record.messageIndex, record));
  const deletions = Array.from(
    { length: Math.max(0, safeChat.length - records.length) },
    (_, offset) => ({ messageIndex: records.length + offset }),
  );

  if (!replacements.length && !appends.length && !deletions.length) {
    return blockPlan({
      ...base,
      targetChat,
      targetNativeHash:nativeChatHash(targetChat),
      baseBackupHash: hashCanonicalChat(targetChat),
    }, "当前聊天已经与完整聊天备份一致。");
  }

  return finishPlan({
    ...base,
    targetChat,
    targetNativeHash:nativeChatHash(targetChat),
    baseBackupHash: hashCanonicalChat(targetChat),
    pendingConflicts: sortPending(pending),
  }, {
    replacements,
    appends,
    deletions,
  });
}

export function validateRestorePlan({ plan, chat, chatKey, pending }) {
  if (!plan || plan.blockedReason) {
    return invalid(plan?.blockedReason || "恢复计划不可用。");
  }

  const safeChat = Array.isArray(chat) ? chat : [];
  if (chatKey !== plan.chatKey) {
    return invalid("当前聊天已经切换，请重新预览。");
  }

  if (safeChat.length !== plan.baseChatLength || hashCanonicalChat(safeChat) !== plan.baseChatHash) {
    return invalid("当前聊天内容已经变化，请重新预览。");
  }
  if(plan.baseNativeHash && nativeChatHash(safeChat)!==plan.baseNativeHash)return invalid('当前聊天内容已经变化，请重新预览。');
  if(plan.targetNativeHash && nativeChatHash(plan.targetChat)!==plan.targetNativeHash)return invalid('恢复目标已经变化，请重新预览。');
  if(plan.targetMetadataHash&&sha256Text(nativeMessageText(plan.targetMetadata))!==plan.targetMetadataHash)return invalid('待恢复的聊天设置已经变化，请重新预览。');

  const pendingHash = hashPendingRecords(pending, plan.pendingScopeIndexes);
  if (pendingHash !== plan.basePendingHash) {
    return invalid(plan.source === "recent"
      ? "相关未保存变更已经变化，请重新预览。"
      : "未保存变更已经变化，请重新预览。");
  }
  if(plan.targetItemsHash&&restoreItemsHash(plan)!==plan.targetItemsHash)return invalid('恢复消息副本已经变化，请重新预览。');

  if ([...plan.replacements, ...plan.appends].some((item) => !hasRestorableRaw(item?.backup))) {
    return invalid("恢复数据已经变化，请重新预览。");
  }

  if (plan.source === "full") {
    if (!Array.isArray(plan.targetChat)
      || hashCanonicalChat(plan.targetChat) !== plan.baseBackupHash) {
      return invalid("完整聊天备份已经变化，请重新预览。");
    }
  }

  return { ok: true, reason: "" };
}

export function applyRestorePlan(chat, plan) {
  if (!Array.isArray(chat)) {
    throw new TypeError("当前聊天不可修改。");
  }

  const snapshot = Array.isArray(plan.targetChat) ? {
    fullChat: cloneValue(chat),
  } : {
    originalLength: chat.length,
    replacements: plan.replacements.map((item) => ({
      messageIndex: item.messageIndex,
      raw: cloneValue(chat[item.messageIndex]),
    })),
  };

  try {
    if (Array.isArray(plan.targetChat)) {
      chat.splice(0, chat.length, ...cloneValue(plan.targetChat));
      return snapshot;
    }

    for (const item of plan.replacements) {
      chat[item.messageIndex] = cloneValue(item.raw);
    }

    for (const item of plan.appends) {
      if (item.messageIndex !== chat.length) {
        throw new Error(`恢复楼层不连续：预期第 ${chat.length} 层。`);
      }
      chat.push(cloneValue(item.raw));
    }
  } catch (error) {
    rollbackRestorePlan(chat, snapshot);
    throw error;
  }

  return snapshot;
}

export function rollbackRestorePlan(chat, snapshot) {
  if (!Array.isArray(chat) || !snapshot) {
    return;
  }

  if (Array.isArray(snapshot.fullChat)) {
    chat.splice(0, chat.length, ...cloneValue(snapshot.fullChat));
    return;
  }

  chat.length = snapshot.originalLength;
  for (const item of snapshot.replacements ?? []) {
    chat[item.messageIndex] = cloneValue(item.raw);
  }
}

export function createRestorePendingRecords({ plan, chat, chatKey, now }) {
  if (plan?.source === "pending") {
    return [];
  }

  if (plan?.source === "full") {
    return [createStructuralPendingRecord({
      chatKey,
      kind: "restore",
      chat,
      now,
    })];
  }

  const items = plan?.source === "historical"
    ? plan.replacements
    : plan.appends;
  return items.map((item) => createMessageRecord({
    chatKey,
    messageIndex: item.messageIndex,
    kind: "restore",
    message: chat[item.messageIndex],
    now,
  }));
}

export function formatIndexRange(indexes) {
  const safeIndexes = [...new Set((indexes ?? []).filter(Number.isInteger))].sort((a, b) => a - b);
  if (!safeIndexes.length) {
    return "";
  }
  if (safeIndexes.length === 1) {
    return `第 ${safeIndexes[0]} 层`;
  }
  return `第 ${safeIndexes[0]} 层到第 ${safeIndexes.at(-1)} 层`;
}

function createPlanBase({ source, chat, chatKey, pending, pendingScopeIndexes }) {
  return {
    source,
    chatKey,
    baseChatLength: chat.length,
    baseChatHash: hashCanonicalChat(chat),
    baseNativeHash: nativeChatHash(chat),
    basePendingHash: hashPendingRecords(pending, pendingScopeIndexes),
    pendingScopeIndexes,
    replacements: [],
    appends: [],
    deletions: [],
    pendingConflicts: [],
    firstIndex: null,
    lastIndex: null,
    totalCount: 0,
    blockedReason: "",
  };
}

function finishPlan(base, { replacements, appends, deletions = [] }) {
  const indexes = [...replacements, ...appends, ...deletions].map((item) => item.messageIndex);
  const plan={
    ...base,
    replacements,
    appends,
    deletions,
    firstIndex: indexes.length ? Math.min(...indexes) : null,
    lastIndex: indexes.length ? Math.max(...indexes) : null,
    totalCount: indexes.length,
  };
  plan.targetItemsHash=restoreItemsHash(plan);return plan;
}
function restoreItemsHash(plan){return sha256Text(JSON.stringify([...plan.replacements,...plan.appends].map(item=>[item.messageIndex,nativeMessageHash(item.raw)])));}
export function validateRestorePendingRecords(plan,pending) {
  return hashPendingRecords(pending,plan.pendingScopeIndexes)===plan.basePendingHash;
}

function blockPlan(base, blockedReason) {
  return {
    ...base,
    blockedReason,
  };
}

function toRestoreItem(messageIndex, backup) {
  return {
    messageIndex,
    backup,
    raw: backup.raw,
  };
}

function hasRestorableRaw(backup) {
  return Boolean(backup?.raw && typeof backup.raw === "object");
}

function sortPending(records) {
  return [...(Array.isArray(records) ? records : [])].sort((a, b) => {
    const left=Number.isInteger(a?.messageIndex)?a.messageIndex:Infinity,right=Number.isInteger(b?.messageIndex)?b.messageIndex:Infinity;
    if(left!==right)return left-right;
    return String(a?.id??'')<String(b?.id??'')?-1:String(a?.id??'')>String(b?.id??'')?1:0;
  });
}

function hasDuplicateIndexes(records) {
  const indexes = records.map((record) => record.messageIndex);
  return new Set(indexes).size !== indexes.length;
}

function isContinuous(indexes) {
  return indexes.every((index, offset) => offset === 0 || index === indexes[offset - 1] + 1);
}

function hashPendingRecords(records, scopeIndexes) {
  const scope = Array.isArray(scopeIndexes) ? new Set(scopeIndexes) : null;
  const comparable = sortPending(records)
    .filter((record) => !scope || scope.has(record?.messageIndex))
    .map(record => [record?.id,pendingRecordFingerprint(record)]);
  return hashString(stableStringify(comparable));
}

function createTargetPlan(base,chat,targetChat,coveredIds) {
  const replacements=[],appends=[],deletions=[];
  targetChat.forEach((raw,messageIndex)=>{
    if(messageIndex>=chat.length)appends.push({messageIndex,raw,backup:canonicalizeMessage(raw,messageIndex)});
    else if(!sameNativeChat([chat[messageIndex]],[raw]))replacements.push({messageIndex,raw,backup:canonicalizeMessage(raw,messageIndex)});
  });
  for(let index=targetChat.length;index<chat.length;index++)deletions.push({messageIndex:index});
  return finishPlan({...base,targetChat,targetNativeHash:nativeChatHash(targetChat),coveredPendingIds:coveredIds,canResave:coveredIds.length>0}, {replacements,appends,deletions});
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function cloneValue(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function invalid(reason) {
  return { ok: false, reason };
}
