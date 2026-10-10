# Sealos b6ccec3 部署验收

日期：2026-10-10；时间使用 Asia/Shanghai（UTC+08:00）。

## 镜像与部署基线

- 源码提交：`b6ccec31e522651eaf5e3bcaa23c24422940b5f7`，构建时工作区干净；源码版本保留 `0.3.2`。
- 镜像：`docker.io/byte1717712/mashang-hub:0.3.2-b6ccec3`。
- 平台：`linux/amd64`。
- 仓库 manifest digest：`sha256:f07f0754d751b850c8c68a1220aa028a2ac343b86eeec7a2d8e590eacf1108e4`。
- OCI revision/version 标签分别等于上述源码提交与 `0.3.2`。
- 镜像在本机启动成功，SQLite schema=`2`、integrity=`ok`；不含 `.local`、Worker、业务应用、`.env` 或微博凭据。
- 用户明确批准上传该镜像到上述既有 Docker Hub 仓库，再用于 Sealos 部署。
- Sealos Beijing：namespace=`ns-m8unek1g`，StatefulSet=`mashang-hub`，Pod=`mashang-hub-0`。
- [正式 Hub](https://uzwshousyofn.sealosbja.site/) 沿用 HTTPS 域名、3000 端口、单实例、200m CPU / 256Mi 内存、1Gi `/data` 持久卷；镜像从 `latest` 切换为上述唯一提交标签，没有覆盖 `latest`。
- Sealos Pod 事件确认镜像拉取成功、容器启动成功；验收末状态 `running`，重启计数 `0`。

## 受控配置

用户另行明确批准“启用云端 Publish”：Sealos Hub 保存专用 Ed25519 审批私钥，现有 Mac Worker 保存对应公钥和持久化 snapshot/ledger；保留已有 Hub 登录门禁及 Worker secret，复用当前账号的官方 CLI 登录。没有新增 OS 身份隔离。

Hub 仍只保存通用任务、审批和引用；mashang-publish、其 data 与认证凭据留在 Mac，未上传到镜像或 Sealos。Worker 采用直连模式，旧实验模式关闭。仅重新加载 Worker LaunchAgent；OpenCode（PID 753）和其他业务服务保持运行。原 Worker plist 已私下备份，专用配置和验收截图位于 Git 忽略的 `.local/sealos-b6ccec3/`；密钥、临时登录文件与 plist 备份权限为 0600，目录为 0700。

## 实际验收

| 检查 | 结果与证据 |
| --- | --- |
| 登录门禁 | 未登录访问 `/api/health` 返回 401；使用原登录凭据后可正常验收 |
| 线上来源 | `/app.js` 和首页字节 SHA-256 与 b6ccec3 源码一致；Pod 内 server.mjs SHA-256=`f2c5c2fb6fc420462598ae8dc83b47d6a188032741efb6c4ce99a2551025a156`，与构建源码一致 |
| 数据库 | Pod 内 `/data/tasks.sqlite` schema=`2`、integrity=`ok`；重启前包含 4 条验收记录 |
| 签名配置 | Pod 内专用私钥可解析为 `ed25519`；未输出私钥值 |
| Worker | `/api/health`：connected=`true`，worker=`local-worker`，status=`ONLINE`；Runtime 注册 `text-publication`，enabled=`true`，requiresSnapshot=`true` |
| Workspace UI | Service / Fetch / Knbase / Publish 入口正常；对话按钮为“发送”，Publish 预览可用 |
| 起草 | 线上 LLM 返回 `HUB_DEPLOY_B6CCEC3_OK`，任务 `COMPLETED`，没有隐藏提问等待 |
| 预览与刷新 | 仅预览验收文本，产生 `PENDING_APPROVAL` 和绑定摘要；刷新后从 Worker 恢复同一最终正文及审批入口 |
| 改稿失效 | 修改输入正文后旧 Control 变为 `CANCELLED` / `USER_CANCELLED`，UI 显示“审批已失效”，旧确认按钮消失 |
| 容器重启 | 显式重启 Sealos 应用；Worker 自动重连，4 条任务状态及 operationId 全部保留，已完成任务保持 COMPLETED，撤销审批保持 CANCELLED |
| 外部副作用 | 正式 Worker 专用 ledger 的 `*.claim.json` 数量在验收前后均为 0；没有批准发布、调用真实 publisher 或新增微博 |

Fetch / Knbase 的服务探测均显示 ONLINE，UI 呈现各自本机工作台链接；本轮没有进入业务应用执行业务任务，也没有验证手机跨网络访问这些回环地址。

## 验收任务明细

| 用途 | Task ID | 状态 | 创建时间 |
| --- | --- | --- | --- |
| 初次起草探测（修复前） | `task_25329f99-b67a-405c-aa80-8cb3ebcf2265` | `FAILED` | 2026-10-10T14:34:45.261+08:00 |
| 启用正式 Worker 后的起草 | `task_23e76b12-2d31-4518-a532-c9783fde2398` | `COMPLETED` | 2026-10-10T14:38:43.578+08:00 |
| 不可变正文预览 | `task_60339fb7-b5ba-47cf-b6bc-4fa141696bfd` | `COMPLETED` | 2026-10-10T14:39:03.762+08:00 |
| 发布审批 Control | `control_1ca1b21b-c946-4a03-ba49-b7192917aacd` | `CANCELLED` | 2026-10-10T14:39:03.821+08:00 |

对话 ID：`hub_108570e0-19a7-471c-bb29-91361fb018b9`。发布 operationId：`operation_d22943b1-326a-4555-962c-ccc129c1c894`。快照摘要：`cfb73fb8d7f99fa28c6900772b96f44b66cf3ca7e6bb23706acf34357019a429`。这次 Control 未产生 APPROVED 记录，也未分发真实发布。

初次探测返回 `UNKNOWN_WORKSPACE`，原因是正式 Worker 原配置未注册 Publish。按用户批准添加直连配置并重载 Worker 后，起草、预览和撤销均通过；保留失败记录作为可追溯证据。

## 持久化与回退

部署前旧 `/data` 卷只有 `turns.jsonl` 和 `lost+found`，没有任务数据库；未将本地真实发布数据库复制到云端。旧日志沿用原卷保存。升级后使用 SQLite `VACUUM INTO` 创建 `/data/tasks-b6ccec3-acceptance-20261010.sqlite` 验收备份，权限 0600。

若需回退，先备份当前 `/data/tasks.sqlite` 及其 WAL，再判断旧镜像是否兼容 schema v2；不能直接让旧代码打开 v2 数据库。旧 deployment 镜像配置为 `latest`，它是可变标签，不能作为已锁定的回退镜像摘要。回退 Worker 时使用私下保存的原 plist，并只重新加载 Worker。未在本轮执行回退或删除任何业务记录。

本次部署只做起草与审批前验收，不再真实发布。真实微博成功基线仍见 [publish-operation-acceptance.md](publish-operation-acceptance.md)，其中记录的真实发布任务与链接来自此前本地用户操作。

本文不记录 Cookie、Token、Worker secret、密钥、认证头或完整环境配置；截图同样不包含认证值。
