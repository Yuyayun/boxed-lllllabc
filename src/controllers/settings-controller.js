import { clampRecentLimit, normalizeStatusDisplayMode } from "../settings.js";

export function createSettingsController({
  extensionFolderPath,
  getSettings,
  saveSettings,
  runBackupNow,
  getPanelController,
  getCatalogController,
  refreshStorageOverview = async () => {},
  jquery = globalThis.jQuery,
}) {
  async function load() {
    const settingsHtml = await jquery.get(`${extensionFolderPath}/settings.html`);
    jquery("#extensions_settings").append(settingsHtml);
  }

  function sync() {
    const settings = getSettings();
    jquery("#boxed-lllllabc-enabled").prop("checked", settings.enabled);
    jquery("#boxed-lllllabc-recent-enabled").prop("checked", settings.recentBackupEnabled);
    jquery("#boxed-lllllabc-full-enabled").prop("checked", settings.fullBackupEnabled);
    jquery("#boxed-lllllabc-historical-enabled").prop("checked", settings.historicalBackupEnabled);
    jquery("#boxed-lllllabc-recent-limit").val(settings.recentLimit);
    jquery("#boxed-lllllabc-status-display-mode").val(settings.statusDisplayMode);
    jquery("#boxed-lllllabc-status-message-centered").prop("checked", settings.statusMessageCentered);
  }

  function bind() {
    bindBackupToggle("#boxed-lllllabc-enabled", "enabled", "settings-enabled-changed");
    bindBackupToggle("#boxed-lllllabc-recent-enabled", "recentBackupEnabled", "settings-recent-enabled-changed");
    bindBackupToggle("#boxed-lllllabc-full-enabled", "fullBackupEnabled", "settings-full-enabled-changed");
    bindBackupToggle(
      "#boxed-lllllabc-historical-enabled",
      "historicalBackupEnabled",
      "settings-historical-enabled-changed",
    );

    jquery("#boxed-lllllabc-recent-limit").on("input", async (event) => {
      const settings = getSettings();
      settings.recentLimit = clampRecentLimit(jquery(event.target).val());
      jquery(event.target).val(settings.recentLimit);
      saveSettings();
      await runBackupNow({ eventName: "settings-limit-changed", args: [] });
    });

    jquery("#boxed-lllllabc-status-display-mode").on("input", async (event) => {
      const settings = getSettings();
      settings.statusDisplayMode = normalizeStatusDisplayMode(jquery(event.target).val());
      jquery(event.target).val(settings.statusDisplayMode);
      getPanelController()?.handleStatusDisplayModeChange(settings.statusDisplayMode);
      saveSettings();
      await getPanelController()?.refreshVisiblePanel();
    });

    jquery("#boxed-lllllabc-status-message-centered").on("input", (event) => {
      getSettings().statusMessageCentered = Boolean(jquery(event.target).prop("checked"));
      getPanelController()?.syncStatusLinePlacement();
      saveSettings();
    });

    jquery("#boxed-lllllabc-refresh").on("click", async (event) => {
      const button = event.currentTarget;
      setActionButtonBusy(button, true, "正在核对");
      try {
        await runBackupNow({ eventName: "manual-refresh", args: [], verifyNow: true });
        await getPanelController()?.refreshVisiblePanel();
        await refreshStorageOverview();
      } finally {
        setActionButtonBusy(button, false, "检查保存状态");
      }
    });

    jquery("#boxed-lllllabc-toggle-panel").on("click", () => getPanelController()?.togglePanel("settings"));
    jquery("#boxed-lllllabc-open-catalog").on("click", () => getCatalogController()?.openCatalog());
  }

  function bindBackupToggle(selector, key, eventName) {
    jquery(selector).on("input", async (event) => {
      getSettings()[key] = Boolean(jquery(event.target).prop("checked"));
      saveSettings();
      await runBackupNow({ eventName, args: [] });
      await refreshStorageOverview();
    });
  }

  return { bind, load, sync };
}

export function setActionButtonBusy(button, isBusy, label) {
  if (!button) return;
  button.disabled = isBusy;
  button.setAttribute("aria-busy", String(isBusy));
  button.classList.toggle("boxed-lllllabc-is-busy", isBusy);
  setButtonLabel(button, label);
}

export function setButtonLabel(button, text) {
  const label = button?.querySelector("[data-boxed-lllllabc-button-label]");
  if (label) label.textContent = text;
  else if (button) button.textContent = text;
}
