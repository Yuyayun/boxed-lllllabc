const MEBIBYTE = 1024 ** 2;

export async function estimateOriginStorage(storageManager = globalThis.navigator?.storage) {
  if (!storageManager || typeof storageManager.estimate !== "function") {
    return { supported: false, usage: null, quota: null, remaining: null, usageRatio: null };
  }

  try {
    const estimate = await storageManager.estimate();
    const usage = finiteBytes(estimate?.usage);
    const quota = finiteBytes(estimate?.quota);
    return {
      supported: usage !== null && quota !== null && quota > 0,
      usage,
      quota,
      remaining: usage !== null && quota !== null ? Math.max(0, quota - usage) : null,
      usageRatio: usage !== null && quota ? usage / quota : null,
    };
  } catch (error) {
    return {
      supported: false,
      usage: null,
      quota: null,
      remaining: null,
      usageRatio: null,
      error: error?.message || "浏览器没有提供存储估算。",
    };
  }
}

export function classifyStoragePressure({ estimate = {}, extensionBytes = 0 } = {}) {
  const extensionSize = Math.max(0, Number(extensionBytes) || 0);
  if (!estimate.supported) return extensionSize >= 512 * MEBIBYTE ? "warning" : "unavailable";
  const remaining = Number(estimate.remaining);
  const ratio = Number(estimate.usageRatio);

  if (remaining <= 128 * MEBIBYTE || ratio >= 0.95) return "critical";
  if (remaining <= 512 * MEBIBYTE || ratio >= 0.85 || extensionSize >= 512 * MEBIBYTE) return "warning";
  return "normal";
}

export function createStorageSnapshot({ catalog = {}, estimate = {}, failure = null } = {}) {
  const extensionBytes = Math.max(0, Number(catalog.storageBytes) || 0);
  return {
    extensionBytes,
    invalidRecordCount: Math.max(0, Number(catalog.invalidRecordCount) || 0),
    estimate,
    pressure: failure ? "error" : classifyStoragePressure({ estimate, extensionBytes }),
    failure,
    checkedAt: new Date().toISOString(),
  };
}

function finiteBytes(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
