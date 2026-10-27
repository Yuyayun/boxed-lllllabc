# P4：聊天快照

> 公开归档说明（2026-10-27）：本报告保留阶段完成时的实现、测试和未验收项，现按用户授权纳入 `codex/1.0.0` 开发分支。正文中的“不提交报告”“未推送”等为当时状态，不代表本次交付状态；提交报告不将未执行项改记为通过，也不代表正式 1.0.0 发布。需求文档仍仅保留本机。
>
> 原始日志、截图、测试脚本、数据库与浏览器资料保留在本机 `.local-test/`，未随报告发布。命令默认从前端仓库根目录执行，后端为同级独立仓库；机器绝对路径以 `<frontend-repo>`、`<server-repo>`、`<daily-sillytavern>` 代替，日常配置校验值省略。报告是验收记录，不新增产品需求。

日期：2026-10-26。唯一已确认产品需求依据：`docs/boxed-lllllabc-development-spec.md` 第 5 节、P4、T13–T14，以及存储切换/身份兼容约束。此报告、开发需求文档和 `.local-test` 全部仅保留本机，不提交。

## 实现与本地提交

- 前端独立仓库：`<frontend-repo>`，`codex/1.0.0`，提交 `2dadcc9006a406d81e58e9e6d4d94a17dcae00c7`，35 个文件。
- 后端独立仓库：`<server-repo>`，`codex/1.0.0`，提交 `6762566a0d0c638d8532e0c2bc3169a7c3e453cf`，19 个文件。
- 没有创建远端、推送、发布、修改 main 或合并分支。前端公开版本号仍待 1.0.0 最终发布阶段更新；后端开发版为 `1.0.0-dev.3`。
- 协议 3，IndexedDB schema 7，SQLite schema 3。后端 vendor 来源指向上述前端提交，`worktreeModified:false`，共用存储/校验代码，未维护另一套普通备份算法。

快照无需启用开关，即使普通备份总开关关闭仍可创建和恢复。当前聊天备份中的主要操作为「创建聊天快照」；设置中独立提供「管理聊天快照」，包含列表、预览、重命名、独立确认删除和预览后再次确认恢复。

创建时深拷贝完整消息顺序、全部字段、swipe 候选/选中状态和聊天元数据；名称默认时间，每次分配独立 ID。信息与逐楼层正文分别存储、分批写入，全部完整后发布并读回校验。已发布正文没有更新接口，重命名不改变正文、创建时间或内容摘要。未完成存档明确标注、不能恢复，可手动确认删除。

恢复限定到当前打开的所属逻辑聊天，预览后再次确认完整覆盖。复用现有恢复计划/执行器、未保存保护、原生重绘和 `saveChat` 路径，随后实际读取酒馆聊天 API 核对。目标 UUID 和原生缓存身份保持，源快照保留。写入失败、损坏/缺层、过期预览、原生重绘失败或保存未核实时，不报告恢复完成。

Rename 仅调整快照头的逻辑聊天归属，逐楼层正文及快照 ID 不变；Branch/Checkpoint 不凭共享旧 UUID 继承父聊天快照。快照参与完整双向切换、回滚及非活动端清空；普通清理不涉及快照。后端仍严格可选，默认 IndexedDB，安装/发现后端不切换、不迁移，不双写。

## 修改与新增文件

前端主要文件：

- `src/snapshots/{model,service,restore,confirmation}.js`：不可变内容模型、摘要、分页读取、完整校验、恢复预览、原生保存证明。
- `src/storage/snapshot-operations.js`、`src/storage/value-digest.js`：共用快照事务与稳定摘要。
- `src/db/{schema,migration,index}.js`：新增 `snapshots` / `snapshot_messages`、索引、分页驱动、v7 升级。
- `src/storage/{indexeddb-adapter,protocol,operations,transfer-format}.js`：活动端端口、协议 3、Rename 关联、迁移中快照头/正文的数量/主键/关联/内容校验。
- `src/controllers/snapshot-controller.js`、`index.js`：创建/管理/恢复、操作门、队列暂停、原生保存核对与入口注入。
- `src/backup/{restore-executor,restore,save-request}.js`、`src/controllers/backend-verifier.js`、`src/verifier/compare.js`、`src/db/identity-reconciliation.js`：仅为快照恢复增加应用前检查及专用保存证明/指纹，防止元数据未保存时提前核销；专用记录与普通结构记录分离。
- `src/ui/{snapshots,current-chat-actions,current-chat-panel}.js`、`src/controllers/panel-controller.js`、`settings.html`、`styles/snapshots.css`、`style.css`：当前聊天主要入口、独立管理窗口、主题变量、模态焦点和窄屏滚动。原版本号/扩展信息位置不动，设置整体重排留待 P6。
- `src/controllers/storage-controller.js`：IndexedDB 占用估算包含已完成快照；SQLite 仍使用服务器统计。
- `tests/snapshots.test.js`、`tests/identity-reconciliation.test.js`、`tests/browser/snapshot-contract.*`：模型、保存证明、身份、真实两端数据库检查。
- `README.md` / `CHANGELOG.md`：产品使用、升级、兼容性和阶段说明，不是本次开发需求文档。

后端主要文件：

- `src/sqlite.js`：schema 3、旧库一致备份及事务升级、七种正式记录、快照键/索引/有界分页、共用快照操作。
- `src/{router,errors,transfer}.js`：版本/能力、明确快照错误、迁移记录分组键；继续使用可信身份、单人限制、同源与原生 CSRF。
- `tests/snapshots.test.js`、`tests/transfer.test.js`：新增快照持久化/故障/迁移/证明保护，更新旧 schema 升级检查。
- `vendor/frontend`：相同的快照模型、读取/校验、事务规则、协议/schema/身份规则及来源记录，保留原许可证和署名。
- `package.json` / `README.md` / `CHANGELOG.md`：独立版本和使用说明。

## 对原四类备份逻辑的影响

没有重新设计普通备份算法。相对 P3 提交 `7407816`，`src/backup/{full,recent,historical,cleanup,pending}.js` 和 `src/identity.js` 差异为空。原普通记录的指纹及匹配语义保持。

必要扩展有三处：Rename 事务接续快照头；恢复执行器增加默认无动作的 `beforeApply` 检查；仅携带新 `snapshotSaveProof` 字段的快照恢复保护记录，要求完整正文和元数据核对后才能核销，且证明参与过期计划/条件删除指纹。普通记录不走该证明规则。原 247 项测试继续通过。

## 已执行测试（精确范围）

1. `npm test`：**256/256**，日志 `p4-unit.log`。覆盖深拷贝/不可变正文、独立 ID、默认名称、完整字段、摘要/关联、所属聊天/过期预览、UUID/缓存保留、失败拒绝恢复、专用保存证明；也验证完整备份确认捷径不会绕过快照元数据确认。
2. `node --test ../boxed-lllllabc-server/tests/*.test.js`：Node **24.15.0，22/22**。
3. `& .local-test/runtime/node.exe --test ../boxed-lllllabc-server/tests/*.test.js`：Node **22.14.0，22/22**。真实 SQLite 关闭重开、分批快照、重命名正文不变、普通清理隔离、Rename/Branch、schema 2→3 一致备份、真实触发器导致事务中途失败、迁移回滚、专用证明变化时拒绝旧响应删除均通过；原只读/坏库/锁/满盘模拟仍通过。
4. `node .local-test/run-browser-snapshots.mjs`：Edge **156.0.4314.42**、真实 IndexedDB/HTTP/SQLite，**17 组**通过，`p4-browser-result.json`。包含两端不可变/CRUD、普通备份替换/清理隔离、创建失败不发布、损坏禁止覆盖、保存及重绘失败不误报成功、Rename/共享 UUID 分支隔离、双向迁移和非活动端清空。此脚本中的原生保存端口为受控模拟，不冒充真实酒馆保存。
5. 其中 IDB 正文第二条写入注入 `QuotaExceededError`，真实事务回滚首条正文与写入进度，未留下失败快照或残余正文。SQLite 相应故障使用真实触发器。均不是物理填满磁盘。
6. 同一浏览器测试中，**360 层、正文超过 32 MiB** 的快照分批创建、逐项读回及两方向切换通过；最后一轮合计约 **11,385 ms**。不是全局目录/多小时压力验收，不外推性能上限。
7. `node .local-test/p4-native.mjs`：真实 SillyTavern **1.15.0** 群聊、两种存储，通过实际 UI 创建、预览、二次确认恢复、SQLite 重命名/单独删除；**5 组**，`p4-native-result.json`。先实际保存修改后的聊天，再恢复；通过原生聊天 API 与实际磁盘 JSONL 核对消息顺序、所有候选/选中、完整字段、聊天变量/元数据与 UUID。恢复后源快照仍可读。SQLite 下普通备份总开关关闭仍可执行快照操作，删除快照前后原生文件不变。
8. `node .local-test/p4-character.mjs`：在隔离环境用酒馆原生 API 复制随程序提供的默认角色卡，仅操作测试副本；**两种存储下的角色聊天**均实际恢复、调用原生保存并核对磁盘 JSONL，源快照保留，UUID 不变；`p4-character-result.json`。不是只用群聊或假上下文代替角色路径。
9. `node .local-test/run-browser-transfer.mjs`：P3 **22 组**迁移/阶段中断/真实事务故障检查在新 schema/协议下回归通过，副本结果 `p4-transfer-regression-result.json`。
10. `node .local-test/p4-http.mjs default`、`.local-test/Run-P4-Http.ps1`：默认/单账户/多账户/停用插件模式、CSRF/同源/协议/路径/SQL 白名单通过；多账户对全部 **8 个快照端口**均返回拒绝，见 `p4-http-*.json`。
11. 停用插件、路由 404 时，`node .local-test/p4-native.mjs --indexeddb-only` 实际完成 IndexedDB 快照 UI 创建及原生群聊保存恢复；`p4-native-disabled-result.json`。随后 `.local-test/run-browser-storage.mjs` 的真实 v3→v7、原四类备份 10 组、关闭浏览器重开及前端初始化也通过；后端状态为未安装/未启用，页面运行错误为空。
12. `.local-test/p4-uninstalled.ps1`：停止测试酒馆、校验路径与链接后将服务器插件临时移出，使 `plugins` **物理为空**；重启后再次完成真实 IndexedDB 快照创建/恢复及 JSONL 校验，`p4-native-uninstalled-result.json`。随后已恢复服务器插件及测试服务。无需在运行时安装/加载后端项目代码。
13. `node .local-test/p4-visual.mjs`：**4 组** DOM/交互检查通过，`p4-visual-result.json`。200 字符连续名称不横向溢出、实际主题变量/透明度继承、原生模态与 `100dvh` 支持、受控异步回调期间 Escape/Tab/Ctrl+Enter 锁定。该回调不写入快照，不替代第 7/8 项真实恢复。
14. 已查看桌面 **1440×1000** 与窄屏 **390×844** 的管理/预览/确认图，以及浅色透明主题图：`p4-manager-*.png`、`p4-preview-*.png`、`p4-confirm-mobile-*.png`、`p4-light-transparent-mobile.png`。默认实际颜色来自宿主变量；临时浅色背景保留 `0.82` alpha。新 CSS 结构检查 0 错误，3 个外部变量提示已用真实 computed style 核实。
15. `git diff --check`、语法检查及显式暂存后的 `git diff --cached --check` 通过。全部提交使用明确文件列表；未使用 `git add -A`。

## T13–T14 与安全边界

| 要求 | 本阶段结果 |
|---|---|
| T13 手动快照不随日常内容/普通备份变化 | 两种真实存储校验一致；普通替换/清理不改正文，名称更新不改内容摘要 |
| T14 确认恢复、原生保存正确、源保留 | 群聊两端真实 UI/原生 API/JSONL通过；角色聊天两端真实原生 API/JSONL通过；来源存档保留 |
| 可选后端 | 停用及物理无插件两种状态，IndexedDB 快照均完成真实创建/恢复；不自动切换或迁移 |
| 元数据未保存 | 专用证明阻止仅凭正文相同或完整备份确认捷径核销；当前实际完整正文/元数据一致后才确认 |

原生 `clearChat`/重绘会补入 `chat_id_hash` 缓存；实现保留目标缓存与 UUID，未修改快照原始内容。快照数据保留 Date/undefined 等存档字段；原生保存核对按酒馆 JSON 持久化语义验证，不宣称酒馆原生文件能够额外持久化任意 JavaScript 类型。JSON 无法提交的内容在覆盖前拒绝。

当前仅测试单人默认/唯一账户环境；多账户明确拒绝 SQLite，不新增同步或多用户支持。操作门与模态遮罩保护当前页面/扩展队列；其他插件直接改写内存或外部程序修改原生数据，仍不能宣称完全拦截，恢复前/保存前会再次复核。

## 尚未验证、限制与下一阶段

- 真实跨版本矩阵（尤其 1.19.0 前后原生 Branch/Checkpoint）、实际手机/软键盘生命周期、数万快照/数万楼层、多小时压力、真实断电和设备物理满盘未完成，保留至 P7。
- 分批与分页不等于无任何上限：沿用单记录 8 MiB、协议结构和普通业务查询限额。超大单层/快照信息明确失败，不截断；未验证所有极端规模。内容摘要需要浏览器安全上下文的 Web Crypto，切换还需要 Web Locks；localhost/本次环境已验证。
- 未完成存档不会误报成功，可在管理中确认删除；不自动将缺失内容的草稿变成可恢复快照。
- P5 批量清理与 P6 设置总体分组尚未开始，本次没有把快照混进普通备份清理，也没有重排原扩展信息。
- 目前前端仅有 4 个原有未跟踪旧文档，跟踪文件干净；后端干净。开发规范、阶段报告和本机测试代码/数据没有进入提交；没有远端推送。
- 测试程序、数据、浏览器资料都位于 `.local-test`；没有操作日常聊天。原安装配置 SHA-256 仍为 `[本机配置校验值，公开版省略]`。这仍是目录/进程配置隔离，不是操作系统文件访问沙箱。
- 各测试资料独立，但共享一个合成 SQLite 数据库；会写库的验收必须串行。当前服务器插件已恢复，默认账户测试服务在 `http://127.0.0.1:18000`，新浏览器资料默认仍为 IndexedDB。
