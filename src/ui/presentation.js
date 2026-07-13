const BRAND_PREFIX = /^箱装辣白菜：\s*/;

export function formatBackupRange(messages = []) {
  const indexes = messages
    .map((message) => Number(message?.messageIndex))
    .filter(Number.isInteger)
    .sort((a, b) => a - b);

  if (!indexes.length) {
    return "暂无备份";
  }

  const first = indexes[0];
  const last = indexes.at(-1);
  return first === last ? `第 ${first} 层` : `第 ${first} 层－第 ${last} 层`;
}

export function formatCandidateSummary(message = {}) {
  const candidates = Array.isArray(message.swipes) ? message.swipes : [];
  const count = candidates.length;
  const requestedIndex = Number(message.swipeIndex);
  const currentIndex = Number.isInteger(requestedIndex) && requestedIndex >= 0 && requestedIndex < count
    ? requestedIndex
    : 0;

  return `候选回复 ${count} 个 · 当前第 ${count ? currentIndex + 1 : 0} 个`;
}

export function getMessagePreview(message = {}, maxLength = 120) {
  const candidates = Array.isArray(message.swipes) ? message.swipes : [];
  const requestedIndex = Number(message.swipeIndex);
  const currentIndex = Number.isInteger(requestedIndex) && requestedIndex >= 0 && requestedIndex < candidates.length
    ? requestedIndex
    : 0;
  const candidate = candidates[currentIndex];
  const candidateText = candidate && typeof candidate === "object" ? candidate.text : candidate;
  const normalized = String(candidateText ?? message.text ?? "").replace(/\s+/g, " ").trim();
  const safeLimit = Number.isFinite(Number(maxLength)) ? Math.max(1, Number(maxLength)) : 120;

  if (!normalized) {
    return "空消息";
  }

  return normalized.length <= safeLimit
    ? normalized
    : `${normalized.slice(0, safeLimit)}...`;
}

export function buildVisibleChatSummary(meta = {}) {
  const safeMeta = meta && typeof meta === "object" ? meta : {};
  const rows = [{
    label: "聊天名称",
    value: getFriendlyChatName(safeMeta),
  }];

  if (safeMeta.chatType === "group") {
    if (hasFriendlyValue(safeMeta.groupName)) {
      rows.push({ label: "群聊", value: String(safeMeta.groupName).trim() });
    }
    return rows;
  }

  if (hasFriendlyValue(safeMeta.characterName)) {
    rows.push({ label: "角色", value: String(safeMeta.characterName).trim() });
  }

  return rows;
}

export function formatStatusText(text, rangeText = "") {
  const statusText = String(text ?? "").replace(BRAND_PREFIX, "").trim() || "暂无状态";
  const suffix = String(rangeText ?? "").trim();
  return suffix ? `${statusText} · ${suffix}` : statusText;
}

export function getStatusMessageAlignment(centered) {
  return centered ? "center" : "left";
}

function getFriendlyChatName(meta) {
  const value = [meta.chatDisplayName, meta.chatFile, meta.chatId]
    .find(isFriendlyChatName);

  if (!value) {
    return "当前聊天";
  }

  return String(value).trim().replace(/\.jsonl?$/i, "") || "当前聊天";
}

function isFriendlyChatName(value) {
  if (!hasFriendlyValue(value)) {
    return false;
  }

  const normalized = String(value).trim();
  return !/^(character|group|unknown):/i.test(normalized)
    && !/^\d+$/.test(normalized);
}

function hasFriendlyValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}
