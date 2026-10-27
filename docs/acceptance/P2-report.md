# P2 阶段报告（2026-10-26）

> 公开归档说明（2026-10-27）：本报告保留阶段完成时的实现、测试和未验收项，现按用户授权纳入 `codex/1.0.0` 开发分支。正文中的“不提交报告”“未推送”等为当时状态，不代表本次交付状态；提交报告不将未执行项改记为通过，也不代表正式 1.0.0 发布。需求文档仍仅保留本机。
>
> 原始日志、截图、测试脚本、数据库与浏览器资料保留在本机 `.local-test/`，未随报告发布。命令默认从前端仓库根目录执行，后端为同级独立仓库；机器绝对路径以 `<frontend-repo>`、`<server-repo>`、`<daily-sillytavern>` 代替，日常配置校验值省略。报告是验收记录，不新增产品需求。

唯一产品基准为 `docs/boxed-lllllabc-development-spec.md`，发行目标为用户指定的前端 1.0.0。本报告、需求文档、测试实例、日志及数据库不参与提交。

阶段本地提交：前端 `5f2200d`（9 个代码/测试/README 文件）；独立后端 `4a77dff`（26 个文件）。两仓库分支均为 `codex/1.0.0`，未推送远端。后端首次提交临时复用前端已配置的 Git 作者身份，没有改全局 Git 配置。

## 本阶段实现与仓库边界

- 后端：`<server-repo>`，独立 Git 仓库，origin 为 `https://github.com/Yuyayun/boxed-lllllabc-server.git`。远端最初为空，本地使用 `codex/1.0.0`，不放在前端仓库内作为交付结构。
- 独立可安装插件根目录：`index.mjs`、`package.json`、`src/`、`vendor/`，以及 README、LICENSE、CHANGELOG。没有 npm 依赖，没有独立 Node 服务、URL/API Key 配置或自动安装。
- 后端开发版本 `1.0.0-dev.1`、协议 1、SQLite schema 1。实际安装范围仅 `.local-test/runtime/SillyTavern/plugins/boxed-lllllabc-server`，没有修改原酒馆。
- SQLite 使用 Node 内置驱动，在同进程工作线程中串行执行；有界队列、1 秒 busy timeout、WAL/FULL 同步、事务、明确故障状态和结果未知提示。
- 数据文件固定在服务端专用目录，测试目录 `.local-test/sqlite`，禁止落入原生数据、public、插件或 node_modules 内；浏览器不能提交文件路径或 SQL。
- 主机接线读取当前酒馆真实源码接口：`getAllEnabledUsers`、`req.user.profile`、`req.session.handle` 和服务端配置。默认用户和唯一启用账户必须与请求身份一致；多账户、身份不可靠、CSRF 关闭和跨源请求拒绝。
- 数据库绑定可信账户归属，不因账户变化转交旧数据。卸载或停用插件不删除 SQLite。
- 提供状态与受限业务操作 API；错误不回退 IndexedDB。当前没有用户切换入口、全量导入/清空接口或迁移任务。

## 对原四类备份的影响

为避免复制两套算法，将 P1 `src/db/index.js` 的 22 个导出和内部事务规则原样抽取为 `src/storage/operations.js`，由 IndexedDB 注入原事务/请求驱动，SQLite 注入 SQL 事务/记录驱动。已按函数体比对 P1 内容一致，原冻结、pending、指纹清理、Rename 和分支身份规则没有放宽。

后端 `vendor/frontend` 保留这些共用模块的原样副本、原许可证和 ORIGIN 来源记录；运行时不依赖前端仓库路径或安装，前后端分别发布。更新保护规则时需同步维护这些来源模块。

SQLite 网络层不能序列化 `shouldDelete` 回调，因此新增了原生保存核对任务的 AbortSignal 传递；旧任务取消既保留原回调复核，也会中断远端请求。服务端用共享取消标记在事务提交前检查。分布式请求一旦已提交便不能凭取消逆转，超时/断线仍需重读确认，不宣称事务绝对不会在响应丢失前提交。

前端默认服务仍只使用 IndexedDB。新增 SQLite 客户端只有被显式注入时才访问 SQLite；安装、连接、状态探测不改变活动端或自动迁移。

## 修改或新增文件

前端共 9 个：

- `README.md`：真实后端地址、独立可选安装、开发阶段说明。
- `src/db/index.js`：保留原 IndexedDB 入口和事务驱动，导出共用操作。
- `src/storage/operations.js`：共用事务规则。
- `src/storage/protocol.js`：明确操作名单及无损编码。
- `src/storage/sqlite-client.js`：同源/CSRF、协议/状态、受限操作及取消。
- `src/controllers/backend-verifier.js`：旧核对任务取消信号传递。
- `tests/sqlite-client.test.js`：6 项新测试。
- `tests/browser/sqlite-contract.html`、`sqlite-contract.js`：真实双端语义检查。

后端：`index.mjs`；`src/{host,router,sqlite,worker,worker-client,errors}.js`；`tests/{sqlite,security,worker-timeout}.test.js`；`vendor/frontend` 来源模块及许可证；README、LICENSE、CHANGELOG、package.json、.gitignore、.gitattributes。

## 实际测试与结果

1. 抽取共用事务规则后 `npm test`：原 232 项通过。P2 最终 `npm test`：**238/238 通过**，0 失败、0 跳过；记录 `p2-frontend-final.log`。
2. `node --test tests/sqlite-client.test.js`：6/6 通过，覆盖后端缺失、协议不兼容、多账户、超时、默认模式不变、CSRF 传递、无损字段、关闭会话、错误不回退以及核对任务取消。
3. 后端 `node --test tests/*.test.js`：**12/12 通过**，分别使用 Node **22.14.0**（酒馆实际运行时）和 **24.15.0**；记录 `p2-backend-node22.log`、`p2-backend-final.log`。
4. 真实 SQLite 临时文件验证：四类备份落盘/关闭重开、复合键、Date/swipe/null/undefined、事务中途失败回滚、pending 条件删除、冻结/待确认保护、共享 UUID 分支独立和 Rename 接续、应用归属、识别旧 schema 的升级备份、未来或未知数据库拒绝覆盖、只读、损坏、写锁、`max_page_count` 注入 SQLITE_FULL、有界队列、取消及工作线程超时。
5. 真实酒馆 1.15.0 / Node 22.14.0 在独立目录的多轮重启：默认用户、唯一启用账户、两个真实启用账户、已安装但停用插件、恢复默认模式均通过；多账户拒绝状态和写入，之后单账户重启读回原数据，确认被拒绝条目未写入。记录 `p2-http-{default,single,multi,disabled,reopened}.json` 和 `p2-native-modes.log`。
6. 真实插件 HTTP 接口：CSRF 缺失、跨源、协议不兼容、任意 SQL/路径、未知操作均拒绝；酒馆主页仍正常。
7. `node .local-test/run-browser-sqlite.mjs`：Edge **156.0.4314.42**，独立浏览器资料，**5 组双端语义检查通过**。通过真实 HTTP/SQLite 对照真实 IndexedDB：四类备份、首次历史时间、特殊字段、pending、冻结处理、单类型清理一致；后端连接后默认仍为 IndexedDB。记录 `p2-browser-result.json`。
8. `node .local-test/run-browser-storage.mjs`：P1 的 **10 组真实 IndexedDB 检查及关闭浏览器进程后的持久化重新通过**；在后端已启用、状态 HTTP 200 的情况下，前端默认初始化无页面异常。记录 `p1-browser-result.json` 和 `p2-indexeddb-final.log`。空聊天状态是 `identity-missing`，不是数据库故障。
9. `node .local-test/p2-fault.mjs`：真实 SQLite 写锁占用时状态明确失败，酒馆主页本次约 **12 ms** 返回，锁请求约 **1193 ms** 失败；解除锁后状态恢复。只是本机单次测量，不代表压力测试或零性能影响。
10. `git diff --check` 通过；原酒馆配置 SHA-256 保持不变。开发需求和 `.local-test` 继续由本机 `.git/info/exclude` 排除。

## 测试发现及修复

- SQLite 遇到 SQLITE_FULL 可能已自行回滚。最初错误处理再次 ROLLBACK 覆盖了原始 full 错误；现已仅识别这个明确的自动回滚状态，并保留原错误。其他回滚失败会汇总报告，不吞掉保护错误。
- 最初测试清理先于连接关闭，Windows 拒绝删除仍打开的临时数据库。已调整测试资源管理：先关闭全部资源，再核对临时绝对路径并清理；没有弱化数据库断言。
- 运行时 Node 22 的 `node:sqlite` 有实验性提示，已记录在后端 README，不将 Node 版本可用性当作跨版本保证。

## 尚未验证与下一阶段依赖

- P3 的用户显式切换、目标暂存、全量覆盖、崩溃恢复、清空非活动端均未实现/验收；P4 快照亦未实现。未提供伪成功入口。
- SQLite 当前限额：请求 16 MiB、记录 8 MiB、事务读取 25,000 行/32 MiB、响应 32 MiB。大规模目录分页、迁移批次及数百 MB 数据的压力验证尚待后续，不能将本阶段通过等同全规模已验收。
- 原生聊天完整恢复、全事件链、移动端视觉、1.19.0 及之后版本、全量 T01–T24 尚未完成；本阶段真实集成范围仅如上所列。
- 取消为尽力中断并在提交前检查；提交后的响应丢失仍属于结果未知。P3 必须另加迁移事务标记与重启恢复，不能复用普通请求成功标志冒充迁移完成。
- `getBackupCatalogData` 会筛除异常记录；P3 仍需独立原始记录导出，不能把它用于全量迁移。
- 同源插件没有操作系统沙箱，工作线程避免同步 SQL 阻塞主线程，但主线程仍承担协议编解码；不能宣称物理隔离或所有负载下无影响。
- 前端设置 UI 状态分组和用户切换入口尚未开放。运行验证后，隔离酒馆保持默认用户、插件启用；日常前端活动端仍为 IndexedDB。
- 两仓库均仅准备本地阶段提交；未推送远端。后端远端在本阶段开始时为空，因此现在直接从 GitHub 安装未必有代码，应以实际发布状态为准。

## 参考依据

- 实际隔离酒馆的 `src/plugin-loader.js`、`src/server-main.js`、`src/users.js` 和 `src/util.js`。
- [官方插件规范](https://docs.sillytavern.app/for-contributors/server-plugins/)。
- [Node 22.14 SQLite 文档](https://nodejs.org/download/release/v22.14.0/docs/api/sqlite.html)。
