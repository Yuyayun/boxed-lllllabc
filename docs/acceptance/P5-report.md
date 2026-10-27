# P5：普通备份批量清理

> 公开归档说明（2026-10-27）：本报告保留阶段完成时的实现、测试和未验收项，现按用户授权纳入 `codex/1.0.0` 开发分支。正文中的“不提交报告”“未推送”等为当时状态，不代表本次交付状态；提交报告不将未执行项改记为通过，也不代表正式 1.0.0 发布。需求文档仍仅保留本机。
>
> 原始日志、截图、测试脚本、数据库与浏览器资料保留在本机 `.local-test/`，未随报告发布。命令默认从前端仓库根目录执行，后端为同级独立仓库；机器绝对路径以 `<frontend-repo>`、`<server-repo>`、`<daily-sillytavern>` 代替，日常配置校验值省略。报告是验收记录，不新增产品需求。

日期：2026-10-27（Asia/Shanghai）。唯一产品需求依据：本机 `docs/boxed-lllllabc-development-spec.md` 第 6 节与 P5/T15–T17。本文、需求文档及整个 `.local-test/` 均不提交。

## 本阶段实现

- 全局目录保留统计、搜索、角色/群聊折叠分组、每聊天四类概况、单聊天管理；新增默认收起的「批量清理」。
- 四范围：全部、单角色/群聊全部、单角色内多选、跨角色多选。多选使用单独的轻量列表与选择数；筛选不会取消隐藏选项；取消清除选择并收起。普通聊天卡片不添加选择框。
- 可选最近、完整、历史类型；复用原 `cleanup.js` 保护判断、指纹及元数据补丁。pending 始终禁止直接删除，冻结/等待原生后端确认的完整备份始终保留。
- 预览从当前活动端新读取数据，显示活动端、聊天数、可删记录/字节估算、保护跳过项及原因，明确再次勾选确认。
- 两端执行均在一个五普通表的读写事务内重读整个选中范围、复核身份元数据指纹、四类记录指纹和保护状态，再调用同一个单聊天删除内核。动态「全部/单角色全部」还会检查新增/消失的目标。显式选择不会因为无关聊天新增而失效。
- 任一目标变动即拒绝旧计划，返回 `stale-cleanup-plan`；写入中途错误整批回滚。清理成功、跳过、失败按「聊天 × 备份类型」统计，并列出已删/保护条目；整个事务回滚时成功为 0。网络结果未确认显示「未确认」，不能声称零删除或全部成功，也不能直接重复旧确认。
- 成功后的显示刷新错误保留已提交结果，并提示手动刷新。迁移门、会话锁、活动端校验仍适用，无回退写入。
- 确认窗口为原生模态，正文独立滚动；忙碌期间阻止关闭及宿主快捷键，保留焦点。按钮局部覆盖宿主 `width:min-content`，防止窄屏文字竖排。
- 仅活动端普通备份；快照信息/正文、另一存储端、控制库、备份开关、原生聊天文件保留。批量清理不等同于清空非活动端。开关不变，后续聊天仍可能重新生成备份。
- 协议升至 4，后端 `1.0.0-dev.4`；IndexedDB schema 7、SQLite schema 3 不变。前端仍可单独使用 IndexedDB，安装后端不自动切换或迁移。

## 修改或新增文件

前端独立仓库 `<frontend-repo>`：

- `src/backup/batch-cleanup.js`：范围规范化、保护计划和过期校验；`catalog.js` 新增元数据清理指纹；`cleanup.js` 只修正活动端提示。
- `src/storage/operations.js`：抽出既有删除内核，在同一事务中复用；`src/db/index.js`、`src/storage/indexeddb-adapter.js`、`src/storage/protocol.js` 注册受限端口。
- `src/controllers/catalog-controller.js`：新读预览、执行、活动端绑定、刷新及未知结果处理。
- `src/ui/batch-cleanup.js`、`styles/batch-cleanup.css`、`style.css`：选择、预览、明确确认、结果与样式。
- `src/ui/backup-catalog-dialog.js`：接入折叠区，读取提示对应活动端；`backup-cleanup-dialog.js` 仅修正单聊天说明中的浏览器限定。
- `tests/batch-cleanup.test.js`、`tests/browser/batch-{fixture,contract}.js`、`tests/browser/batch-contract.html`。
- `README.md`、`CHANGELOG.md`：本阶段行为、保护、当前协议与剩余验收；修正过时的“切换尚未实现”说明。

后端独立仓库 `<server-repo>`：

- `src/sqlite.js`：明确注入 SQLite 模式，复用普通事务；`src/errors.js`：保留过期计划代码；`src/router.js`、`package.json`：开发版本更新。
- `vendor/frontend/src/backup/{batch-cleanup,catalog,cleanup}.js`、`vendor/frontend/src/storage/{operations,protocol}.js` 及 `ORIGIN.json`：前端同源规则，保留许可及来源信息。
- `tests/batch-cleanup.test.js`、`tests/batch-fixture.js`：真实落盘批量范围、保护、过期、回滚及超限拒绝。
- `README.md`、`CHANGELOG.md`：批量端口、版本/协议、限额及可选安装语义。

## 对原四类备份的影响

最近、完整、历史、pending 的生成、核对、恢复算法均未修改。原单聊天事务仍只打开原本的元数据和目标类型两个表；原删除内核只作提取并由单聊天与批量入口共用。完整保护检查和原元数据清理补丁保留。

不会通过 `pending` 类型、伪造计划、非活动端清空参数、任意 SQL 或路径绕过保护；快照及其正文不在批量事务的表清单中。

## 已执行测试

P4 基线：前端 256 项、后端 22 项。本阶段前端 272 项，后端 37 项。

| 命令/入口 | 结果与覆盖 |
|---|---|
| 前端根目录 `npm test` | 272/272；原清理/备份/迁移/快照回归、新四范围计划、变化/篡改/模式校验、确认、锁门、错误/未知结果及刷新异常 |
| `node --test ../boxed-lllllabc-server/tests/*.test.js` | 37/37，Node 24.15.0；先在工作区隔离副本完成同套验证，最终独立仓库再次执行 |
| `.local-test/runtime/node.exe --test ../boxed-lllllabc-server/tests/*.test.js` | 37/37，Node 22.14.0；真实落盘、关闭重开、原快照/切换/故障规则及新增批量测试 |
| `node .local-test/run-browser-batch.mjs` | 13 组，真实 IndexedDB + 同源插件 SQLite，0 pageerror；两端四范围、九类执行前变化、真实 IDB 中途异常回滚、快照完整读回、另一端/控制库不变；SQLite 已提交但丢响应时结果未知，旧计划重试拒绝 |
| `node .local-test/p5-native.mjs` | 6 组记录，0 pageerror；真实设置按钮进入目录，在 IndexedDB/SQLite 实际预览、变更后拒绝、重预览及确认清理，计数正确，快照和开关保留；29 个隔离原生聊天 JSONL SHA256 不变 |
| 同上手机/主题检查 | 320/390px 长名称无横向溢出，标题/确认及关闭可达；深色和亮色半透明主题变量实际生效；受控延迟回调验证 Escape/Tab/Ctrl+Enter 不解锁或触发生成（该受控项不写库） |
| `.local-test/Run-P5-Http.ps1` | 默认/唯一启用用户可用；真实多账户拒绝新增批量端口；CSRF、同源、旧协议 3、坏计划均拒绝；插件停用不删除数据，重新启用仍读原库 |
| 插件停用后 `node .local-test/run-browser-batch.mjs --indexeddb-only` | 6 组 IndexedDB 批量清理验收；无 SQLite 依赖 |
| 插件停用后 `node .local-test/run-browser-storage.mjs` | 10 组原普通存储、旧 IDB 升级、关闭重开及真实前端初始化回归 |
| `node .local-test/run-browser-transfer.mjs` | 22 组迁移/故障/完整读回回归，0 pageerror；包含超过 32MiB 的 360 楼层数据，原生文件哈希不变。此为已有 P3 契约回归，不代表 P7 全面压力验收 |
| `node .local-test/run-browser-snapshots.mjs` | 17 组快照/故障/双向切换回归，0 pageerror；包含超过 32MiB 的 360 楼层快照 |
| `python .../sillytavern-custom-css-toolkit/scripts/validate_custom_css.py styles/batch-cleanup.css` | 0 错误，5 项宿主变量提示；实际源码/计算样式与截图已核对变量及透明度 |
| `git diff --check` / 明确暂存后的 `git diff --cached --check` | 通过；需求文档、阶段报告和测试环境均排除 |

SQLite 故障测试采用真实 SQL 触发器在前面的记录和元数据已删除/修改后抛错，验证全部回滚；IDB 故障测试在真实浏览器事务中注入删除异常。不是物理填满磁盘，也没有损伤真实用户数据。额外插入 25,001 条记录验证普通全局读取超限时明确失败、无截断及部分删除。

## 真实数据库与酒馆

已执行。SillyTavern 1.15.0、Node 22.14.0、Edge 156.0.4314.42；独立地址 `http://127.0.0.1:18000`，独立运行时/数据/SQLite/浏览器 Profile 均在本项目 `.local-test/`。这是文件与运行配置隔离，不是操作系统沙箱。

原酒馆位置以 `isolation.json` 为准，为 `<daily-sillytavern>`，未写入。原 config.yaml SHA256 仍为 `[本机配置校验值，公开版省略]`。P5 原生 UI 测试的 29 个隔离聊天文件哈希也保持不变。

## 验收与剩余边界

| 项目 | 本阶段结论 |
|---|---|
| T15 四种范围 | 通过；两端真实数据/实际 UI 入口 |
| T16 pending、冻结、待确认保护 | 通过；计划可见，真实删除仍保护，快照保留 |
| T17 预览后变化 | 通过；计划、控制器和数据库事务内校验，变化时零删除 |
| P6/T18–T19 | 未完成；本次只验批量窗口适配，没有改全局目录原有靠底布局、设置菜单分组 |
| P7/T01–T24 综合发布门槛 | 未完成；完整压力/资源采样、跨酒馆版本与真实手机设备验收仍待 P7 |

普通全局目录仍沿用现有 SQLite 25,000 行 / 32MiB 读取预算、16MiB 请求与 15 秒工作线程限制；批量事务额外读回目标记录/键也计入预算，可能更早触达限额。超限整批失败，不自动截断/分批提交。IDB 本阶段仍整体读取普通目录；不能据本阶段样本推断任意规模均流畅。大数据分页、资源上限与全面跨版本验收留待 P7。

未重跑完整 P4 原生恢复/角色/群聊/Branch/Checkpoint 流程；本次保留 P4 验收结论，并回归了快照真实数据库契约和普通清理保护。没有宣称所有版本、真实手机或所有故障均已通过。

## 提交与交付

两仓库均在既有 `codex/1.0.0` 分支，使用明确文件清单分别本地提交；不创建/推送远端，不合并 main。

- 前端：`d71a2f8`（完整提交号见同目录 `p5-commits.json`），19 个文件。
- 后端：`4d2c777`（完整提交号见同目录 `p5-commits.json`），14 个文件。`vendor/frontend/ORIGIN.json` 对应前端本次提交，`worktreeModified:false`。
- 前端无已跟踪文件变更，只有原先四份未跟踪旧文档；本次需求文档和 `.local-test/` 被本地排除。后端工作区干净。

提交后已将两仓库这组源码重新部署到隔离实例并重启，再跑 P5 的 13 组浏览器契约和默认用户 HTTP 校验，均通过、0 pageerror。最终 `/status`：`pluginVersion:1.0.0-dev.4`、`protocol:4`、`schema:3`、`writable:true`；最终契约浏览器仍为 IndexedDB 活动端，没有因安装或重启自动切换。隔离实例保持运行供后续 P6 使用。

测试证据：`p5-unit.log`、`p5-backend-node22.log`、`p5-backend-node24.log`、`p5-browser-result.json`、`p5-browser-standalone.json`、`p5-native-result.json`、`p5-http-*.json`、`p5-transfer-regression-result.json`、`p5-snapshot-regression-result.json`；UI 截图为 `p5-preview-*.png` 和 `p5-result-*.png`。
