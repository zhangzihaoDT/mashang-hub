# Knbase 切换前报告与生产验收记录

日期：2026-11-06（北京时间）。生产切换尚未授权。

## P0：生产基线

| 检查 | 只读结果 |
| --- | --- |
| 服务树 | Worker LaunchAgent PID 65423。旧管理记录：npm/进程组 38642 → supervisor 38669 → HTTP 写入进程 2444 → 扫描子进程 2455。4317 仅绑定 127.0.0.1；写锁 PID 与监听者一致。没有观察到 Knbase 独立 LaunchAgent。 |
| 健康 | /api/health 返回 ok、无退化原因；最近扫描 13:52:44；采样时没有正在进行的 Library 操作。响应中有一个待处理请求；单次采样不作为 P3 的写入静默证据。 |
| 生效配置 | HTTP 进程 cwd 为 mashang-knbase，PORT=4317，KNBASE_RECOVER_STALE_LOCK=1；未见 Knbase 根、Fetch 目录、Content 数据覆盖，代码使用同级默认路径。Worker plist 未声明 MYKNBASE 或 runtime/workspace 文件覆盖。 |
| 路径 | `~/Documents/github/mashang-knbase/{library,.knbase}`；Content 已配置 `mashang-knbase/library/notes` 和 `~/Documents/github/content/data`；Fetch 导入目录 `~/Documents/github/mashang-fetch/library` 存在。 |
| 资料 | 库 ID `1f605402-a8d5-4af1-badf-99dd4d2a3856`；487 张 Card / 唯一资产 ID：191 present、257 missing、39 trashed；无外库 ID。28 条加工记录、2 条附件引用，附件引用均有对应 Card。资产 ID 排序后以换行连接的 SHA-256：`9f6dcf42f27921f84de470b2b50a7f5e85bee35d9a5f1d53c6b986e7a90e102a`。这是在线观测；一致性备份及文件摘要在 P3 排空写入后重取。 |
| 历史 | 本机 Hub SQLite 按任务记录 workspaceId 查询，未发现 myknbase 任务。远程 Hub 历史未核实；保留 workspace ID、根映射和产物策略，runtime 与 workspace 相互独立。 |
| 工作树 | Hub HEAD `acf67c9`，已有 Worker runtime/探针、artifact 策略/解析、workspace 及相应测试修改。Knbase HEAD `4b09885`，已有扫描、服务健康和恢复、导入、来源/附件、文档及测试修改。均保留。 |
| Content 参照 | 两份指定文档已读。沿用用户级 LaunchAgent、本机配置与日志、Chrome 安装和桌面替身；Knbase 保留内部重启预算，LaunchAgent 不使用无条件 KeepAlive。 |

## P1 / P2 与交接顺序

- P1 在 Knbase 仓库：安装/启用分离、稳定应用名、独立窗口配置、库身份和单写者检查、现有 supervisor、集成契约。
- P2 补丁包含 Hub 前端清理、Worker 默认 runtime 移除及旧 ID override 拒绝；通用 workspace 映射仍保留。当前 checkout 仍提供旧的停服入口；务必先停旧实例再应用 P2 补丁。切换时先应用 Worker 部分并验证，再部署远程 Hub 前端。
- 独立服务的启动预检遇到写锁或 gate 会闭锁。需要确认其持有者、旧实例已退出及端口已释放；只对确认失效的锁使用 Knbase 已有恢复命令。

## P3 验收模板（待授权后填写）

- 授权人、时间、执行窗口：
- Knbase / Worker / Hub 源码版本及旧管理配置备份：
- 写入排空证据（Knbase、Content Notes 与其他写者）：
- 停旧服务、子进程退出、4317 释放证据：
- 一致性备份路径、文件摘要清单、恢复抽查：
- Worker 撤权（快照及 CLI 均无 myknbase runtime；历史 workspace 可用）：
- 独立 LaunchAgent 状态、监听者、唯一写锁、健康状态：
- 切换前后库 ID、资产身份、文件摘要、加工及附件关系对比：
- Content 新笔记与配图索引、Fetch / Finder 验证：
- Chrome 独立窗口、桌面替身、Dock；登录启动实测结果：
- 远程 Hub 发布版本及其他板块回归：
- 异常、回滚步骤及实际结果：

授权范围须覆盖：暂停共享写入、停旧实例、备份、更新并重载 Worker、启用独立 LaunchAgent、安装 Chrome 应用，以及发布 Hub 清理。失败时停止后续切换，按迁出方案恢复旧管理入口；保留切换后写入。

## 准备阶段验收结果

- Knbase：`KNBASE_TEST_LAUNCHD=1 npm test`，92/92 通过。实际测试 LaunchAgent 只使用随机标签、临时配置和资料库、独立端口。覆盖安装、启用、状态、日志、重启、停用、卸载、端口和写锁冲突、子进程崩溃后恢复、manifest MIME 和独立窗口声明。
- Hub：DOM、完整 runtime、workspace 注册、任务桥接、artifact resolver、Chrome 工作台浏览器回归通过。浏览器使用临时 checkout 和端口。生产 checkout 保留旧启动入口；`git apply --check docs/migrations/knbase-p2.patch` 通过。
- P1 依赖 Knbase 工作树中已存在的 supervisor 和 `/api/health` 改动。切换制品需要包含这份已验证基线，不能单独从 P1 提交构建生产版本。正式 Chrome 安装、注销后自动加载、远程历史确认及生产协作验证留待 P3。
