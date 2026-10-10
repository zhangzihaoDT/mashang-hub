# P3 Publishing 隔离部署方案（待环境信息与真实验收）

## 当前状态

Publishing 仍默认关闭。当前 deny-all Worker 入口属于实验，不作为正式发布路线；关闭开关时 OpenCode 普通工具保持可用。本文件是部署设计，不代表账户、Keychain 或执行服务已创建。

## 信任边界

仅拆分两个 Node 进程或声明一个环境变量不能建立凭证隔离。正式配置需让 Agent 的 OS 身份无法读取发布身份的 Keychain、HOME、环境、执行代码、状态与日志；Agent 也不能修改发布服务代码或 sudo 切换身份。发布 CLI 与凭证只在隔离身份下运行。

需要同时检查当前桌面身份、Worker 身份和 Agent 身份。若 OpenCode 使用可访问原微博凭证的桌面用户，只给新发布服务换账户仍不够：原凭证必须从 Agent 可访问身份移除，或将 OpenCode 迁入独立受限账户。知识库与业务目录通过最小化共享权限供 Agent 使用；发布目录不共享。

## 执行服务要求

发布服务不接受自由命令、Shell、任意目录或任意 CLI 路径。它只能接受不可变快照引用、operationId 和 Hub 签发的审批证明，执行指定适配器。Worker 转发批准的请求；Agent 可以起草，但不能签发审批。

Hub 私钥只能在云端，发布服务部署公钥。签名绑定 taskId、operationId、快照 SHA-256、动作版本、范围及有效期。公钥和代码由隔离身份或管理员拥有，Agent 不可写。服务必须自行核验签名与本地快照，不能相信 Worker 的 approve=true 字段，也不能仅依赖请求来自回环或 Unix Socket。两进程共享 OS 身份时，套接字权限不是 Agent 授权隔离。

快照在 Worker/隔离服务本地保存；Hub 只持久化引用、摘要和审批元数据。前端预览通过受控按需读取展示原文。修改内容、范围或声明产生新快照并重新审批；已分发操作保留原 operationId。

发布服务在调用 CLI 前持久化 operation claim。重复 operationId 返回历史结果，不重新调用。异常保持 UNCERTAIN；取消不能撤销可能已发生的外部副作用。需要协调 mashang-publish 的 operationId 与归档记录，现有 CLI 自行生成操作 ID 的行为不能假定已满足跨层 ID 一致性。

## 部署前需要明确的信息

- OpenCode / Worker / 发布服务各自使用的 macOS 账户及可读写目录。
- 独立 Keychain 的创建、登录与官方 CLI 授权方式；不向 Hub 或 Agent 提供 Token。
- 独立执行服务的启动与接入方式、代码所有权和 Hub 公钥部署方式。
- Agent 工作区访问权限与原身份上的微博凭证是否已移除。
- 发布本地快照/ledger 持久化位置，以及备份与 UNCERTAIN 人工核对流程。

## 验收顺序

1. 无副作用验收：Agent Shell/MCP 正常可用，但读取发布 HOME、Keychain、ledger、修改服务代码及切换身份均被 OS 拒绝。
2. Mock 发布：无审批、改正文、改范围、重放、伪造签名、过期批准均不执行；Hub/Worker/服务重启不重复发布。
3. 用户确认最终正文、范围、声明后，执行一次真实发布；核对 ID、链接、归档及回读。真实发布需用户对具体正文明确授权。

没有这些环境证据，不启用正式 Publishing，也不将实验 deny-all 方案替换为同身份自由 Shell + 发布 CLI。
