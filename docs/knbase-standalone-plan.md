# Knbase 独立应用迁出方案

日期：2026-11-06。状态：策划完成，尚未实施或切换生产。

## 目标与交付形态

沿用 Content 已落地的形态：本机 Web 服务 + 用户级 LaunchAgent + Chrome 安装的独立应用窗口，桌面 / Dock 使用 **Knbase** 名称。继续使用 `mashang-knbase` 仓库和 `http://127.0.0.1:4317`，不新建重复业务仓库。

完成后，Knbase 的打开、启动、停止、状态查询、日志和恢复均由自身提供；Hub、Mac Worker 和 OpenCode 不在线时，资料浏览、检索、导入、关联和文件管理仍可使用。已有 AI 编辑 Skill 继续由外部 Agent 使用，网页 AI 加工不属于本次迁出的验收范围。

本次保持现有业务界面与资料结构；应用名称、图标、安装元数据和必要的服务状态说明随独立入口补齐。云部署、跨设备访问、原生客户端重写、模型后台和新知识生产功能留作后续议题。

## 已核实的现状

| 部分 | 当前实现 | 本次处理 |
| --- | --- | --- |
| Knbase 业务 | 自有 HTTP API、网页、搜索、文件导入、来源 / 附件关系、废纸篓和扫描 | 在原仓库延续 |
| 服务 | `server/main.mjs` 启动 supervisor，服务进程持有资料库写锁，扫描子进程只读 | 保留并接入独立生命周期 |
| 健康 | `/api/health` 检查索引、扫描、文件系统和操作状态 | 作为独立状态与验收依据 |
| Hub 前端 | `public/index.html` 的 Knbase 导航，`app.js` 的工作台映射，`runtime-ui.js` 的专用分组 | 切换后删除 Knbase 专用入口和映射 |
| Worker runtime | `myknbase` 默认注册、探针、`npm start`、进程匹配及停止能力 | 转移管理权后撤下默认注册 |
| Worker workspace | `myknbase` 映射到仓库，声明 `processed` 产物根 | 撤下默认注册；历史标识保留，必要的 Agent 接入改为显式本地配置 |
| 资料 | `library/` 保存文件，`.knbase/` 保存身份、Cards、关系及运行状态 | 原地接续，完整备份，不重新分配资产身份 |
| Content 协作 | Content 向 `library/notes` 写入；Knbase 配套删除使用 Content 的写锁 | 保留路径和写锁协议 |
| Fetch 协作 | 从 Fetch 本地资料目录选择并移入文件 | 保留目录配置，无需 Fetch 或 Hub 服务在线 |

Content 参照依据为其仓库的 `docs/web-app.md` 和 `docs/production-acceptance-2026-11-06.md`。后者记录独立服务、Chrome 应用和原资料接续已验收。本方案对运行状态的描述以源码和这些记录为依据，尚未现场复核生产进程、配置和安装状态。

Hub 工作区已有 runtime、workspace、artifact 等未提交修改；Knbase 也有稳定性、导入、来源关联等未提交修改。实施前记录基线并按归属保留，不能通过重置或覆盖完成迁出。尤其保留当前 `/api/health` 探针及已有健康恢复改进。

## 责任边界

```text
桌面 / Dock 的 Knbase
          ↓
本机 Knbase Web → Knbase API / Library → library/ + .knbase/
          ↑
Knbase LaunchAgent → 现有 supervisor → 服务 / 扫描子进程

Content → library/notes（沿用保存与配套删除的共享锁协议）
Fetch 资料目录 → Knbase 导入（沿用移动与失败恢复语义）
外部 Agent → Knbase 自带编辑 Skill（现有能力）
```

Hub 不增加 Knbase 代理、文件访问、业务 API 或数据迁移逻辑。Worker 通用 Task / Artifact / workspace 协议继续可用，但不作为独立 Knbase 的运行前提。

## 实施工作包

### P0：建立切换基线

1. 核对实际进程树、4317 监听者、Worker 管理记录、有效环境变量和配置覆盖。只记录相关配置，避免导出无关凭据。
2. 确认实际 Knbase 根目录、Content Notes 目录、Content 数据目录、Fetch 导入目录；不能只依据默认值。
3. 记录库 ID、资产 ID / 可用性、关系与附件引用、未完成文件操作及身份待确认项。文件数和可读资料数分别记录，不直接互相比较。
4. 保存当前代码差异、旧启动配置和恢复所需的 Worker 状态。准备一致性备份清单：`library/`、`.knbase/`，以及共享 Notes 对应的 Content 业务状态。最终备份在 P3 写入暂停后完成。

交付：脱敏基线、备份与切换脚本设计、可恢复的旧入口配置。

### P1：在 Knbase 仓库补齐独立运行

- 添加应用 manifest、安装图标与路由 / MIME 支持，统一应用名、窗口名和书签名为 Knbase。沿用已有图标资源；以实际 Chrome 安装和独立窗口验证交付。
- 添加 macOS 管理脚本，提供 `install`、`start`、`stop`、`restart`、`status`、`logs`、`uninstall`。安装与启用分开，允许先准备文件、后交接生产进程。卸载仅移除启动配置，保留资料和用户配置。
- 建议 LaunchAgent 名为 `local.knbase.web`；配置置于 `~/Library/Application Support/Knbase/knbase.env`，日志置于 `~/Library/Logs/Knbase/`。使用绝对 Node 路径和明确工作目录，显式设置 `KNBASE_ROOT`、`PORT`、`KNBASE_CONTENT_DATA_DIR`、`KNBASE_IMPORT_DIR`。
- 启动前检查配置、端口占用、资料库身份与锁；识别已有实例时明确报告，不能因健康检查失败另起写入进程。只恢复已证实失效的 Knbase 写锁，不移除 Content 写锁，不修复损坏 Cards。
- 日志记录启动、扫描、恢复、停止与失败原因，提供大小或保留期限制；状态区分服务离线、索引不健康和等待人工恢复。
- 保留仅绑定 `127.0.0.1`、Host / Origin 校验、写 token、文件路径与内容身份校验。现有写 token 不是独立用户登录；本轮维持本机使用范围。

**后台恢复的具体决策：** 首版使用 LaunchAgent `RunAtLoad`，不照抄 Content 的无条件 `KeepAlive=true`。运行中的服务故障由 Knbase 现有 supervisor 接管；启动校验失败或触发重启上限时保持失败状态，允许用户修复后显式 restart。这样不会由外层无限重启刷新现有“五分钟最多三次”的恢复预算。若后续需要 supervisor 自身崩溃后也自动恢复，应先实现跨进程持久化的重启预算与失败闭锁，再启用外层守护。

交付：可安装的独立应用、生命周期脚本、使用和排障文档；此阶段使用临时资料库及独立端口验证。

### P2：准备 Hub / Worker 退出管理

1. 准备删除 Hub 的 Knbase 导航、工作台文案和专属分组，保留 Fetch / MIIT 等共享组件及其行为。
2. 准备撤下 Worker 默认 `myknbase` runtime，包括进程匹配和控制能力。**只隐藏按钮不够**：当前 Worker 可按进程特征停止非自身启动的服务。
3. 当前 registry 配置按 ID 合并默认项，空 `services` 不能移除默认服务，清空 `control` 也不能可靠清除继承命令。实施采用撤下默认注册，并核对旧本地 override 是否重新加入该项；不能假设已有禁用开关有效。
4. 撤下默认 `myknbase` workspace 前核对在途任务与历史产物访问。历史任务 / 会话不删除、不改写 ID；按需通过通用本地 workspace 配置保留历史产物解析所需的映射。若实际存在历史产物访问依赖，完成兼容验证后再撤映射。
5. 更新 README、runtime / workspace / browser 测试。通用协议测试中的不透明 ID 不必机械改名；应验证未注册工作区拒绝新任务、历史记录仍可读。

交付：Hub 清理变更与 Worker 切换包。准备完成不代表此时就撤掉旧生产入口。

### P3：生产交接

1. 完成隔离验收；确认无待完成导入、删除或写入。短暂停止 Content 的 Notes 保存 / 同步及其他外部资料写入，排空在途操作。
2. 用旧管理方式停止现有 Knbase，确认 supervisor、服务、扫描子进程均退出，4317 释放。制作并核验 P0 清单的一致性备份，保存文件摘要和关系基线。
3. 应用 Worker 撤管理配置 / 代码，确认新注册快照已不提供 Knbase 控制入口；检查旧 override 和待审批控制，防止重新接管。
4. 启用独立 LaunchAgent，指向同一原资料库，检查库 ID、写锁持有者、端口及健康状态。不能同时以旧 Worker 和新 LaunchAgent 托管。
5. 核验资料和关系后恢复 Content 写入，验证新笔记自动出现且配图正常。破坏性和并发故障测试仅使用明确的测试资料。
6. 安装 Chrome Knbase 应用，建立桌面入口并固定 Dock；检查独立窗口、文件选择器、Finder 定位和废纸篓工具在 LaunchAgent 环境下可用。
7. 发布 Hub 前端清理，确认正式 Hub 不再出现 Knbase 板块。若远程 Hub 部署暂未完成，记录为“本机已迁出、Hub 清理待发布”，不宣称整体完成。

交付：生产验收记录、备份位置、实际配置、版本 / revision 和已知限制。

## 验收矩阵

| 验收项 | 通过条件 |
| --- | --- |
| 独立性 | 浏览器不请求 Hub API；隔离环境中 Hub / Worker / OpenCode 均不可用时，核心业务正常；生产核对进程由独立 LaunchAgent 托管 |
| 应用入口 | 桌面 / Dock 打开 Knbase 独立窗口；关闭窗口后后台仍可正常服务，再打开正常 |
| 生命周期 | 启停、重启、状态、日志、注销后登录启动均有证据；未实际注销验证时明确标记未验证 |
| 单写者与恢复 | 活跃写锁、端口占用拒绝重复启动；失效锁受控恢复；损坏 Cards 不自动修补；重启上限不会被外层绕过 |
| 资料连续性 | 切换前后文件摘要、库 / 资产身份、来源 / 附件关系一致；扫描时间等预期状态变化单独解释 |
| 日常操作 | 搜索筛选、Markdown 配图、PDF、音视频、Finder 定位、普通上传、Fetch 移入、改名和废纸篓恢复通过 |
| Content 共存 | Content 新存 Notes 可被索引；MD / JSON 配套删除、恢复、重复保存防重建及共享锁冲突行为通过；不新增真实外部发送 |
| 故障语义 | 索引停滞可见；请求超时不重放写入；后台失败给出原因及恢复方法 |
| Hub 清理 | Knbase 专属 UI 消失，Worker 不再控制独立服务；其他板块、任务和产物行为无回归 |

运行 Knbase 完整测试及新增生命周期测试；Hub 运行受影响的 runtime、workspace、DOM、浏览器与历史产物检查。生产测试不停止其他业务来证明独立性，停用依赖的故障注入在隔离环境完成。

## 回滚

先暂停共享资料写入并停止 / 卸载新 LaunchAgent 的运行实例，确认全部子进程退出且端口释放；再恢复旧 Worker 注册和必要的 Hub 入口，由旧管理方式启动同一资料库。确认健康和身份后恢复 Content。

正常回滚只切换管理入口，保留切换后新增文件、关系和 Content 收据。不能把迁出前备份整库覆盖到现有资料；备份只用于经核对的选择性恢复。新旧入口在任何时刻都不能同时拥有管理权。

## 完成定义

用户可直接打开 Knbase 并完成现有知识库工作；后台由 Knbase 自己维护；原资料与 Content / Fetch 协作延续；Hub 的生产入口及 Worker 控制权都已撤下；备份、回滚和实际验收证据齐备。新增 AI 能力另开工作范围。
