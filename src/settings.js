export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  recentBackupEnabled: true,
  fullBackupEnabled: false,
  historicalBackupEnabled: true,
  recentLimit: 20,
  backendVerifyDelayMs: 2000,
  statusDisplayMode: "message",
  statusMessageCentered: false,
});

export function createSettingsAccessor({ extensionSettings, extensionName, defaults = DEFAULT_SETTINGS }) {
  return function getSettings() {
    extensionSettings[extensionName] = extensionSettings[extensionName] || {};
    const settings = extensionSettings[extensionName];

    for (const [key, value] of Object.entries(defaults)) {
      if (settings[key] === undefined) settings[key] = value;
    }

    settings.recentLimit = clampRecentLimit(settings.recentLimit, defaults.recentLimit);
    settings.enabled = Boolean(settings.enabled);
    settings.recentBackupEnabled = settings.recentBackupEnabled === undefined
      ? true
      : Boolean(settings.recentBackupEnabled);
    settings.fullBackupEnabled = Boolean(settings.fullBackupEnabled);
    settings.historicalBackupEnabled = settings.historicalBackupEnabled === undefined
      ? true
      : Boolean(settings.historicalBackupEnabled);
    settings.backendVerifyDelayMs = clampVerifyDelay(
      settings.backendVerifyDelayMs,
      defaults.backendVerifyDelayMs,
    );
    settings.statusDisplayMode = normalizeStatusDisplayMode(settings.statusDisplayMode);
    settings.statusMessageCentered = Boolean(settings.statusMessageCentered);
    return settings;
  };
}

export function clampRecentLimit(value, fallback = DEFAULT_SETTINGS.recentLimit) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(200, number));
}

export function clampVerifyDelay(value, fallback = DEFAULT_SETTINGS.backendVerifyDelayMs) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(500, number);
}

export function normalizeStatusDisplayMode(value) {
  return value === "top" ? "top" : "message";
}
