import test from "node:test";
import assert from "node:assert/strict";

import {
  parseVersionChangelog,
  renderUpdateState,
  resolveSiblingAssetUrl,
} from "../src/ui/extension-info.js";

test("更新日志地址与 manifest 使用同一扩展目录", () => {
  assert.equal(
    resolveSiblingAssetUrl("scripts/extensions/third-party/boxed-lllllabc/manifest.json", "CHANGELOG.md"),
    "scripts/extensions/third-party/boxed-lllllabc/CHANGELOG.md",
  );
});

test("只提取当前安装版本的更新日志", () => {
  const release = parseVersionChangelog(`
# 更新日志

## 未发布

暂无。

## 0.1.3 — 2026-07-25

本版本增加安全处理入口。

### 功能

- 第一项变化。
- 第二项变化。

### 验证

- 自动测试通过。

## 0.1.2 — 2026-07-21

旧版本内容。
`, "0.1.3");

  assert.deepEqual(release, {
    version: "0.1.3",
    date: "2026-07-25",
    blocks: [
      { type: "paragraph", text: "本版本增加安全处理入口。" },
      { type: "heading", text: "功能" },
      { type: "list", items: ["第一项变化。", "第二项变化。"] },
      { type: "heading", text: "验证" },
      { type: "list", items: ["自动测试通过。"] },
    ],
  });
});

test("更新日志缺少当前版本时返回空结果", () => {
  assert.equal(parseVersionChangelog("## 0.1.2\n\n旧版本内容。", "0.1.3"), null);
});

function createUpdateElements() {
  const label = { textContent: "" };
  const classNames = new Set();
  const hint = { hidden: true };
  const button = {
    hidden: true,
    disabled: false,
    attributes: new Map(),
    classList: {
      toggle(name, enabled) {
        if (enabled) classNames.add(name);
        else classNames.delete(name);
      },
    },
    querySelector(selector) {
      return selector === "span" ? label : null;
    },
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
  };

  return { button, classNames, hint, label };
}

test("可更新状态同时显示标题提示和原更新按钮", (t) => {
  const previousDocument = globalThis.document;
  const elements = createUpdateElements();
  globalThis.document = {
    querySelector(selector) {
      if (selector === "#boxed-lllllabc-update-hint") return elements.hint;
      if (selector === "#boxed-lllllabc-update-available") return elements.button;
      return null;
    },
  };
  t.after(() => { globalThis.document = previousDocument; });

  renderUpdateState("available");

  assert.equal(elements.hint.hidden, false);
  assert.equal(elements.button.hidden, false);
  assert.equal(elements.button.disabled, false);
  assert.equal(elements.label.textContent, "发现新版本");
});

test("更新开始后隐藏标题提示并保持按钮进度状态", (t) => {
  const previousDocument = globalThis.document;
  const elements = createUpdateElements();
  globalThis.document = {
    querySelector(selector) {
      if (selector === "#boxed-lllllabc-update-hint") return elements.hint;
      if (selector === "#boxed-lllllabc-update-available") return elements.button;
      return null;
    },
  };
  t.after(() => { globalThis.document = previousDocument; });

  renderUpdateState("available");
  renderUpdateState("updating");

  assert.equal(elements.hint.hidden, true);
  assert.equal(elements.button.hidden, false);
  assert.equal(elements.button.disabled, true);
  assert.equal(elements.button.attributes.get("aria-busy"), "true");
  assert.equal(elements.classNames.has("boxed-lllllabc-is-busy"), true);
  assert.equal(elements.label.textContent, "正在更新");

  renderUpdateState("updated");
  assert.equal(elements.hint.hidden, true);
  assert.equal(elements.label.textContent, "更新完成，即将刷新");
});
