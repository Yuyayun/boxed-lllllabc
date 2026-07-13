import test from "node:test";
import assert from "node:assert/strict";

import { renderUpdateState } from "../src/ui/extension-info.js";

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
