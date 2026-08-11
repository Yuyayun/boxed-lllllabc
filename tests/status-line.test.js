import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { getStatusTopLayout } from "../src/ui/status-line.js";

test("聊天容器脱离文档流时启用顶部状态兼容布局", () => {
  assert.equal(getStatusTopLayout("absolute"), "overlay");
  assert.equal(getStatusTopLayout("fixed"), "overlay");
});

test("聊天容器回到文档流时撤销顶部覆盖布局", () => {
  assert.equal(getStatusTopLayout("static"), "flow");
  assert.equal(getStatusTopLayout("relative"), "flow");
  assert.equal(getStatusTopLayout("sticky"), "flow");
  assert.equal(getStatusTopLayout(""), "flow");
});

test("顶部覆盖布局保留绝对定位聊天并使用半透明状态层", async () => {
  const style = await readFile(new URL("../style.css", import.meta.url), "utf8");

  assert.match(style, /status-line\[data-placement="top"\]\[data-top-layout="overlay"\][\s\S]*?position:\s*absolute\s*!important/);
  assert.match(style, /status-line\[data-placement="top"\]\[data-top-layout="overlay"\][\s\S]*?backdrop-filter:\s*blur\(12px\)/);
  assert.match(style, /> #chat\s*\{\s*padding-top:\s*calc\(var\(--topBarBlockSize, 0px\) \+ 43px\)\s*!important/);
  assert.doesNotMatch(style, /> #chat\s*\{[\s\S]{0,240}?position:\s*relative\s*!important/);
});
