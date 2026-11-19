# 第三方代码与许可证审计

审计日期：2026-11-19

本文件记录当前工作区的静态审计结果，用于发布准备，不构成法律意见。后续若引入依赖、复制宿主代码、加入构建产物或改变分发方式，需要重新审计。

## 项目许可证

- 项目名称：箱装辣白菜（boxed-lllllabc）
- 版权所有者：辣白菜 / labaicai0969
- 年份：2026
- 许可证：Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
- SPDX：`CC-BY-NC-SA-4.0`
- 完整正文：仓库根目录 `LICENSE`
- 原文核对来源：[Creative Commons 官方法律文本](https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.txt)

根目录 `LICENSE` 使用官方未修改的完整法律文本，不混入项目说明或自定义限制；作者署名及简短许可说明保留在 README 中。允许在署名、非商业的前提下使用、修改与分享；公开分享改编或衍生作品时，应继续采用 CC BY-NC-SA 4.0。完整授权范围以 `LICENSE` 正文为准，NonCommercial 的含义采用正文定义，不另行扩张。

本次迁移提交及后续版本采用 CC BY-NC-SA 4.0；此前已发布版本仍适用其发布时附带的许可证。

Creative Commons 官方通常不建议将 CC 许可证用于软件；本项目已知悉这一点，并仍选择 CC BY-NC-SA 4.0 作为项目许可证。

## 本地仓库扫描结果

当前仓库未发现以下内容：

- npm 运行时或开发依赖；
- `package-lock.json`、`yarn.lock` 或 `pnpm-lock.yaml`；
- `vendor`、`dist`、压缩后的第三方脚本或 WebAssembly；
- 随项目分发的第三方字体、图片、音频或图标文件；
- 带有其他版权所有者或许可证头的复制代码。

测试文件只导入 `node:test` 和 `node:assert/strict` 等 Node.js 内置模块，不需要随项目分发第三方包或许可证。

## 宿主提供的接口与界面资源

扩展运行时会使用 SillyTavern 提供的扩展接口、事件、保存接口、全局 jQuery，以及宿主页面已经加载的 Font Awesome CSS 类。当前仓库只引用这些宿主能力，没有复制或打包 SillyTavern、jQuery 或 Font Awesome 的源代码和资源，因此本仓库没有需要随附的对应第三方许可证文件。

SillyTavern 当前仓库采用 AGPL-3.0，且明确支持第三方扩展。就当前代码形态而言，本项目作为独立仓库和独立第三方扩展分发，未复制或打包 SillyTavern 源代码；本项目的许可证不改变宿主代码的授权。

## 兼容性边界

本项目使用带 NonCommercial 限制的 CC BY-NC-SA 4.0，不能与 SillyTavern 的 AGPL-3.0 简单标记为“许可证兼容”。如果以后复制 SillyTavern 源码、静态合并代码，或以其他方式形成需要作为单一派生作品分发的程序，应在发布前重新审查授权问题。

CC BY-NC-SA 4.0 含 NonCommercial 限制，因此不属于 OSI / libre 意义下允许商业使用的开放许可。SillyTavern 官方扩展索引当前仍要求 open-source / libre 许可，据此本项目预计仍不满足该项收录条件。用户通过 GitHub 仓库地址手动安装不受这一索引收录结论影响。

## 当前界面提示的范围

扩展信息弹窗保留“本扩展可免费使用，禁止任何形式的商业用途”作为日常语言的简短提示。本次仅调整许可证及相关文档元数据，不修改界面或程序行为。

简短提示不替代、扩张或修改 `LICENSE`；包括 NonCommercial 在内的实际授权范围均以完整 CC BY-NC-SA 4.0 正文为准。

## 发布与后续修改注意项

- 发布包和 Git 仓库必须保留根目录完整 `LICENSE`。
- 依许可证要求保留署名、许可链接等信息，并标示修改；公开分享改编或衍生作品时继续采用 CC BY-NC-SA 4.0。
- 后端 `vendor/frontend` 应保留对应的许可证副本与真实来源记录；源码与许可证来自不同提交时分别记录，避免误报来源。
- 不向标准 CC 正文追加项目自定义限制，也不改变此前已发布版本的授权。
- 新增任何 npm 包、复制代码、字体、图标、图片或构建产物时，重新检查其许可证并更新本文件。

## 核对来源

- [CC BY-NC-SA 4.0 官方法律文本](https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.txt)
- [Creative Commons 关于软件许可的说明](https://creativecommons.org/faq/#can-i-apply-a-creative-commons-license-to-software)
- [SPDX 的 CC-BY-NC-SA-4.0 条目](https://spdx.org/licenses/CC-BY-NC-SA-4.0.html)
- [OSI 开源定义](https://opensource.org/osd)
- [SillyTavern 仓库与 AGPL-3.0 说明](https://github.com/SillyTavern/SillyTavern)
- [SillyTavern 官方扩展索引提交要求](https://github.com/SillyTavern/SillyTavern-Content#extension-submissions)
