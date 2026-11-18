# 1.0.2 正式发布核对

日期：2026-11-18。前后端分别从最新 main 发布 `v1.0.2`，保留完整提交历史，不提高数据库或协议版本。

## 发布范围

- 前端功能基线为 `a22e994`，包含超大聊天分批处理、来源核对与原子完整替换，以及后续手动核对、失败状态传播、手机设置页、日志本地时间和清理摘要修复。
- 后端功能基线为 `c092156`，支持分批备份、权威目录摘要、暂存提交及回执核对，保留旧接口。
- 本次发布整理只更新 README、更新日志日期和验收索引及记录，不修改运行时代码。前端 manifest、package、设置显示与后端 package、status 均为 1.0.2。
- IndexedDB 版本 8、SQLite 版本 4、存储协议 6 保持不变，无需重新建库。既有快照格式保持兼容。
- 后端引用的 28 个前端模块中，27 个逐字节一致。唯一保留差异为 `runtime-log-format.js`：前端按设备本地时区展示日志，服务器保留原来的 UTC 控制台输出；传输及存储时间戳不变。事务、协议和保护模块一致。

## 本次重跑验证

- 前端自动化测试 338/338 通过。
- 后端 Node 22.14.0、Node 24.15.0 下各 146/146 通过；使用串行测试运行器，未跳过用例。
- 桌面和 360px 手机／触摸模拟视口各执行一轮真实 Edge IndexedDB 契约：3000 层写入读取、混合编辑与新增、配额失败回滚、10000 层最终事务中断、12 项快照交互、7 项手动核对和 7 项清理入口检查通过。
- 清理回归使用真实目录大小与非连续楼层范围，两个入口的 summary、cleanup plans 和展示一致；打开面板不读 catalog，确认时仍拒绝 stale 计划。
- 运行时代码语法检查及 npm 打包清单检查通过。安装包保留运行源码和许可证，排除需求原文、本地 PRODUCT.md、数据库、运行时、日志和浏览器资料。

## 包与正式入口

- [前端 Release](https://github.com/Yuyayun/boxed-lllllabc/releases/tag/v1.0.2)：`boxed-lllllabc-v1.0.2.zip`，解压后将 `boxed-lllllabc` 放入酒馆的 `public/scripts/extensions/third-party`。
- [服务器插件 Release](https://github.com/Yuyayun/boxed-lllllabc-server/releases/tag/v1.0.2)：`boxed-lllllabc-server-v1.0.2.zip`，解压后将 `boxed-lllllabc-server` 放入酒馆的 `plugins`。
- 每个 Release 附 SHA256 校验文件，并保留 GitHub 自动生成的完整仓库源码 ZIP/TAR。

## 验收边界

- 超过 200k 节点、约 129 MiB 真实 HTTP、旧版组合与重启验收沿用[超大聊天链路记录](2026-11-17-large-chat-backups.md)，本次未重复全部压力测试。
- 手机设置页布局及触摸滚动的历史复验使用 Windows Edge 设备模拟；不能替代 Android/Termux、iOS/Safari、真实软键盘或使用者手机 IndexedDB 的实机验收。
- 不访问或修改使用者实际聊天数据库，不自动切换存储位置，也不自动迁移数据。服务器插件继续可选。
