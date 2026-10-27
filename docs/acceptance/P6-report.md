# P6：设置 UI 与全部聊天备份弹窗

> 公开归档说明（2026-10-27）：本报告保留阶段完成时的实现、测试和未验收项，现按用户授权纳入 `codex/1.0.0` 开发分支。正文中的“不提交报告”“未推送”等为当时状态，不代表本次交付状态；提交报告不将未执行项改记为通过，也不代表正式 1.0.0 发布。需求文档仍仅保留本机。
>
> 原始日志、截图、测试脚本、数据库与浏览器资料保留在本机 `.local-test/`，未随报告发布。命令默认从前端仓库根目录执行，后端为同级独立仓库；机器绝对路径以 `<frontend-repo>`、`<server-repo>`、`<daily-sillytavern>` 代替，日常配置校验值省略。报告是验收记录，不新增产品需求。

日期：2026-10-27（Asia/Shanghai）。唯一已确认需求基准：本机 `docs/boxed-lllllabc-development-spec.md` 第 7 节、P6、T18–T19。需求文档、本报告和测试环境均不提交。

## 本阶段实现

- 展开菜单按六组纵向排列：存储方式与状态 → 备份开关 → 参数与显示 → 聊天快照 → 备份管理 → 旧端数据管理。使用组标题和间距，不建立并排操作卡片。
- 原折叠标题、状态/展开图标，以及展开内部的版本、扩展信息、更新入口保留。四个“启用……”仍为原生勾选框；原居中参数控件与设置语义保留；快照无启用开关，主要创建入口仍在当前聊天备份中。
- 原“立即核对后端”仍调用酒馆原生保存核对，参数 `verifyNow:true` 不变。可选存储插件的按钮明确称“检查 SQLite 连接”，检查后刷新状态但不切端、不迁移。补接原设置控制器的统计刷新回调。
- IndexedDB 展示内容估算、整个酒馆来源用量和可用配额估算；SQLite 展示记录内容、含日志的数据库文件大小、服务器文件系统可用空间。服务器磁盘空间不称作 SQLite 配额，也不套用浏览器数字。
- 未提供、读取中及不可读取指标有独立说明，不显示成 0 B 或正常空库。切端读取新统计前先清除旧端数字。SQLite 断线、只读或写入权限未确认均明确展示；没有回退到 IndexedDB。
- 旧端管理独立成组，成功切换后才开放；没有旧端、有未完成操作、插件不可用或不可写时禁用并显示原因。清理结果显示在对应分组中；底层切换、清空及确认规则未改。
- 全局目录移除手机端靠底布局。使用对称安全区留白，在加载、长列表、空数据、失败状态均相对当前可视视口居中。正文独立滚动，标题及手机关闭按钮保持可达。
- 只对目录监听 VisualViewport 的 resize/scroll 与窗口 resize，处理尺寸、缩放和视口偏移；关闭时解除监听。缺少 VisualViewport 时按窗口尺寸处理。
- 保留原汇总、搜索、角色/群聊折叠、四类概况、单聊天与 P5 批量清理入口。重绘移除当前焦点条目时回收至关闭按钮，Tab 在目录内循环，键盘事件不触发宿主聊天快捷键。
- 继续继承酒馆 CSS 变量；本阶段没有固定暗色、亮色、透明度、纹理或重做聊天卡片。

## 修改或新增文件

前端 `<frontend-repo>` 共 15 个文件：

- `settings.html`、`styles/settings.css`：六组结构、侧栏/窄屏单列、状态与旧端说明，保留原 IDs 和控件事件。
- `style.css`、`src/ui/catalog-viewport.js`、`src/ui/backup-catalog-dialog.js`：当前可视视口布局、安全区、正文滚动与焦点/监听清理。
- `src/controllers/storage-controller.js`、`src/ui/storage-status.js`：活动端统计口径、读取/缺失/失败/只读状态。
- `src/ui/storage-switch.js`、`styles/storage-switch.css`：连接与权限说明、禁用原因、对应结果区域，移除不再使用的旧设置区样式。
- `index.js`：接回原存储统计刷新回调。
- `tests/settings-ui.test.js`、`tests/catalog-dialog.test.js`、`tests/browser/settings-layout-contract.js`：显示、权限、原生核对、视口事件及真实宿主布局验证；移除维持旧靠底布局的断言。
- `README.md`、`CHANGELOG.md`：本阶段说明与 P7 剩余验收。

后端独立仓库 `<server-repo>` **未修改**，不创建无内容提交。协议仍为 4，SQLite schema 3、IndexedDB schema 7，配套后端仍为 `1.0.0-dev.4`。

## 对原四类备份逻辑的影响

无生成/核对/恢复算法改动，无清理内核、数据结构、迁移协议或保护规则改动。设置沿用原 ID、默认值、保存和事件语义；仅增加原已预留的概览刷新接线。SQLite 连接与可写状态只决定界面入口是否可用，不执行迁移或自动切换。

## 已执行测试

P5 基线：前端 272 项、后端 37 项。

| 精确命令/入口 | 结果与范围 |
|---|---|
| 前端根目录 `npm test` | 282/282；含旧功能回归，新统计口径、未知/断线/只读状态、切端期间清除旧数字、连接不修改控制库、原生核对语义、VisualViewport 跟随/回退/解除监听 |
| `node .local-test/p6-native.mjs` | 5 组、0 pageerror；真实酒馆设置入口及 DOM、五种宽度单列、实际显式切换到 SQLite 后统计与旧端可用、受控断线不回退并可恢复 |
| 上述目录布局矩阵 | 7 种尺寸 × 加载/180 聊天长列表/空/失败 = 28 条几何记录；中心偏差 <2px、边界及正文横向溢出断言通过，标题/关闭可达，正文可滚动，搜索/分组/Escape 可用 |
| 上述尺寸 | 1440×1000、601×760、600×760、390×760、320×568、760×390、390×360；覆盖断点两侧、手机竖/横屏和键盘式高度缩小 |
| 上述视口与主题 | 实际浏览器 VisualViewport 1.6 倍页面缩放仍居中；深色、亮色半透明、透明宿主变量切换及计算样式通过，桌面/手机截图已查看。亮色测试同时提供匹配的聊天表面与文字 token，不把仅修改部分主题造成的深底黑字误认作产品布局问题 |
| 停用插件后 `node .local-test/p6-native.mjs --indexeddb-only` | 4 组、0 pageerror，另 28 条布局记录；IndexedDB 继续正常，SQLite 未启用状态明确、切换禁用，无强制安装、迁移或切端 |
| 停用插件后 `node .local-test/run-browser-storage.mjs` | 原真实 IndexedDB 契约 10 组通过：旧库升级、普通读写、关闭重开、真实前端初始化；此项不替代完整原生恢复验收 |
| `node .local-test/run-browser-batch.mjs` | P5 真实 IndexedDB/SQLite 契约 13 组回归，0 pageerror；四范围、保护、过期、真实事务回滚、未知结果与两端隔离 |
| `node .local-test/p5-native.mjs` | P5 真实界面回归 6 组记录，0 pageerror；两端批量操作、手机适配、保护/过期/结果、快照及开关不变；29 个隔离聊天 JSONL 的 SHA256 不变 |
| `node --test ../boxed-lllllabc-server/tests/*.test.js` | 37/37，Node 24.15.0；后端代码未变，回归保护/批量/快照/切换/故障契约 |
| `.local-test/runtime/node.exe --test ../boxed-lllllabc-server/tests/*.test.js` | 37/37，Node 22.14.0，同上 |
| `python .../sillytavern-custom-css-toolkit/scripts/validate_custom_css.py styles/settings.css`、`style.css` | 0 结构错误。宿主颜色变量与 JS 注入的视口变量为预期外部变量，已结合计算样式、回退值和监听测试验证 |
| `node .../impeccable/scripts/detect.mjs --json ...` | 设置及新增 UI 目标无新增发现；完整旧 `style.css` 有 11 处原有侧边强调线提示，均在 P5 基线存在，本阶段按保留原列表要求未改动 |
| `git diff --check` / `git diff --cached --check` | 通过；明确暂存，无需求、报告、测试环境或旧未跟踪文档混入 |

## 真实数据库与酒馆

已执行。使用既有独立 SillyTavern 1.15.0、Node 22.14.0、Edge 156.0.4314.42，固定 `http://127.0.0.1:18000`；运行时、数据、SQLite 和浏览器 Profile 均位于 `.local-test/`。配置经历后端启用 → 停用 → 恢复启用，并已恢复默认单用户测试配置。

主布局矩阵的 180 段聊天只在浏览器内构造目录视图，不写数据库或原生聊天文件。P5 回归使用独立虚构数据，未接触日常数据目录。原酒馆 `<daily-sillytavern>\config.yaml` SHA256 仍为 `[本机配置校验值，公开版省略]`。

## 验收、限制与下一阶段

- **T18：通过当前测试环境验收。** 加载前后及异常/空数据状态均居中，长列表滚动、搜索、分组、关闭入口通过；实际缩放与窗口变化、模拟键盘式高度缩小、视口偏移单元测试通过。
- **T19：通过当前测试环境验收。** 原生深色与受控亮色/透明主题 token 的继承和计算样式、桌面/手机截图通过，无产品透明度覆盖。没有声称任意不协调主题配色都具备相同对比度。
- 手机使用桌面 Edge 的视口模拟；**尚未在真实 Android/iOS、Safari、实际软键盘或刘海设备上验收**。视口偏移有自动化单元测试，实际缩放有浏览器测试；不把缩小窗口冒充真实软键盘弹出。
- **P7 尚未完成**：跨酒馆版本、大数据分页/压力/资源采样、全面 T01–T24 发布门槛与最终 1.0.0 发行仍待综合验收。没有因本阶段 UI 通过而提升公开版本号或推送远端。
- 检查工具提示旧 `PRODUCT.md` 格式漂移；按唯一需求基准与本阶段范围保留原样，未新增/改写产品需求或设计文档。若后续需要，可单独整理该工具元数据。

## 提交与交付

前端本地提交：`a5952b0`，分支 `codex/1.0.0`，15 个明确文件。后端保持 P5 提交 `4d2c777`，工作区无变化。完整提交号见同目录 `p6-commits.json`。未推送远端，未合并 main。

前端仅留下原先四份未跟踪旧文档；当前需求文档、报告和 `.local-test/` 均本地排除。本地测试实例保持运行，供 P7 继续验收。

证据：`p6-unit.log`、`p6-native-result.json`、`p6-native-standalone.json`（各含几何记录）、`p6-storage-regression.log`、`p6-batch-regression-result.json`、`p6-batch-native-regression.json`、`p6-backend-node{22,24}.log`、`p6-css-*.log`、`p6-detector*.json`、`p6-settings-*.png`、`p6-catalog-*.png`。
