# Publish Workspace 快照 Operation 验收

日期：2026-10-10。只修改 mashang-hub，保留已有 Workspace 改动；未修改 mashang-publish。初始 Mock 阶段未部署或调用真实微博 API；随后按用户授权启用当前账号直连，并由用户在 Publish 页面完成一次真实发布。真实验收基线见下文。未提交或推送。

审计与方案见 [publish-operation-audit.md](publish-operation-audit.md)。基线实际为 0.3.2 工作树，而非提示中的 0.3.1。

## 复用与状态

沿用 Publish 对话、Session、Task Store、Runtime Control、Worker ExecutionJournal。正式路线在 Worker 注册 `text-publication`，要求快照，不接受原无参数 Run 入口。业务适配器位于 Worker 侧，Hub 不知道 CLI 路径、数据结构、微博凭据。

用户在 Publish 输入框起草或修改，通过原发送按钮请求模型审阅；最终正文放回输入框，点“预览发布”。Worker 原样保存正文、visibility、statement（默认 public/original），生成不可变引用及 SHA-256 摘要。预览保持空格、换行与 HTML 字面值。确认按钮明确显示“我已审阅最终正文，确认发布”。刷新后按需从 Worker 读取快照，然后才显示审批入口。预览无需可用模型。

Task Store schema v2：`DRAFT → PENDING_APPROVAL → APPROVED → DISPATCHED → RUNNING → COMPLETED / FAILED / UNKNOWN`。DISPATCHED 是既有协议的持久化分发步骤。审批记录和 APPROVED 事务持久化；断线、重启与超时保守进入 UNKNOWN。正文修改先撤销待审批快照，新版本不继承批准；已分发快照不修改。审批永远绑定被预览的版本，不是输入框后续新文字。

Hub Ed25519 签名绑定 taskId、operationId、targetId、snapshotRef、摘要、动作版本及 120 秒有效期。私钥不传 Worker。服务验证签名和完整快照（包含公开范围/声明）；伪造、过期或修改被拒绝。旧实验开关与正式服务模式互斥，正式模式保留普通 Agent 工具。

服务在外部调用前 fsync 不可覆盖 claim。同一 operationId 重放只能回读结果或核验，不能重复调用 publisher。复用 mashang-publish 的 publisher、Storage 数据锁、官方 WeiboClient 与原归档目录；Storage 写操作钩子在调用官方 API 之前保存 Hub operationId 与 publisher operation_id 的对应关系，不修改业务日志格式。

核验读取已关联的发布日志及官方 API 原始响应。已保存 PUBLISHED 或有效成功响应可以确认链接；明确 FAILED 作为失败；缺失证据保持 UNKNOWN。没有自动 timeline 读取，不消耗真实读取 Credit，也不会根据查不到结果认定失败。响应彻底丢失且本地无成功证据时需用户人工核对微博。取消不能撤销外部副作用，已分发发布不提供“取消后重发”。

## Mock 验收

`npm test` 已通过全套既有回归及新增 `test:publication-operation`。新增测试包括：

- 无审批、伪造签名、过期批准、正文篡改不执行。
- 最终正文摘要匹配；改稿使旧审批失效，错误摘要被拒绝。
- 并发确认只成功分发一次；执行服务重放与重启只返回证据。
- Hub 真实进程重启保持终态与 operationId，重复确认不发布。
- Hub → 真实 Worker → Mock 隔离服务完整流程；丢弃 HTTP 响应后进入 UNKNOWN，只读核验恢复链接。
- Worker SIGKILL，外部服务完成后重启 Worker，对账恢复 COMPLETED；发布调用次数没有增加。
- Mock publisher 产生原始成功响应后模拟归档异常，通过关联记录核验成功。
- Hub Task Store 不持久化业务正文，损坏执行记录拒绝恢复执行。

并发运行多组浏览器与全量测试时，旧 publishing-bridge 的短等待曾出现一次超时；随后单独完整重跑通过。

Chrome/Playwright 专项已验证原文预览、不执行 HTML、明确确认、真实 DOM 中的链接、刷新恢复与输入修改撤销按钮。所有链接和账号均为虚构 Mock，未真实发布。

浏览器专项复现：设置 `PUBLICATION_BROWSER=1`，按本机安装位置设置 `PLAYWRIGHT_MODULE`、`CHROME_BIN`，运行 `npm run test:publication-operation`。不加浏览器开关也会执行完整后端 Mock。

## 隔离服务配置与部署方案（未执行；本次验收采用 Worker 直连）

Hub：登录门禁 `HUB_ACCESS_TOKEN`；`HUB_APPROVAL_PRIVATE_KEY` 为 Ed25519 PKCS8 PEM；`HUB_TASK_DB` 位于持久卷。升级前备份数据库，v2 数据库不能被旧 Hub 直接打开。

Worker：

```sh
MASHANG_PUBLISH_ENABLED=0
MASHANG_PUBLISH_SERVICE_URL=http://127.0.0.1:4381
MASHANG_PUBLISH_SNAPSHOT_DIR=/absolute/worker-private/publication-snapshots
```

launchd 生成器仅透传两个新增 Worker 变量，不安装或重启任何服务。

发布服务在隔离 OS 身份下运行，环境配置：

```sh
PUBLISH_SERVICE_STATE=/absolute/publishing-private/operation-ledger
PUBLISH_SERVICE_ROOT=/absolute/protected/mashang-publish
PUBLISH_SERVICE_DATA=/absolute/publishing-private/existing-data
PUBLISH_SERVICE_PUBLIC_KEY_FILE=/absolute/protected/hub-public.pem
PUBLISH_SERVICE_PORT=4381
node /absolute/protected/mashang-hub/worker/publishing/service.mjs
```

上述路径是配置占位符，未创建账号或目录。服务只监听回环，仍自行验证签名。部署服务代码及其依赖、公钥到 Agent 不可写的位置；凭据交给隔离身份的官方 CLI Keychain 管理，不通过环境变量或 Hub 转发 Token。必须处理原桌面身份可读的旧凭据，不能仅新建另一个发布身份。Hub 私钥、登录凭据同样不能被 Agent 读取。

正式验收仍缺：发布/Worker/Agent 身份及目录权限证据，隔离身份下官方 CLI 授权可用性、受保护服务安装与 Hub 公钥部署。按照 [publishing-isolation.md](publishing-isolation.md) 验证 OS 禁止 Agent 读发布 HOME/Keychain/ledger、写服务代码或切换身份。代码不能自行证明部署隔离。

## 真实验证范围

Mock 完成后，用户明确批准当前账号直连，并自行在 Publish 页面预览、审批和发布。本次真实验收覆盖这一部署方式；额外 OS 身份隔离仍未实施，不作为本次已通过的验收项。

## Worker 直连现有 mashang-publish

按用户“直接接 mashang-publish 的能力”增加 `MASHANG_PUBLISH_DIRECT=1`。不启动发布 HTTP 服务；Worker 在进程内复用相同审批验证/claim gate 和现有 publisher、Storage、WeiboClient，使用原 data 目录。Hub 仍只持久化通用审批与引用。直接模式与 HTTP 服务模式、旧 deny-all 实验互斥。

配置 `MASHANG_PUBLISH_ROOT`、可选 `MASHANG_PUBLISH_DATA_DIR`、`MASHANG_PUBLISH_PUBLIC_KEY_FILE`、持久化 `MASHANG_PUBLISH_LEDGER_DIR` 与 `MASHANG_PUBLISH_SNAPSHOT_DIR`；Hub 仍需登录门禁和签名私钥。发布正文、可见范围与声明经预览后明确确认；修改范围或声明也失效审批。

此模式沿用当前用户的官方 CLI 登录，没有额外 OS 账号隔离，不宣称同账号 Agent 无法接触凭据。直连 Mock 已验证审批前零调用、原样正文/范围/声明、重复确认一次执行以及 Hub/Worker 重启不重发。

本地启用最初被自动审批审核拒绝；用户随后明确回答“批准按当前账号直连接入”，接受不额外隔离当前官方 CLI 登录环境。按该授权已启动本地 Hub 和 local-publish-worker，注册 text-publication 快照 Operation，复用现有 mashang-publish/data。签名与登录配置、Worker journal、快照及 claim 配置位于被 Git 忽略的 .local/direct-publish/，敏感配置文件 0600、目录 0700；未打印密钥或读取微博 OAuth 凭据。启用时已在真实本地页面确认预览按钮可用；后续真实正文与最终发布由用户自己在页面确认，结果见下文。


## 已固化的真实发布验收基线

验收日期：2026-10-10；以下时间统一使用 Asia/Shanghai（UTC+08:00）。用户在本地 Publish Workspace 自行点击最终发布确认，并在本对话反馈“发布成功！”。记录通过只读核对 Hub Task Store、审批表、状态事件、Worker 持久化 claim/result/业务关联记录及现有 mashang-publish 发布日志整理；未再次调用发布接口。

### 任务与结果

| 项目 | 实际值 |
| --- | --- |
| 发布任务 ID（Runtime Control；不是 LLM 起草任务） | `control_3d371288-06cf-4e13-90a4-fdad40c76946` |
| 对话 ID | `hub_2817b1f1-05d7-4a73-b7a9-3db82dc8c0a4` |
| Worker | `local-publish-worker` |
| Worker Operation | `text-publication` |
| 持久化幂等标识 | `operation_087b8cbe-fc23-42be-82a6-021a82d01d4e` |
| 快照引用 | `d938dc4a-d48b-4818-88d4-7c1a7ab49eb0` |
| 已审批快照 SHA-256（正文、范围、声明） | `84724bdbe257e867672e96d86e678ba62899885b30059dd2f027df09c914741b` |
| 发布范围 / 内容声明 | `public` / `original` |
| 执行次数（Hub attempt） | `1` |
| Attempt ID | `attempt_75b0cd49-2129-4383-b9db-53f3a275c287` |
| Dispatch ID | `dispatch_deeb43cf-063c-4346-9cff-93236f76cb42` |
| 现有发布器 operation_id | `a4bb82b2-69d3-4f73-b440-44b1680f7d97` |
| 微博 ID | `5352474333678475` |
| 实际微博链接 | [查看已发布微博](https://weibo.com/detail/5352474333678475) |
| Hub 最终执行结果 | `COMPLETED`，reason=`OK` |
| Worker 持久化结果 | `COMPLETED`，resultUrl 与上述链接一致 |
| mashang-publish 归档结果 | `PUBLISHED`，idstr 与上述微博 ID 一致 |

### 审批与执行时间线

| 时间（UTC+08:00） | 持久化证据 |
| --- | --- |
| 2026-10-10 14:13:06.254 | Task Store 保存 `DRAFT` 与 `PENDING_APPROVAL`，绑定上述快照与摘要 |
| 2026-10-10 14:13:08.186 | approvals 表：decision=`APPROVED`，actor=`user`；同事务保存 `APPROVED` 状态 |
| 2026-10-10 14:13:08.187 | `DISPATCHED`；startedAt 与该时间一致，attempt=`1` |
| 2026-10-10 14:13:08.974 | 现有发布器日志 completed_at=`2026-10-10T06:13:08.974Z`，结果 `PUBLISHED` |
| 2026-10-10 14:13:08.995 | Hub 保存 `COMPLETED` / `OK`、finishedAt 及实际链接 |

本次数据库实际事件序列为 `DRAFT → PENDING_APPROVAL → APPROVED → DISPATCHED → COMPLETED`；没有单独持久化 `RUNNING` 事件。此记录证明快照审批先于分发、真实发布成功证据和链接一致；重复点击、重启和断线恢复仍以此前 Mock 回归为证据，不宣称本次真实发布逐项执行了这些故障测试。

可追溯证据位于本机持久化 Task Store 的 `tasks`、`approvals`、`task_events` 表，以及按上述 operationId 关联的 Worker claim/result/business 文件和 `logs/publish-a4bb82b2-69d3-4f73-b440-44b1680f7d97.json`。文档仅摘录必要的 ID、摘要、时间、状态与链接，不复制完整配置、签名证明或 API 原始响应；不记录 Cookie、Token、密钥、认证头或官方 CLI 登录信息。


## Git 同步前检查

2026-10-10：当前已提交 HEAD、package.json 与 package-lock.json 均为 `0.3.2`，该版本已用于四个 Workspace 的统一入口；不符合“基线仍为 0.3.1”的升版前提，因此本次保留 `0.3.2`，不新增版本标签。同步前完整 `npm test` 通过，包含新增的直连起草（禁用隐藏交互提问）和发布审批 Mock 回归。`git diff --check` 通过；对全部待提交文件核对本地敏感配置值，未发现 Token、Worker secret 或签名私钥泄漏。真实发布仍以本页已固化的单次发布证据为基线，未为 Git 同步再次执行发布。
