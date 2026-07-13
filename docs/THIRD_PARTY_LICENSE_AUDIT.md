# 第三方代码与许可证审计

审计日期：2026-07-13

本文件记录当前工作区的静态审计结果，用于发布准备，不构成法律意见。后续若引入依赖、复制宿主代码、加入构建产物或改变分发方式，需要重新审计。

## 项目许可证

- 项目名称：箱装辣白菜（boxed-lllllabc）
- 版权所有者：辣白菜 / labaicai0969
- 年份：2026
- 许可证：Aladdin Free Public License Version 9（AFPL 9）
- 完整正文：仓库根目录 `LICENSE`
- 原文核对来源：[Aladdin Free Public License Version 9](https://web.mit.edu/ghostscript/www/Public.htm)

AFPL 9 允许把许可证用于其他作品，但要求完整复制许可证，只允许按正文说明替换第 0 节第一段，以及在适用时替换第 6 节第一段。本项目仅替换了第 0 节第一段，用来填写项目说明、版权所有者和年份；其余条款未作改写。

SPDX 当前的 `Aladdin` 标识对应 Version 8，而不是本项目采用的 Version 9。因此 `package.json` 不使用可能造成版本误认的 `Aladdin`，而按 npm 的非标准或自定义许可证写法使用 `SEE LICENSE IN LICENSE`。

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

SillyTavern 当前仓库采用 AGPL-3.0，且明确支持第三方扩展。就当前代码形态而言，本项目作为独立仓库和独立扩展分发，未发现把 SillyTavern 代码重新许可为 AFPL 9 的情况。

## 兼容性边界

AFPL 9 对商业性分发施加限制；AGPL-3.0 则禁止对其授予的权利追加进一步限制。因此不能把 AFPL 9 和 SillyTavern 的 AGPL-3.0 笼统标记为“兼容”。如果以后复制 SillyTavern 源码、静态合并代码，或以其他方式形成必须作为单一派生作品分发的程序，需要在发布前重新取得法律意见或改用兼容许可证。

SillyTavern 官方扩展索引当前要求扩展开源并采用 libre 许可证。AFPL 9 的正文明确说明它不是 Open Source 许可证，因此本项目预计不符合官方索引的这一收录条件。用户仍可通过 GitHub 仓库地址手动安装；手动安装与官方索引收录是两件不同的事。

## 当前界面提示的范围

扩展信息弹窗按项目决定保留“本扩展可免费使用，禁止任何形式的商业用途”。AFPL 9 正文同时规定程序的功能性使用不受限制，其明确限制主要针对特定商业性分发场景。因此弹窗文字的日常语言范围比 AFPL 9 正文更宽。

为避免把简要提示误当成另一套许可证，README 已明确：弹窗文字不替代、扩张或修改 `LICENSE`，实际授权范围以完整 AFPL 9 正文为准。若项目希望这句提示本身成为可独立执行的额外法律限制，应在发布前咨询专业人士，因为 AFPL 9 不允许对接收者追加进一步限制。

## 发布与后续修改注意项

- 发布包和 Git 仓库必须保留根目录完整 `LICENSE`。
- 分发时应同时提供完整、可修改的源代码。
- 修改并再分发 AFPL 9 版本时，许可证要求在修改文件中记录修改者、联系方式（如有）、日期和修改目的；正式建立多人贡献流程前应单独设计合规方式。
- AFPL 9 对交互程序的版权、无担保和许可证查看提示有专门要求。当前弹窗按项目决定保持不变；若后续有第三方修改版、商业合作或正式合规审查，应再次核对该显示义务。
- 新增任何 npm 包、复制代码、字体、图标、图片或构建产物时，重新检查其许可证并更新本文件。

## 核对来源

- [AFPL 9 原文镜像](https://web.mit.edu/ghostscript/www/Public.htm)
- [SPDX 的 Aladdin 条目（Version 8）](https://spdx.org/licenses/Aladdin.html)
- [npm package.json 许可证字段说明](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#license)
- [SillyTavern 仓库与 AGPL-3.0 说明](https://github.com/SillyTavern/SillyTavern)
- [SillyTavern 官方扩展索引提交要求](https://github.com/SillyTavern/SillyTavern-Content#extension-submissions)
- [GNU AGPL-3.0 正文](https://www.gnu.org/licenses/agpl-3.0.html)
