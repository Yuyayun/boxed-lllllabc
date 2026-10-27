# P3：切换存储方式

> 公开归档说明（2026-10-27）：本报告保留阶段完成时的实现、测试和未验收项，现按用户授权纳入 `codex/1.0.0` 开发分支。正文中的“不提交报告”“未推送”等为当时状态，不代表本次交付状态；提交报告不将未执行项改记为通过，也不代表正式 1.0.0 发布。需求文档仍仅保留本机。
>
> 原始日志、截图、测试脚本、数据库与浏览器资料保留在本机 `.local-test/`，未随报告发布。命令默认从前端仓库根目录执行，后端为同级独立仓库；机器绝对路径以 `<frontend-repo>`、`<server-repo>`、`<daily-sillytavern>` 代替，日常配置校验值省略。报告是验收记录，不新增产品需求。

日期：2026-10-26。唯一产品需求依据：`docs/boxed-lllllabc-development-spec.md` 第 4 节、P3 及 T08–T12。开发文档、此报告及整个 `.local-test` 只保留本机，不提交。

## 实现与本地提交

- 前端：`<frontend-repo>`，分支 `codex/1.0.0`，提交 `74078167ccff34c5a30b0cf54af5db012c50c2e2`。
- 后端：`<server-repo>`，分支 `codex/1.0.0`，提交 `a229f6f4c1c0e2960c1f5d93e11d8a58bfe7f849`。
- 两个 Git 仓库分别提交；没有创建远端，没有推送、发布或改动 main。前端提交 30 个文件，后端提交 13 个文件。
- 后端 `1.0.0-dev.2`、协议 2、SQLite schema 2；前端 IndexedDB schema 6。1.0.0 正式发布及前端公开版本号更新留待后续发布阶段。

当前活动端通过独立 IndexedDB 控制库持久保存。没有控制记录时默认 IndexedDB；后端可选，发现/连接后端不切换、不迁移、不双写。SQLite 失败不回退写入 IndexedDB。

「存储方式与状态」提供「切换存储方式」及「清空旧端数据」。确认窗口写明目标完整覆盖、不合并、来源保留；用户须确认已停止生成、关闭其他酒馆页签。清空旧端需另行确认，不允许清空当前活动端。

迁移流程：检查两端可用性/可取得的容量 → 排空现有写任务并暂停新任务 → 持久来源锁和一致副本 → 分页原始记录 → 目标独立暂存 → 记录数量、主键、关联及 SHA-256 摘要读回校验 → 复核来源正式数据和当前聊天 → 事务替换目标并保存回滚副本 → 读回目标正式数据 → 原子写入活动端与已激活日志 → 释放临时副本与锁。成功后不清除原来源。

在目标提交后、激活前中断：按持久日志回滚原目标；激活已持久化后中断：核实提交回执并完成收尾。无法读取后端/恢复记录时保留日志和锁，界面显示重试，不猜测选择数据库。

清空旧端复用经过校验的空暂存区与事务替换，提交后读回数量验证；不删除 SQLite 文件、箱装设置或原生聊天文件。

## 影响文件

前端：

- `src/storage/{control,managed,transfer,transfer-format,indexeddb-transfer}.js`：持久控制、操作门、迁移协调、完整记录清单和 IDB 事务暂存/回滚。
- `src/storage/{indexeddb-adapter,sqlite-client,protocol}.js`：迁移端口、容量检查与协议 2。
- `src/db/{schema,migration,index}.js`：增加两张内部表；业务事务检查持久锁并更新修订号；升级被阻塞时拒绝并关闭后续迟到连接。
- `index.js`、`src/events.js`、五个控制器：注入活动端、暂停/排空队列、取消后台核对、为恢复/保存/清理/冻结确认增加操作门、启动恢复；SQLite 统计读取服务器。
- `settings.html`、`src/ui/{storage-switch,storage-status}.js`、`styles/storage-switch.css`、`style.css`：最小入口、明确确认、主题一致的原生模态遮罩、焦点约束及活动端统计。
- `tests/storage-transfer.test.js`、`tests/sqlite-client.test.js`、`tests/browser/transfer-contract.*`、`tests/browser/storage-contract.js`：单元与真实浏览器测试。
- `README.md`、`CHANGELOG.md`：使用、恢复与协议说明，属于产品说明；开发需求文档不提交。

后端：

- `src/transfer.js`：服务端暂存、分页、逐项校验、正式数据复核、事务提交/回滚和持久回执。
- `src/{sqlite,worker,router,errors}.js`：schema 2、旧库一致备份、正常读写锁、修订号、受限 `/transfer` 路由及错误说明。
- `tests/transfer.test.js`：真实 SQLite 升级、提交中途错误、重开恢复、分页、未知数据保护。
- `vendor/frontend`：协议、schema、迁移格式的原样源文件及已提交前端来源记录；没有第二套备份算法。
- `package.json`、`README.md`、`CHANGELOG.md`：独立插件版本及安装/更新说明。

## 原四类备份逻辑影响

无算法调整。对 `src/storage/operations.js`、`src/backup/`、`src/identity.js`、`src/db/identity-reconciliation.js`、`src/rename/` 比较 P2 提交 `5f2200d` 与 P3 提交，差异为空。新增行为集中在存储选择、任务锁和迁移事务；恢复、清理、冻结确认的原逻辑位于操作门之后。

## 已执行测试

1. `npm test`：247/247 通过（原 238 项继续通过）；日志 `p3-unit.log`。
2. `node --test ../boxed-lllllabc-server/tests/*.test.js`：Node 24.15.0，16/16 通过。
3. `& .local-test/runtime/node.exe --test ../boxed-lllllabc-server/tests/*.test.js`：Node 22.14.0，16/16 通过。包含 schema 1→2 升级备份、真实触发器使正式替换中途失败后的事务回滚、关闭重开回滚、未知表保护。原坏库、只读、锁占用、取消和 SQLite max_page_count 满盘模拟仍通过。
4. `node .local-test/run-browser-transfer.mjs`：真实 Edge 156 / HTTP / SQLite / IndexedDB，22 组检查通过，`p3-browser-result.json`。两方向覆盖、全部五类正式仓库及冻结/身份/Date/swipe/undefined 等字段、来源保留、空来源覆盖、清空旧端、各 5 个阶段中断、丢失已提交响应、当前聊天变化、锁、异常关联、未知仓库、IDB 正式替换中途配额异常均有覆盖。大数据 360 层、正文超过 32 MiB，出站 18 批，双向切换约 8.6 秒；普通整包读取仍按 32 MiB 上限拒绝。全部隔离原生群聊文件在测试前后 SHA-256 相同。
5. `node .local-test/p3-ui.mjs`：真实 SillyTavern 1.15.0，7 组 UI 检查通过，`p3-ui-result.json`。桌面 1440×1000、窄屏 390×844；明确确认、生成状态忙时拒绝、模态命中阻止输入/编辑/swipe/聊天选择、Escape 不解锁、Tab 焦点约束、切换成功、刷新活动端持久化、切回 IndexedDB与 SQLite 自身统计。主题变量已读取并核实；4 张截图 `p3-{confirm,busy}-{desktop,mobile}.png` 已视觉检查。测试没有配置模型凭据，发送按钮处于宿主隐藏状态，未执行真实模型生成请求；可见输入/编辑/swipe 与聊天选择、宿主生成忙状态均已检查。
6. `node .local-test/p3-restart.mjs prepare committed` → 关闭浏览器 → `Stop-Test-SillyTavern.ps1` / `Start-Test-SillyTavern.ps1` → `node .local-test/p3-restart.mjs recover committed`：活动端仍 IndexedDB，两端恢复各自原数据。
7. 同样流程对 `activated`：关闭真实浏览器及酒馆进程后恢复，活动端 SQLite，目标为来源副本，来源保留。结果分别在 `p3-restart-*-{prepare,recover}.json`。其余阶段使用故障钩子中断并重新创建协调器，不将这些模拟描述为真实断电。
8. `node .local-test/p3-http.mjs default`、`.local-test/Run-P3-Http.ps1`：真实默认/单账户/多账户/插件停用模式通过。迁移路由保留原生 CSRF、同源、可信账户与会话限制；旧协议、任意 SQL/路径、未知操作拒绝；多账户对状态/采集/暂存/提交/回滚/收尾均拒绝。
9. 上述 HTTP 流程在插件停用阶段执行 `node .local-test/run-browser-storage.mjs`：真实 v3→v6 升级、10 组四类备份旧行为、关闭浏览器重开持久性通过；扩展单独初始化，IndexedDB 正常，后端未安装/未启用状态为 404，页面运行错误为空。
10. `node --check`、`git diff --check` 和显式暂存后的 `git diff --cached --check` 通过。新 CSS 结构检查 0 错误；3 个宿主主题变量提示已通过真实 computed style 核实，未将静态检查当成界面验收。

## T08–T12 对应

| 项目 | 本阶段结果 |
|---|---|
| T08 IndexedDB→SQLite | 真实双端完整替换、源保留、特殊字段与保护状态通过 |
| T09 SQLite→IndexedDB | 真实双端完整替换、源保留及空来源通过 |
| T10 各阶段中断 | 两方向故障注入通过；提交前后真实浏览器/酒馆进程重启通过；两种真实事务中途失败通过 |
| T11 操作锁定 | 模态与焦点检查、宿主生成忙状态拒绝、已打开恢复/保存/清理/冻结确认入口拒绝、跨页签存储锁通过；未连接模型生成 |
| T12 清空非活动端 | 独立确认、禁止活动端、清空后读回、活动数据与设置保留、全部隔离原生群聊文件哈希不变 |

## 环境、安全边界与未验证项

- 仅使用 `.local-test/runtime/SillyTavern`、`.local-test/data`、`.local-test/sqlite` 和独立 Edge 资料；不接触日常聊天与浏览器资料。测试酒馆保持 `127.0.0.1:18000`，默认用户且服务器插件启用，可继续测试。安装后仍默认 IndexedDB。
- 原安装配置 SHA-256 仍为 `[本机配置校验值，公开版省略]`，与 P0 记录相同。
- 当前测试为 SillyTavern 1.15.0；1.19.0 前后真实版本验收、完整移动端生命周期、多小时压力/极端数据规模、真实设备满盘或断电均未验证。合成配额/满盘错误与阶段故障注入不等于这些验收。
- Web Locks 用于跨页签扩展操作锁；界面锁定当前页面。其他浏览器实例、其他插件/外部程序直接修改原生聊天不能宣称全部拦截；确认要求关闭其他页签，提交前再次检查当前聊天及来源正式数据。
- 本次大数据分页适用于完整切换。普通全局目录和单聊天整包读取仍保留 P2 的限额，不宣称已完成全局目录分页或完整压力验收。
- IndexedDB schema 6 保留旧数据并添加内部表；没有提供 6→5 降级工具，旧版扩展可能因版本较旧而无法打开。不要删除数据库/控制记录以绕过恢复。SQLite 升级前生成一致备份，未知/未来版本拒绝覆盖。
- P4 聊天快照未开始。本阶段只迁移实际存在的五个正式仓库；未知仓库/表拒绝处理，P4 添加快照时必须同时扩展迁移格式、索引与验收，不能静默遗漏。
- 前端除 4 个原有未跟踪旧文档外没有待提交改动；后端工作区干净。开发规范、报告和本机环境没有进入两个提交。没有远端推送。
