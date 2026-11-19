import { hashCanonicalMessage, hashCanonicalChat } from './canonicalize.js';
import { isHistoricalIndex } from './historical.js';

// The existing durable pending record is also the repair journal. Requirements
// travel with the captured content, rather than living only in a page's cache.
export function protectPendingRecord(record, settings, chatLength) {
  const backupTargets = [];
  if (settings.recentBackupEnabled && Number.isInteger(record.messageIndex)
      && !isHistoricalIndex(record.messageIndex, chatLength, settings.recentLimit)) backupTargets.push('recent_messages');
  if (settings.fullBackupEnabled) backupTargets.push('full_messages');
  if (settings.historicalBackupEnabled && ['message_edit', 'swipe_change', 'restore'].includes(record.kind)
      && isHistoricalIndex(record.messageIndex, chatLength, settings.recentLimit)) backupTargets.push('historical_changes');
  return { ...record, backupTargets };
}

export function pendingRepairTriggers(records, current, settings, { historicalOnly = false } = {}) {
  const triggers = [];
  for (const record of records) {
    if (record.chatKey !== current.identity.chatKey) continue;
    if (historicalOnly && !(record.backupTargets?.includes('historical_changes') || !Array.isArray(record.backupTargets) && ['message_edit', 'swipe_change', 'restore'].includes(record.kind))) continue;
    if (Number.isInteger(record.messageIndex)) {
      const message = current.chat[record.messageIndex];
      if (!message || hashCanonicalMessage(message) !== record.canonicalHash) continue;
      if (record.backupTargets?.length || settings.fullBackupEnabled
          || settings.historicalBackupEnabled && ['message_edit', 'swipe_change', 'restore'].includes(record.kind)) {
        triggers.push({ eventName: 'message_edited', args: [record.messageIndex] });
      }
    } else if (record.kind === 'message_delete' && (hashCanonicalChat(current.chat) === record.canonicalChatHash
        || Number.isInteger(record.chatLength) && current.chat.length >= record.chatLength && hashCanonicalChat(current.chat.slice(0, record.chatLength)) === record.canonicalChatHash)) {
      triggers.push({ eventName: 'message_deleted', args: [] });
    }
  }
  return triggers;
}
