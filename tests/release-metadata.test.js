import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const REPOSITORY_URL = "https://github.com/Yuyayun/boxed-lllllabc";

async function readProjectFile(path) {
  return readFile(new URL(path, ROOT), "utf8");
}

test("发布元数据指向真实 GitHub 仓库", async () => {
  const manifest = JSON.parse(await readProjectFile("manifest.json"));
  const packageJson = JSON.parse(await readProjectFile("package.json"));

  assert.equal(manifest.homePage, REPOSITORY_URL);
  assert.equal(manifest.version, "0.1.0-rc.1");
  assert.equal(packageJson.version, manifest.version);
  assert.equal(packageJson.homepage, REPOSITORY_URL);
  assert.equal(packageJson.repository.url, `git+${REPOSITORY_URL}.git`);
});

test("package.json 使用准确指向 AFPL 9 正文的许可证字段", async () => {
  const packageJson = JSON.parse(await readProjectFile("package.json"));

  assert.equal(packageJson.license, "SEE LICENSE IN LICENSE");
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.devDependencies, undefined);
});

test("LICENSE 包含完整 AFPL 9 结构和项目版权信息", async () => {
  const license = await readProjectFile("LICENSE");

  assert.match(license, /Aladdin Free Public License\s+\(Version 9, September 18, 2000\)/);
  assert.match(license, /Copyright \(C\) 2026 辣白菜 \/\s*labaicai0969/);
  assert.match(license, /computer program known as "箱装辣白菜\s+\(boxed-lllllabc\),"/);
  assert.doesNotMatch(license, /This License applies to the computer program known as "AFPL Ghostscript\."/);

  for (const heading of [
    "0. Subject Matter",
    "1.  Licenses.",
    "2.  Restrictions.",
    "3.  Reservation of Rights.",
    "4.  Other Restrictions.",
    "5.  Limitations.",
    "6.  General.",
  ]) {
    assert.ok(license.includes(heading), `缺少许可证章节：${heading}`);
  }

  assert.match(license, /Functional use \(running\) of the Program is not restricted/);
  assert.match(license, /You may not impose any further restrictions on the recipient's/);
  assert.match(license, /FAR Section 12\.212/);
  assert.ok(license.length > 11_000, "许可证正文长度异常，可能不是完整 AFPL 9");
});

test("扩展信息弹窗保留用户确认的原有提示", async () => {
  const source = await readProjectFile("src/ui/extension-info.js");

  assert.ok(source.includes("本扩展可免费使用，禁止任何形式的商业用途。"));
});
