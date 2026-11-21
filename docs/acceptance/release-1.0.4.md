# 1.0.4 正式发布核对

日期：2026-11-21。前后端从 `codex/1.0.4-backup-version` 快进合并至各自 `main`，配套附注 Tag `v1.0.4` 与正式 GitHub Release。

## 发布内容

- 修复身份核对、无实际迁移、空写入和无删除核销误推进正文版本，导致 frozen 完整备份或最近楼层预览反复报 backup-version-changed。
- IndexedDB 与 SQLite 按成功的记录 mutation 更新对应类型版本，同事务去重，记录与版本原子提交/回滚；分批正式提交和清理采用相同规则。
- 各恢复动作只读取其实际依赖的类型，完整预览为 full + pending；保留真实正文变化拦截、冻结/事件保护、三轮重读、迁移 epoch 与条件副本证明。
- 修复代码与补测基线为前端 `a84fd73`、后端 `2ed4c4e`。发布整理更新正式说明、索引和包核对，并将服务器连接状态的版本同步至 1.0.4；其测试改为与 package.json 比较，避免两个常量同时漏改。
- 前端 manifest/package/设置版本/内置公告与后端 package/status 为 1.0.4；30 个共享模块逐字节一致。
- IndexedDB schema 8、SQLite schema 4、协议 6 不变；无需清库、重新迁移或覆盖 frozen 原件。服务器存储需前后端一并更新。

## 验证

发布前重跑前端 352/352，后端 Node 22.14.0 与 24.15.0 各 170/170，SQLite 安全专项 19/19；无跳过。重跑真实 Edge 桌面与 360px 触摸模拟，IndexedDB 各 27 项、浏览器 HTTP → worker → SQLite 各 32 项通过，包含两个实际保存确认按钮场景。版本、内置公告、语法、包与共享源码核对通过。

同一修复此前的验收还包括 3000 层 IndexedDB、10000 层提交期间关闭页面、配额回滚、快照/核对/清理/旧楼层恢复，及 3001 层 HTTP、超过 128 MiB 聊天、冻结 full 的 60 页身份核对交错读取、响应丢失与新旧组合。范围与入口见[修复验收](2026-11-21-backup-version-fix.md)。

安装 ZIP 从最终提交按运行文件清单生成，逐文件比较 Git 内容，检查路径、JS 语法、相对模块引用、版本及许可证，并提供 SHA256 校验。测试、需求、日志、数据库和本地运行时不进入安装 ZIP。

## 正式入口

- [前端 1.0.4](https://github.com/Yuyayun/boxed-lllllabc/releases/tag/v1.0.4)：`boxed-lllllabc-v1.0.4.zip`，目录 `boxed-lllllabc`，放入酒馆 `public/scripts/extensions/third-party`；Git 安装使用 main。
- [服务器插件 1.0.4](https://github.com/Yuyayun/boxed-lllllabc-server/releases/tag/v1.0.4)：`boxed-lllllabc-server-v1.0.4.zip`，目录 `boxed-lllllabc-server`，放入酒馆 `plugins`。
- 两端各附 `SHA256SUMS.txt`。GitHub 自动源码 ZIP/TAR 保留完整源码与测试。

## 边界

自动化均使用隔离数据，没有访问真实聊天或备份库。设备测试为桌面 Edge 与手机触摸模拟，尚未覆盖 Termux/Safari 实机与用户现场原库。浏览器 SQLite 的酒馆原生聊天读写、渲染和 saveChat 使用合成夹具；其 HTTP、路由、工作线程及 SQLite 为真实实现。

不要求使用者额外跑测试清单或反复恢复原档，后续正常使用如有异常再针对性排查。发布不启动酒馆、不自动切换存储位置或迁移数据。许可证保持 CC BY-NC-SA 4.0，此前版本适用各自发布时附带的许可证。
