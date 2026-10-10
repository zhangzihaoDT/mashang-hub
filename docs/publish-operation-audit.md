# Publish Operation 接入审计与方案

只读审计基线：工作树 package.json 为 0.3.2，已有未提交 Workspace/Runtime 改动，保留这些改动。未访问账号、凭据或真实 API。

## 可复用能力与缺口

- Publish 对话已独立保存 Session，但 app.js 强制添加只起草提示，运行面板显示未接入。
- Task Store 已有 SQLite FULL/WAL、审批、attempt/dispatch ID、重启恢复；Runtime 控制已有用户审批和 Worker journal 对账。现有 Operation 是无参数命令，审批没有正文摘要。
- publishing/gate.mjs 有不可变草稿、独占 claim 和保守 UNCERTAIN，但属于默认关闭的 deny-all 实验，不作为正式路线。
- mashang-publish 已有文本 publisher、官方 weibo-cli 客户端、执行前日志、数据锁、原始响应与归档。复用这些模块，不另写微博 API 或 OAuth。CLI 自己生成 operation ID，需要在执行服务记录跨层关联。
- docs/publishing-isolation.md 要求 OS 身份、代码/公钥所有权与凭据隔离。仓库代码无法证明部署已具备这些条件；正式路线默认关闭，部署与真实验收单列。

## 实现

扩展现有 Runtime Control 为快照 Operation：Worker 生成本地不可变快照和摘要，Hub 只保存引用、摘要及通用控制记录。UI 显示最终原文，确认绑定摘要。Task Store 记录 DRAFT、PENDING_APPROVAL、APPROVED、RUNNING、COMPLETED/FAILED/UNKNOWN；修改产生新引用，失效旧待审批控制。已执行快照不修改。

Hub Ed25519 私钥签发绑定 taskId、operationId、targetId、digest、snapshotRef、version、有效期的证明。隔离服务验证后先持久化 claim，再调用现有 publisher；通过 Storage 写日志的钩子保存业务 operation ID。核验只读关联日志及原始响应，不重新调用 publish。缺少明确成功证据保持 UNKNOWN，不因查不到结果判断失败。

Worker 注册 Operation、转发签名请求及结果，沿用 journal 和 Hub 对账。不在 Hub 引入脚本路径、微博 API 或凭据。旧实验保留兼容，但与新模式互斥。

## 验收边界

自动化使用虚构账号、Mock 执行器与临时目录。正式部署必须提供隔离身份、私钥仅 Hub、公钥及服务代码 Agent 不可写、Agent 无法访问发布凭据/数据的证据。真实发布须 Mock 完成后由用户明确授权具体正文、范围和声明。
