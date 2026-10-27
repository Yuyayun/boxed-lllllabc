# 2026-10-27：首轮审查意见核实与修复

本记录追加于 P1–P7 历史报告之后，不改写各阶段当时的测试结果。产品需求仍以本机开发规范为唯一已确认基准，需求原文不提交。

## 核实结果与修改

1. **SQLite 批量清理超时可能误报确定失败：成立。** 使用原生 `DOMException("The operation was aborted.", "AbortError")` 复现，其数字 `code:20` 在旧判定中既不是无 code，也不是 `outcome-unknown`；旧返回为 `unknown:false`、`committed:false`、`succeeded:0`。这不能证明服务器未提交。新增回归在修改产品代码前运行，26 项中 23 通过、3 项失败，分别覆盖控制器判定、fetch 超时及响应正文超时；正文中断还暴露客户端把原异常改写成 `unavailable` 的问题。
2. **README 尚称开发成果未推送：成立。** 前后端开发分支及报告此前已推送；README 改为分别推送至 `codex/1.0.0`、报告已归档、未合并 main 和未正式发布 1.0.0。公开版本号保持 0.1.4，不把未发行状态当成版本错误。

修改文件：

- `src/controllers/catalog-controller.js`：已进入 SQLite 批量删除调用后的 `AbortError` / `TimeoutError` 明确归为未知结果，`committed`、成功数和失败数为 `null`，提示刷新核对并重新预览；提交前失败、IndexedDB 事务失败和服务端明确拒绝的原有语义保留。
- `src/storage/sqlite-client.js`：读取响应正文时保留中断/超时异常，避免丢失这类异常的身份信息。
- `tests/batch-cleanup.test.js`：补充原生数字错误码、超时、明确数据库失败与提交前中断的断言。
- `tests/sqlite-client.test.js`：使用适配器真实超时计时器和 AbortSignal，分别验证等待 fetch、读取正文时异常保留及控制器结果，fetch/正文端口为受控夹具。
- `tests/browser/batch-contract.js`：在真实插件已经成功提交后分别注入网络错误、fetch AbortError、正文 AbortError，读回实际数据库并验证旧计划拒绝。
- `README.md`、`CHANGELOG.md`、本报告及验收索引：更新状态与验证记录。

后端源码、vendor、协议 5、数据库 schema、公开版本号和原备份/删除事务算法均未修改。前后端仍分仓库，后端严格可选，不新增同步、多用户、自动迁移或错误回退。

## 实际执行与边界

| 命令 | 结果与范围 |
|---|---|
| `node --test tests/batch-cleanup.test.js tests/sqlite-client.test.js` | 修复后 **26/26**；含原生 AbortError code 20、TimeoutError code 23、提交前失败、明确服务端失败与响应正文超时 |
| `npm test` | **287/287**，0 失败、0 跳过；原有前端测试继续通过 |
| `.local-test/deploy-frontend.ps1` 后 `node .local-test/run-browser-batch.mjs` | 隔离 SillyTavern **1.19.0**、Edge **156.0.4314.42**、真实 IndexedDB/HTTP/SQLite，共 **15 组**通过，`pageErrors:[]`，最终活动端仍为 IndexedDB |

浏览器故障检查先取得真实服务器成功响应，再注入异常；数据库确实已删除允许清理的普通记录、保留受保护记录，控制器显示未知结果而非零删除，旧计划再次提交被真实事务拒绝。这里的网络/中断故障是确定位置的注入，不冒充真实物理断网；适配器超时测试另用实际计时器触发 AbortSignal。

仅向既有 `.local-test/` 隔离实例部署与写入虚构数据；启动脚本检测到实例仍运行后拒绝重复启动，随后复用该实例测试，没有另起测试进程或操作日常酒馆。原始结果留在本机 `review-20261027-unit.log`、`review-20261027-browser.log` 和 `p5-browser-result.json`，不随报告上传。

本次没有重跑后端独立套件、263MB 压力、1.15.0 兼容或全部原生恢复流程，因为后端和事务算法未改；相应历史结论仍见 P7 报告。本次结果不补齐 P7 未执行的真机、实际软键盘、Safari、外部模型生成或 GitHub 安装/更新验收。
