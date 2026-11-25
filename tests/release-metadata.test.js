import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseVersionChangelog } from '../src/ui/extension-info.js';

const ROOT = new URL("../", import.meta.url);
const REPOSITORY_URL = "https://github.com/Yuyayun/boxed-lllllabc";

async function readProjectFile(path) {
  return readFile(new URL(path, ROOT), "utf8");
}

test("发布元数据指向真实 GitHub 仓库", async () => {
  const manifest = JSON.parse(await readProjectFile("manifest.json"));
  const packageJson = JSON.parse(await readProjectFile("package.json"));
  const changelog = await readProjectFile("CHANGELOG.md");

  assert.equal(manifest.homePage, REPOSITORY_URL);
  assert.equal(manifest.version, "1.0.5-fix.1");
  assert.equal(packageJson.version, manifest.version);
  assert.equal(packageJson.homepage, REPOSITORY_URL);
  assert.equal(packageJson.repository.url, `git+${REPOSITORY_URL}.git`);
  assert.ok((await readProjectFile("settings.html")).includes(`id="boxed-lllllabc-version">Ver ${manifest.version}</`));
  assert.match(changelog, new RegExp(`^##\\s+${manifest.version.replaceAll(".", "\\.")}(?:\\s|$)`, "m"));
  const announcement = parseVersionChangelog(changelog, manifest.version);
  assert.equal(announcement?.date, '2026-11-25（开发补修）');
  const announcementText = announcement.blocks.flatMap(block => block.items ?? [block.text]).join('\n');
  assert.match(announcementText, /连续聊天内容恢复/);
  assert.match(announcementText, /后端 1\.0\.5 可继续配合使用/);
  const readme = await readProjectFile('README.md');
  assert.ok(readme.includes(`开发补修：${manifest.version}`));
  assert.ok(readme.includes('最新正式版：1.0.5'));
  assert.ok(readme.includes(`${REPOSITORY_URL}/releases/tag/v1.0.5`));
});

test("发布元数据注册安装与更新后的自动刷新钩子", async () => {
  const manifest = JSON.parse(await readProjectFile("manifest.json"));
  const source = await readProjectFile("index.js");

  assert.deepEqual(manifest.hooks, {
    install: "onExtensionInstall",
    update: "onExtensionUpdate",
  });
  assert.match(source, /export function onExtensionInstall\(\)/);
  assert.match(source, /export function onExtensionUpdate\(\)/);
});

test("package.json 使用 CC BY-NC-SA 4.0 的 SPDX 许可证标识", async () => {
  const packageJson = JSON.parse(await readProjectFile("package.json"));

  assert.equal(packageJson.license, "CC-BY-NC-SA-4.0");
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.devDependencies, undefined);
  assert.ok(packageJson.files.includes("src/"));
  assert.ok(packageJson.files.includes("manifest.json"));
  assert.equal(packageJson.files.some((path) => /PROJECT_HANDOFF|superpowers|testing/i.test(path)), false);
});

test("LICENSE 使用未修改的 CC BY-NC-SA 4.0 官方正文，作者信息保留在 README", async () => {
  const license = await readProjectFile("LICENSE");
  const readme = await readProjectFile("README.md");

  // https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.txt
  assert.equal(
    createHash("sha256").update(license).digest("hex"),
    "e66c269d4819aaab34b49ef5220c4ddab6756f21bb5180761a4eb8561f2b7bbd",
    "LICENSE 必须与官方未修改的法律文本一致",
  );
  assert.match(readme, /作者：\*\*辣白菜 \/ labaicai0969\*\*/);
});

test("扩展信息弹窗保留用户确认的原有提示", async () => {
  const source = await readProjectFile("src/ui/extension-info.js");

  assert.ok(source.includes("本扩展可免费使用，禁止任何形式的商业用途。"));
});

test("扩展信息弹窗使用纯图标仓库入口并提供更新日志开关", async () => {
  const source = await readProjectFile("src/ui/extension-info.js");

  assert.doesNotMatch(source, /boxed-lllllabc-info-mark/);
  assert.doesNotMatch(source, /repositoryState/);
  assert.match(source, /fa-brands fa-github/);
  assert.match(source, /fa-file-lines/);
  assert.match(source, /aria-expanded/);
  assert.match(source, /CHANGELOG\.md/);
});

test("设置面板使用轻量版本信息布局并保留独立更新入口", async () => {
  const html = await readProjectFile("settings.html");
  const infoButton = html.match(/<button\s+id="boxed-lllllabc-info-toggle"[\s\S]*?>/)?.[0] ?? "";

  assert.ok(html.includes('id="boxed-lllllabc-update-hint"'));
  assert.ok(html.includes("有新版本可更新！"));
  assert.ok(html.includes('class="boxed-lllllabc-meta-separator"'));
  assert.match(infoButton, /class="boxed-lllllabc-meta-link"/);
  assert.doesNotMatch(infoButton, /menu_button/);
  assert.ok(html.includes('id="boxed-lllllabc-update-available"'));
});
