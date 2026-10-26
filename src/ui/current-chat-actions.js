export function renderBackupManagement({ onOpen, disabledReason = "", storageText = "" } = {}) {
  const section = document.createElement("section");
  section.className = "boxed-lllllabc-backup-management";
  const copy = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = "本地备份管理";
  const detail = document.createElement("span");
  detail.textContent = "只管理扩展为当前聊天保存的数据，不影响酒馆聊天文件。";
  copy.append(title, detail);
  if (storageText) {
    const storage = document.createElement("span");
    storage.className = "boxed-lllllabc-current-storage";
    storage.textContent = storageText;
    copy.append(storage);
  }

  const action = document.createElement("button");
  action.type = "button";
  action.className = "menu_button boxed-lllllabc-action-button boxed-lllllabc-current-cleanup";
  const icon = document.createElement("i");
  icon.className = "fa-solid fa-broom";
  icon.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = "管理清理";
  action.append(icon, label);
  action.disabled = typeof onOpen !== "function";
  if (action.disabled) action.title = disabledReason || "当前聊天还没有可管理的本地备份。";
  action.addEventListener("click", async () => {
    if (typeof onOpen !== "function") return;
    action.disabled = true;
    action.setAttribute("aria-busy", "true");
    try {
      await onOpen();
    } finally {
      if (action.isConnected) {
        action.disabled = false;
        action.removeAttribute("aria-busy");
      }
    }
  });
  section.append(copy, action);
  return section;
}

export function renderPrimaryActions({ restore = {}, onVerify, onCreateSnapshot }) {
  const section = document.createElement("section");
  section.className = "boxed-lllllabc-primary-actions";
  const title = document.createElement("div");
  title.className = "boxed-lllllabc-primary-actions-title";
  const heading = document.createElement("strong");
  heading.textContent = "当前聊天操作";
  const hint = document.createElement("span");
  hint.textContent = "操作入口始终保留；不可执行时会说明原因。";
  title.append(heading, hint);

  const actions = document.createElement("div");
  actions.className = "boxed-lllllabc-primary-action-grid";
  actions.append(
    createPrimaryAction({
      icon: "fa-camera", label: "创建聊天快照", description: "手动保存此刻完整聊天，不随普通备份变化",
      onClick: onCreateSnapshot, disabledReason: "需要先打开可识别的聊天。",
    }),
    createPrimaryAction({
      icon: "fa-floppy-disk",
      label: "请求保存",
      description: "让酒馆保存当前聊天并核对后端",
      onClick: restore.onRequestSave,
      disabledReason: restore.disabledReason || "需要先打开可识别的聊天。",
    }),
    createPrimaryAction({
      icon: "fa-clock-rotate-left",
      label: "恢复备份",
      description: "查看四类备份及当前可恢复状态",
      onClick: restore.onOpenRecovery,
      disabledReason: "需要先打开可识别的聊天。",
    }),
    createPrimaryAction({
      icon: "fa-rotate",
      label: "立即核对",
      description: "只读取酒馆后端，不请求保存",
      onClick: onVerify,
      disabledReason: "需要先打开可识别的聊天。",
    }),
  );
  section.append(title, actions);
  return section;
}

function createPrimaryAction({ icon, label, description, onClick, disabledReason }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "menu_button boxed-lllllabc-primary-action";
  const iconElement = document.createElement("i");
  iconElement.className = `fa-solid ${icon}`;
  iconElement.setAttribute("aria-hidden", "true");
  const copy = document.createElement("span");
  const title = document.createElement("strong");
  title.textContent = label;
  const detail = document.createElement("small");
  detail.textContent = typeof onClick === "function" ? description : disabledReason;
  copy.append(title, detail);
  button.append(iconElement, copy);
  button.disabled = typeof onClick !== "function";
  if (button.disabled) button.title = disabledReason;
  button.addEventListener("click", async () => {
    if (typeof onClick !== "function") return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      await onClick();
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
    }
  });
  return button;
}
