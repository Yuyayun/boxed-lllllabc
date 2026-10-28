import test from "node:test";
import assert from "node:assert/strict";
import { createStorageController } from "../src/controllers/storage-controller.js";
import { createSettingsStoragePresentation, createCurrentChatStorageText } from "../src/ui/storage-status.js";
import { trackCatalogViewport } from "../src/ui/catalog-viewport.js";
import { createSettingsController } from "../src/controllers/settings-controller.js";
import { createStorageSwitchUi, storageChangeDescription } from "../src/ui/storage-switch.js";

test("双向切换文案代入实际位置，明确覆盖、不合并与原备份保留", () => {
  for (const [from, to, source, target] of [["indexeddb", "sqlite", "浏览器本地存储", "服务器存储"],
    ["sqlite", "indexeddb", "服务器存储", "浏览器本地存储"]]) {
    const text = storageChangeDescription("switch", from, to);
    assert.ok(text.startsWith(`将备份从“${source}”切换到“${target}”。`));
    assert.match(text, /新位置已有的备份会被覆盖，不会合并/);
    assert.match(text, /切换成功后，原位置的备份仍会保留/);
  }
});

test("原位置清空文案包含普通备份、未保存变更和快照，并保留当前位置与酒馆聊天文件", () => {
  const text = storageChangeDescription("clear", "sqlite", "indexeddb");
  assert.match(text, /原存储位置“浏览器本地存储”中的普通备份、未保存变更和聊天快照/);
  assert.match(text, /当前使用位置“服务器存储”的备份、备份设置及酒馆聊天文件不受影响/);
});

test("IndexedDB 说明来源配额且不把未知配额当零", () => {
  const view = createSettingsStoragePresentation({ checkedAt: "now", extensionBytes: 42, pressure: "unavailable", estimate: { supported: false } });
  assert.match(view.stateText, /浏览器本地存储可读取/); assert.match(view.siteLabel, /酒馆站点的浏览器/);
  assert.equal(view.siteText, "浏览器未提供"); assert.equal(view.remainingText, "浏览器未提供");
  assert.match(view.help, /不能视为备份独占/); assert.equal(view.extensionText, "42 B");
});
test("SQLite 统计只使用服务器指标，即使传入浏览器配额也不能套用", () => {
  const snapshot = { mode: "sqlite", extensionBytes: 123, databaseBytes: 4096, availableBytes: 8192, readable: true, writable: true,
    estimate: { supported: true, usage: 999, remaining: 666 } };
  const view = createSettingsStoragePresentation(snapshot);
  assert.equal(view.siteText, "4.00 KB"); assert.equal(view.remainingText, "8.00 KB"); assert.match(view.help, /不是 SQLite 配额/);
  assert.match(view.stateText, /可读取、可写入/); assert.match(createCurrentChatStorageText(snapshot, 1), /服务器磁盘可用 8.00 KB/);
  const missing = createSettingsStoragePresentation({ ...snapshot, databaseBytes: undefined, availableBytes: null });
  assert.equal(missing.siteText, "服务器未提供"); assert.equal(missing.remainingText, "服务器未提供");
  assert.match(createSettingsStoragePresentation({ mode: "sqlite", readable: true, writable: false }).stateText, /暂时无法写入/);
});
test("失败时不能显示空库、零占用或健康状态", () => {
  const view = createSettingsStoragePresentation({ mode: "sqlite", extensionBytes: 0, databaseBytes: 0, failure: { shortText: "服务器存储不可用", detail: "连接断开" } });
  assert.equal(view.extensionText, "当前不可读取"); assert.equal(view.siteText, "当前不可读取");
  assert.equal(view.remainingText, "当前不可读取"); assert.equal(view.stateText, "服务器存储不可用"); assert.equal(view.issue, "连接断开");
});
test("SQLite 控制器读取服务器健康/空间，不调用浏览器配额或另一端", async () => {
  const controller = createStorageController({ storage: { getMode: () => "sqlite", status: async () => ({ ok: true, database: { counts: [{ bytes: 100 }, { bytes: 20 }], bytes: 4096, availableBytes: 8192, readable: true, writable: true } }),
    open: () => { throw new Error("不能打开另一个端"); } }, estimateStorage: () => { throw new Error("不能估算浏览器"); } });
  const state = await controller.refresh(); assert.equal(state.extensionBytes, 120); assert.equal(state.availableBytes, 8192); assert.equal(state.writable, true);
  assert.match(createSettingsStoragePresentation(state).stateText, /可写入/);
});
test("SQLite 断线或缺少统计时明确不可用，不展示浏览器数字", async () => {
  for (const status of [{ ok: false, reason: "插件协议不兼容" }, { ok: true, database: {} }]) {
    const controller = createStorageController({ storage: { getMode: () => "sqlite", status: async () => status }, estimateStorage: () => { throw new Error("不能读浏览器配额"); } });
    const state = await controller.refresh(), view = createSettingsStoragePresentation(state);
    assert.notEqual(view.siteText, "0 B"); assert.notEqual(view.remainingText, "0 B");
    if (!status.ok) { assert.equal(state.failure.shortText, "服务器存储不可用"); assert.match(view.issue, /协议不兼容/); }
    else { assert.equal(view.siteText, "服务器未提供"); assert.match(view.stateText, /未确认/); }
  }
});
test("切端后的读取期间先清除旧统计，不把另一端的数字留在新模式下", async () => {
  let complete; const states = [];
  const controller = createStorageController({ storage: { getMode: () => "sqlite", status: () => new Promise(resolve => { complete = resolve; }) }, renderOverview: state => states.push(state) });
  const pending = controller.refresh(); await Promise.resolve();
  const view = createSettingsStoragePresentation(states[0]); assert.equal(view.stateText, "正在读取服务器存储"); assert.equal(view.siteText, "正在读取");
  complete({ ok: true, database: { bytes: 4096 } }); await pending; assert.equal(createSettingsStoragePresentation(states.at(-1)).siteText, "4.00 KB");
});
test("可视视口尺寸、键盘式缩小和滚动偏移实时跟随，关闭后解除监听", () => {
  const view = new EventTarget(); view.innerWidth = 1000; view.innerHeight = 900;
  view.visualViewport = Object.assign(new EventTarget(), { width: 390, height: 760, offsetTop: 0, offsetLeft: 0 });
  const properties = new Map(), dialog = { style: { setProperty: (key, value) => properties.set(key, value) } };
  const release = trackCatalogViewport(dialog, view), read = key => properties.get(`--boxed-lllllabc-catalog-viewport-${key}`);
  assert.equal(read("height"), "760px");
  view.visualViewport.height = 360; view.visualViewport.offsetTop = 130; view.visualViewport.dispatchEvent(new Event("resize"));
  assert.equal(read("height"), "360px"); assert.equal(read("top"), "130px");
  view.visualViewport.offsetLeft = 25; view.visualViewport.dispatchEvent(new Event("scroll")); assert.equal(read("left"), "25px");
  release(); view.visualViewport.height = 760; view.visualViewport.dispatchEvent(new Event("resize")); view.dispatchEvent(new Event("resize")); assert.equal(read("height"), "360px");
});
test("没有 VisualViewport 时使用窗口尺寸并能随 resize 更新", () => {
  const view = Object.assign(new EventTarget(), { innerWidth: 800, innerHeight: 600 }); const properties = new Map();
  const release = trackCatalogViewport({ style: { setProperty: (key, value) => properties.set(key, value) } }, view);
  view.innerHeight = 400; view.dispatchEvent(new Event("resize")); assert.equal(properties.get("--boxed-lllllabc-catalog-viewport-height"), "400px"); release();
});
test("检查保存状态仍调用原生保存核对而非 SQLite 连接检查", async () => {
  const handlers = new Map(), calls = [];
  const jquery = selector => ({ on: (event, handler) => handlers.set(`${selector}/${event}`, handler) });
  const controller = createSettingsController({ jquery, getSettings: () => ({}), saveSettings: () => {}, runBackupNow: async value => calls.push(value),
    getPanelController: () => ({ refreshVisiblePanel: async () => calls.push("panel") }), getCatalogController: () => {}, refreshStorageOverview: async () => calls.push("storage") });
  controller.bind();
  const button = { classList: { toggle() {} }, setAttribute() {}, querySelector: () => ({ textContent: "" }) };
  await handlers.get("#boxed-lllllabc-refresh/click")({ currentTarget: button });
  assert.deepEqual(calls, [{ eventName: "manual-refresh", args: [], verifyNow: true }, "panel", "storage"]); assert.equal(button.disabled, false);
});
test("设置只按可写状态解锁切换和旧端入口，检查连接不改变控制库", async () => {
  const previousDocument = globalThis.document, nodes = new Map();
  globalThis.document = { querySelector: key => { if (!nodes.has(key)) nodes.set(key, {}); return nodes.get(key); } };
  try {
    const state = { active: "indexeddb", previous: "sqlite", lastTransfer: { id: "done" } };
    for (const writable of [false, undefined, true]) {
      const ui = createStorageSwitchUi({ control: { read: async () => structuredClone(state) }, sqlite: { status: async () => ({ ok: true, database: { writable, batchTransfer: 3 } }) }, coordinator: {} });
      await ui.refresh(); assert.equal(nodes.get("#boxed-lllllabc-switch-storage").disabled, writable !== true); assert.equal(nodes.get("#boxed-lllllabc-clear-inactive").disabled, writable !== true);
      assert.equal(nodes.get("#boxed-lllllabc-storage-mode").textContent, "浏览器本地存储");
      assert.equal(nodes.get("#boxed-lllllabc-sqlite-state").textContent, writable ? "服务器备份插件已连接"
        : writable === false ? "服务器备份插件已连接，暂时无法写入" : "服务器备份插件已连接，写入状态未确认");
      assert.match(nodes.get("#boxed-lllllabc-clear-help").textContent, writable ? /原存储位置“服务器存储”/ : writable === false ? /暂时无法写入/ : /写入状态未确认/);
      assert.equal(state.active, "indexeddb");
    }
  } finally { globalThis.document = previousDocument; }
});

test('服务器可写但缺少新版迁移能力时不开放切换，不改变当前 IndexedDB',async()=>{
  const previous=globalThis.document,nodes=new Map();globalThis.document={querySelector:key=>{if(!nodes.has(key))nodes.set(key,{});return nodes.get(key);}};
  try{
    const state={active:'indexeddb',previous:'sqlite',lastTransfer:'done-123'};
    const ui=createStorageSwitchUi({control:{read:async()=>state},sqlite:{status:async()=>({ok:true,database:{writable:true,batchTransfer:2}})},coordinator:{}});
    await ui.refresh();assert.equal(nodes.get('#boxed-lllllabc-switch-storage').disabled,true);assert.equal(nodes.get('#boxed-lllllabc-clear-inactive').disabled,true);assert.match(nodes.get('#boxed-lllllabc-sqlite-detail').textContent,/更新配套插件/);assert.equal(state.active,'indexeddb');
  }finally{globalThis.document=previous;}
});
