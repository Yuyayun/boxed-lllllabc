# 2026-10-26：P0 完成度核对与 P1 阶段报告

> 公开归档说明（2026-10-27）：本报告保留阶段完成时的实现、测试和未验收项，现按用户授权纳入 `codex/1.0.0` 开发分支。正文中的“不提交报告”“未推送”等为当时状态，不代表本次交付状态；提交报告不将未执行项改记为通过，也不代表正式 1.0.0 发布。需求文档仍仅保留本机。
>
> 原始日志、截图、测试脚本、数据库与浏览器资料保留在本机 `.local-test/`，未随报告发布。命令默认从前端仓库根目录执行，后端为同级独立仓库；机器绝对路径以 `<frontend-repo>`、`<server-repo>`、`<daily-sillytavern>` 代替，日常配置校验值省略。报告是验收记录，不新增产品需求。

唯一已确认产品需求为 `docs/boxed-lllllabc-development-spec.md`，本次发行目标由用户指定为 1.0.0。此报告、开发需求和测试实例均仅保留本机，不参与提交。

P1 本地阶段提交：`35fdacb`（`refactor: introduce shared IndexedDB storage service`），共 17 个代码/测试文件，未推送远端。

## P0：具备进入 P1 的条件

- 前端分支 `codex/1.0.0`，从 `main` 的 `6f6054d` 建立，原产品版本 0.1.4。
- 修改前执行 `npm test`，226/226 通过、0 失败、0 跳过；本轮复测结果在 `p1-baseline.log`。
- 用户已创建且本会话已核实后端仓库 `https://github.com/Yuyayun/boxed-lllllabc-server`，未创建或推送任何远端。
- 独立酒馆复制在 `.local-test/runtime/SillyTavern`，SillyTavern 1.15.0 / Node v22.14.0。独立配置、数据、插件目录、SQLite 目录；只监听 `127.0.0.1:18000`，未复制原有聊天、配置或第三方插件。
- 原酒馆配置 SHA-256 与隔离前记录一致。运行副本没有 reparse point，也不使用原前端扩展链接。Git ceiling 防止酒馆发现外层前端仓库。
- HTTP 冒烟验证主页、缺少 CSRF 拒绝、虚构群聊原生 API 保存/读回以及实际 JSONL 落盘；结果 `smoke-result.json`。
- 本轮补齐独立持久化 Edge 资料中的真实 IndexedDB 检查和前端初始化；未使用日常浏览器资料。
- 已固定虚构测试数据：中文/特殊字符、多 swipe、Date、null/undefined、嵌套字段、旧 v3 schema、共享 UUID 的 Branch、显式 Rename、冻结及等待确认记录。
- 隔离是运行目录和数据隔离，不是操作系统权限沙箱。跨酒馆版本、SQLite、全量原生事件和视觉验收按后续阶段执行。

## P1：统一存储访问层

### 本阶段实现

- 新增 `src/storage/service.js` 和 `indexeddb-adapter.js`。服务只委派给一个适配器；当前默认仍为 IndexedDB，无探测后端、自动切换、迁移、双写或错误回退。
- 会话提供业务级操作，不向控制器暴露原始 IndexedDB 句柄。20 个现有操作覆盖元数据、四类备份、目录、身份、冻结和清理。
- 原事务操作保留在 `src/db/index.js`：指纹复核与删除、冻结解决、身份迁移、pending 条件删除仍各自在原事务内执行。
- `index.js` 创建同一存储服务，并显式注入备份协调、原生保存核对、恢复、当前面板、全局目录及存储状态控制器。
- `src/backup/recent.js` 改为接收存储服务；协调器和恢复后的 recent 更新传递同一个实例。
- 原生保存核对后的 pending 删除及旧版 Rename 源元数据读取同样经存储会话访问。
- 快照、完整原始导出/导入、切换和旧端清空接口随 P3/P4 实现，本阶段不提供空实现或伪成功入口。

### 影响文件

产品代码共 10 个文件：

- `index.js`
- `src/storage/service.js`（新增）
- `src/storage/indexeddb-adapter.js`（新增）
- `src/backup/recent.js`
- `src/controllers/backup-coordinator.js`
- `src/controllers/backend-verifier.js`
- `src/controllers/panel-controller.js`
- `src/controllers/restore-controller.js`
- `src/controllers/catalog-controller.js`
- `src/controllers/storage-controller.js`

测试共 7 个文件：修改 `tests/{catalog,cleanup,controllers,storage}.test.js`，新增 `tests/storage-service.test.js` 和 `tests/browser/storage-contract.{html,js}`。

旧测试只调整存储注入方式：从原始 DB 及单个函数替换为存储会话。原有成功/失败、关闭次数、调用顺序、指纹与保护断言保留，没有删除测试或削弱保护断言。

### 对原四种备份逻辑的影响

只改变数据访问接线。`src/db/`、身份/旧版改名模块、full/historical/pending 算法、恢复计划和执行器、清理规则、设置及 UI 均未改动；DB 名称、v5 schema 和 0.1.4 发布元数据不变。

### 实际执行测试

1. `npm test`：修改前 226/226 通过，修改后 232/232 通过，0 失败、0 跳过。修改后输出 `p1-full.log`。
2. `node --test tests/controllers.test.js tests/catalog.test.js tests/cleanup.test.js tests/storage.test.js tests/recent.test.js`：49/49 通过，输出 `p1-targeted.log`。
3. `node --test tests/storage-service.test.js`：6/6 通过，输出 `p1-service.log`。覆盖默认端懒加载、错误不回退、recent 消息与楼层、提前返回关闭会话、协调器读取、恢复保护写入失败的回滚及禁止保存。
4. `.\.local-test\deploy-frontend.ps1` 后 `node .local-test/run-browser-storage.mjs`：真实 Edge 156.0.4314.42、独立持久化资料，10 组原生 IndexedDB 检查通过：
   - 真实 v3 旧库升级至 v5 且旧数据保留；
   - 四类记录原样读回（Date、swipe、null/undefined、嵌套字段）；
   - 事务中途 DataCloneError 导致整笔回滚；
   - 历史记录首次捕获时间保留；
   - pending 内容复核及已取消任务不得删除；
   - 过期清理计划、pending、冻结及等待确认保护；
   - 共享 UUID Branch 独立和 Rename 四类记录迁移；
   - 协调器经统一存储写入四类备份；
   - 保存核对控制器经活动存储核销 pending；
   - 异常缩短冻结且保留原完整备份。
5. 关闭浏览器进程并重新打开同一独立资料，实际读回旧元数据、Date、完整备份及冻结状态通过。
6. 未安装箱装服务器插件的真实酒馆页面完成前端初始化；空聊天状态为 `identity-missing`（当前没有可备份的聊天），非数据库错误；页面异常和失败 HTTP 响应均为 0。
7. `git diff --check` 通过；检索显示控制器和 recent 不再直接访问 IndexedDB；原酒馆配置及原数据库/算法/界面文件未改动检查通过。

首次浏览器检查中，真实 DB 与持久化测试通过，但原生默认 AI Horde 连接因网络受限导致页面 JSON 异常。通过调整独立测试用户的模型连接预设解决，未改箱装代码、未屏蔽页面异常断言；修正后完整浏览器检查通过。结果 `p1-browser-result.json`。

### 验证范围与未验证项

- 真实 IndexedDB：已执行，包含事务回滚和关闭浏览器后的持久化。
- Node 模拟：已执行，不能等同真实数据库或全部酒馆集成。
- 浏览器中协调器/保存核对检查使用真实 IndexedDB，但上下文及 `readBackend` 是注入夹具，不能宣称这些案例已验证原生聊天文件最终保存。
- 真实酒馆：环境原生 API 冒烟、前端独立初始化已执行。完整发送/编辑/删除/swipe、恢复保存、Branch/Checkpoint、角色/群聊的原生 UI 操作及全部 T01–T24 尚未执行。
- SQLite、多账户限制、协议、双向切换、故障注入、快照、批量清理、压力与移动端视觉：未执行，属于后续阶段。
- 旧/新酒馆版本兼容：目前只有 1.15.0，1.19.0 及之后的真实版本尚未准备。

### 下一阶段依赖及风险

- P2 使用用户确认的独立后端仓库；后端代码不可放入前端仓库作为交付结构。未授权推送远端。
- SQLite 必须保留这些事务操作的原子性，不能将一个事务拆成多个独立网络写请求。
- pending 删除中的任务有效性回调不可直接 JSON 序列化为服务端条件；P2 需依据真实请求/事务机制保留取消及内容复核保护，不能省略。
- `getBackupCatalogData` 会筛除异常记录，P3 不能将它当完整迁移导出。
- P2/P3 才引入 SQLite 状态、各自统计和模式激活；不得让浏览器配额统计冒充 SQLite 空间。
- 阶段成果仅做本地 Git 提交；报告、开发需求、测试实例、日志及测试数据不参与提交，未推送远端。
