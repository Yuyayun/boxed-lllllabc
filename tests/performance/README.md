# 迁移读取量与日志开销对照

`remediation-profile.mjs` 使用真实 SQLite 文件与实际迁移调度器，模拟两个适配器方向，统计每个动作的 SQL 正文返回量、调用次数、耗时和日志显式刷盘次数。它不替代真实 IndexedDB/宿主/手机测试；完整宿主入口仍为 `../browser/run-large-migration-contract.mjs`。

只使用已经关闭的合成测试数据库。将主库和仍存在的 WAL/SHM 一起复制到专用夹具目录，额外放入 `profile-fixture.json`：

```json
{"purpose":"boxed-synthetic-profile","records":4551}
```

环境变量：

- `BOXED_PROFILE_FIXTURE`：上述夹具目录，数据库名 `boxed-lllllabc.sqlite`。
- `BOXED_PROFILE_OUTPUT`：独立输出目录，不能放在来源夹具目录内部。
- `BOXED_SERVER_REPOSITORY`：配套后端源码目录。
- `BOXED_FRONT_REPOSITORY`：可选，默认当前前端；对照旧版本时指定旧版本源码。

分别在相同 Node 版本下执行，先后使用相同规模、同一关闭的来源夹具，标签不会改变被测代码：

```sh
node tests/performance/remediation-profile.mjs before
node tests/performance/remediation-profile.mjs after
```

每次都创建新的输出文件夹并保留证据，不写入原夹具。结果记录 Node 版本、数据等价、来源保留、逐动作计数及日志量。累计正文载荷是 SQL 实际返回的逻辑量，包含分批预读及事务检查点重读，不是物理磁盘写入量或寿命测量。需要严谨比较耗时时，避免同时运行其他大数据测试；否则应明确注明调度、缓存和并行负载的影响。
