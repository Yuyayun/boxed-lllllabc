const messages = {
  '正在检查保存状态': scope => scope.type === 'delete' ? `正在核对${scope.label}结果` : `正在核对${scope.label}是否已保存`,
  '酒馆保存待确认': scope => scope.type === 'delete' ? `${scope.label}待确认` : `${scope.label}保存待确认`,
  '无法确认保存状态': scope => scope.type === 'delete' ? `暂时无法核对${scope.label}结果` : `暂时无法核对${scope.label}是否已保存`,
  '酒馆已保存，备份待补全': scope => `酒馆已保存，${scope.type === 'delete' ? '删除后的' : scope.label}备份待补全`,
};

// Display only: never change a pending record, its confirmation, or its removal.
export function formatPendingStatusText(text, pending = []) {
  if (!Object.hasOwn(messages, text)) return null;
  let records = pending.filter(row => row && row.pendingType !== 'message_part');
  if (!records.length) return null;
  // A restore already represents the records it explicitly supersedes. Do not
  // show the replaced records' old floor coordinates as the restored chat.
  const covered = new Set(records.filter(row => row.pendingFormat === 1 && row.pendingType === 'operation' && row.kind === 'restore')
    .flatMap(row => Array.isArray(row.supersedes) ? row.supersedes.map(ref => ref?.id).filter(id => typeof id === 'string') : []));
  records = records.filter(row => !covered.has(row.id));
  const scopes = records.map(recordScope);
  let scope = { type: 'changes', label: '多处改动' };
  if (scopes.length && scopes.every(item => item.type === 'floors')) scope = floorScope(scopes);
  else if (scopes.length === 1) scope = scopes[0];
  else if (scopes.length && scopes.every(item => item.type === 'restore')) scope = { type: 'restore', label: '恢复内容' };
  else if (scopes.length && scopes.every(item => item.type === 'delete')) scope = { type: 'delete', label: '多次删除' };
  else if (scopes.length && scopes.every(item => item.type === 'legacy')) scope = { type: 'legacy', label: '旧改动' };
  return messages[text](scope);
}

const index = value => Number.isSafeInteger(value) && value >= 0;
function recordScope(row) {
  if (!row.pendingFormat) return index(row.messageIndex)
    ? { type: 'floors', first: row.messageIndex, last: row.messageIndex }
    : { type: 'legacy', label: '旧改动' };
  if (row.pendingFormat === 1 && row.pendingType === 'operation') {
    if (row.kind === 'restore') return { type: 'restore', label: '恢复内容' };
    const start = row.deleteStartIndex, removed = row.deleteCount, added = Array.isArray(row.insertIds) ? row.insertIds.length : undefined;
    if (index(start) && index(removed) && index(added) && index(row.beforeLength) && index(row.afterLength)
      && start + removed <= row.beforeLength && row.beforeLength - removed + added === row.afterLength) {
      if (row.kind === 'message_delete' && removed > 0 && added === 0)
        return { type: 'delete', label: '原' + floorLabel([{ first: start, last: start + removed - 1 }]) + '的删除' };
      if (added > 0 && (['message_edit', 'swipe_change'].includes(row.kind) && removed === added
        || row.kind === 'new_message' && removed === 0 && start === row.beforeLength))
        return { type: 'floors', first: start, last: start + added - 1 };
    }
  }
  return { type: 'changes', label: '聊天改动' };
}

function floorScope(scopes) {
  const ranges = [];
  for (const item of scopes.slice().sort((a, b) => a.first - b.first)) {
    const previous = ranges.at(-1);
    if (previous && item.first <= previous.last + 1) previous.last = Math.max(previous.last, item.last);
    else ranges.push({ first: item.first, last: item.last });
  }
  // Keep the light compact without implying untouched floors were changed.
  return ranges.length <= 3 ? { type: 'floors', label: floorLabel(ranges) } : { type: 'changes', label: '多处改动' };
}

function floorLabel(ranges) {
  return `第 ${ranges.map(({first, last}) => first === last ? first : `${first}–${last}`).join('、')} 层`;
}
