import { canonicalizeMessage, hashCanonicalMessage } from './canonicalize.js';
import { classifyTriggers } from './full.js';
import { readBackupRecords, writeBackupRecords, backupFailure } from '../storage/backup-batches.js';
import { stableText } from '../storage/value-digest.js';

const contentEvents = new Set(['message_sent','message_received','message_edited','message_updated','message_swiped','message_swipe_deleted','message_reasoning_edited','message_reasoning_deleted','generation_ended','generation_stopped']);
export async function refreshBoundedFullBackup({ session, current, triggers, reason, backendConfirmed, views, readCurrent, epoch = () => 0 }) {
  const key = current.identity.chatKey, summary = await session.getBackupSummary(key), meta = summary.meta ?? {}, count = summary.counts.full_messages;
  const info = classifyTriggers(triggers, current.chat.length), view = views.get(key);
  if (info.onlyIgnoredFirstMessage) return null;
  const frozen = meta.fullBackupState === 'frozen', awaiting = meta.fullBackupState === 'awaiting-confirmation';
  const unknownTarget = triggers.some(trigger => /edited|updated|swiped|swipe_deleted|reasoning/.test(trigger.eventName) && !(trigger.args ?? []).some(value => (typeof value === 'number' || typeof value === 'string' && value.trim()) && Number.isSafeInteger(Number(value)) && Number(value) >= 0 && Number(value) < current.chat.length));
  const trusted = !frozen && !awaiting && view?.count === count && view?.at === meta.fullBackupAt
    && triggers.length && triggers.every(trigger => contentEvents.has(trigger.eventName)) && !unknownTarget && !info.hasDelete && current.chat.length >= count;
  const observedEpoch = epoch(), length = current.chat.length;
  const unchanged = () => { const latest = readCurrent(); return epoch() === observedEpoch && latest.ok && latest.identity.chatKey === key && latest.chat.length === length; };
  const targets = new Set(info.targetIndexes);
  if (unknownTarget) targets.clear();
  let source, replace = false;
  if (trusted) {
    for (let i = count; i < length; i++) targets.add(i);
    source = [...targets].sort((a, b) => a - b).map(index => ({ index, raw: structuredClone(current.chat[index]) }));
  } else {
    // Only reconciliation/replacement needs a complete stable source view.
    source = structuredClone(current.chat);
    if (count) {
      const old = await readBackupRecords(session, key, 'full_messages', { hashesOnly: true, summary });
      const live = readCurrent();
      if (!unchanged() || !source.every((row, index) => stableText(row) === stableText(live.chat[index]))) throw backupFailure('来源聊天在核对期间发生变化，已有备份已保留。', 'backup-source-changed');
      if (old.some((row, index) => row.messageIndex !== index)) throw backupFailure('完整备份楼层不连续，已有备份已保留。');
      const differing = old.findIndex((row, index) => index >= length || row.canonicalHash !== hashCanonicalMessage(source[index]));
      if (frozen && !(differing === -1 && length >= count) && !(backendConfirmed && meta.fullBackupIncident?.kind === 'unexpected-message-change' && length >= count)) return { code: 'full-frozen', shortText: '完整备份已暂停更新' };
      if (!info.hasDelete && length < count) {
        await session.updateChatMetaSummary(key, { fullBackupState: 'frozen', fullBackupIncident: { kind: 'unexpected-shorter-chat', detectedAt: new Date().toISOString(), backupMessageCount: count, observedMessageCount: length } });
        return { code: 'full-frozen', shortText: '完整备份已暂停更新' };
      }
      const unexpected = old.findIndex((row, index) => index < length && !targets.has(index) && row.canonicalHash !== hashCanonicalMessage(source[index]));
      if (!info.hasDelete && !backendConfirmed && !frozen && unexpected !== -1) {
        await session.updateChatMetaSummary(key, { fullBackupState: 'awaiting-confirmation', fullBackupPendingMessageCount: length, fullBackupIncident: { kind: 'unexpected-message-change', differingIndex: unexpected, previousCount: count, observedCount: length, detectedAt: new Date().toISOString() } });
        return { code: 'full-awaiting-confirmation', shortText: '完整备份待酒馆确认' };
      }
      replace = info.hasDelete || frozen || awaiting && backendConfirmed || backendConfirmed && unexpected !== -1;
      if (!replace) {
        for (let i = count; i < length; i++) targets.add(i);
        source = [...targets].sort((a, b) => a - b).map(index => ({ index, raw: source[index] }));
      }
    } else replace = true;
  }
  if (!unchanged()) throw backupFailure('来源聊天已经变化，已有备份已保留。', 'backup-source-changed');
  if (!source.length && !replace) { views.set(key, { count, at: meta.fullBackupAt }); return null; }
  const now = new Date().toISOString();
  const patch = { fullBackupAt: now, fullBackupMessageCount: length, fullBackupFirstIndex: length ? 0 : null, fullBackupLastIndex: length ? length - 1 : null, fullBackupLastReason: reason, fullBackupState: 'active', fullBackupIncident: null, fullBackupPendingMessageCount: null };
  await writeBackupRecords(session, {
    chatKey: key, store: 'full_messages', rows: source, mapRow: replace ? (raw, index) => canonicalizeMessage(raw, index, now) : item => canonicalizeMessage(item.raw, item.index, now), replace, meta: patch, summary,
    sourceUnchanged: unchanged,
    validateSource: () => {
      if (!unchanged()) return false;
      const live = readCurrent().chat;
      return source.every((item, index) => stableText(replace ? item : item.raw) === stableText(live[replace ? index : item.index]));
    },
  });
  views.set(key, { count: length, at: now }); return null;
}
