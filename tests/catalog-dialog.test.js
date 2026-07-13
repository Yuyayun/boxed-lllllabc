import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const projectRoot = new URL("../", import.meta.url);

test("手机端全部聊天备份弹层保留安全区和底部关闭入口", async () => {
  const [source, style] = await Promise.all([
    readFile(new URL("src/ui/backup-catalog-dialog.js", projectRoot), "utf8"),
    readFile(new URL("style.css", projectRoot), "utf8"),
  ]);

  assert.match(source, /boxed-lllllabc-catalog-mobile-footer/);
  assert.match(source, /boxed-lllllabc-catalog-mobile-close/);
  assert.match(source, /focus\(\{ preventScroll: true \}\)/);
  assert.match(style, /--boxed-lllllabc-catalog-mobile-top-clearance/);
  assert.match(style, /env\(safe-area-inset-top, 0px\)/);
  assert.match(style, /place-items: end center/);
  assert.match(style, /\.boxed-lllllabc-catalog-dialog\s*\{[\s\S]*?inset: 0;/);
  assert.match(style, /\.boxed-lllllabc-catalog-dialog\s*\{[\s\S]*?height: 100vh;[\s\S]*?height: 100dvh;/);
  assert.match(style, /\.boxed-lllllabc-catalog-dialog\s*\{[\s\S]*?min-height: 100vh;[\s\S]*?min-height: 100dvh;/);
  assert.match(style, /\.boxed-lllllabc-catalog-frame\s*\{[\s\S]*?max-height: 100%;/);
  assert.doesNotMatch(style, /\.boxed-lllllabc-catalog-dialog\s*\{[\s\S]*?inset: auto 0 0;/);
  assert.match(style, /\.boxed-lllllabc-catalog-mobile-footer\s*\{[\s\S]*?display: flex/);
  assert.match(style, /\.boxed-lllllabc-catalog-mobile-close\s*\{[\s\S]*?min-height: 44px/);
});
