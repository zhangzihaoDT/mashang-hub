# 对话文字发布集成验收（2026-10-10，待部署）

本轮只修改 mashang-hub；未修改 mashang-publish 或其他业务仓库，未改微博归档格式。未部署 Sealos，未修改运行中的 launchd，未真实发布、调用微博 API、读取微博凭证、提交或推送 Git。

## 架构调查与实现选择

已阅读两个仓库的 README、AGENTS.md、Hub 架构边界、Worker/Workspace、Hub 任务与权限路由、launchd 生成器，以及 publish 的 CLI、publisher、weibo-client 实现。

既有链路是浏览器 message → Hub task.create → Worker → OpenCode session/message。Workspace 目录由 Worker 注册表解析，只向 Hub 暴露 id/label。OpenCode 使用 directory 查询参数及 x-opencode-directory；映射按 Hub Session + Workspace 隔离并持久化。

原 permission.reply 只是转发 OpenCode 工具批准，没有正文绑定、不可重放执行记录或发布恢复机制。允许任意 bash/node/python/edit/MCP 时，提示词和命令黑名单均不能阻止 Agent 绕过 --confirm。因此此次使用用户要求允许的安全后备方案：**Worker 直接处理发布意图、预览、用户确认和 CLI 调用；OpenCode 只能发现和说明这项能力，不能直接执行发布工具。** 不是 OpenCode 自主执行 Shell 的集成。

发布模式默认关闭。启用时，所有经该 Worker 创建的 Hub OpenCode 会话使用单条 `permission: "*", pattern: "*", action: "deny"`。会话映射使用新的 guarded 命名空间，避免复用旧的宽权限会话；每次发送模型请求之前 GET session 验证规则，规则缺失、被修改或 API 不支持就拒绝任务。集成模式不转发 OpenCode 工具批准。检查本机 OpenCode 1.18.31 的 SDK 类型确认 session.create 支持 PermissionRuleset；同时每个模型请求显式携带 `tools: { "*": false }`，重新施加通配 deny，防止创建权限在请求间被覆盖。[对应版本 OpenCode prompt 实现](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/session/prompt.ts) 将 tools 布尔值转为 session permission 规则；[官方工具文档](https://docs.opencode.ai/docs/tools/) 说明工具与 MCP 使用权限控制。实际服务端权限执行仍需真实环境验收。

**代价：启用后原有 Hub Agent 的 Shell、读写文件、委派、MCP 等工具全部禁用，仅能进行文字对话。** Runtime 的既有人工授权操作仍走独立机制。若要同时保留任意本地工具和安全发布，需要进一步提供 OS 进程/账户隔离，不能仅放开 bash 或增加 AGENTS.md 提示。该实现不能约束用户在 Hub 之外主动运行的本地 CLI、其他 OpenCode 客户端或可信宿主插件代码。启用前停止旧 OpenCode/Worker 运行，避免遗留的宽权限后台任务。

Hub 仅增加通用 actor（服务端生成的已登录用户来源）、confirmationId、plainText 展示及外部操作中断提示，没有业务意图、命令、目录、Token 或数据访问映射。浏览器输入的 actor 会被忽略；没有 HUB_ACCESS_TOKEN 登录门禁时 Worker 拒绝发布入口。

## 对话与配置

Worker 配置（未写入当前环境）：

```sh
MASHANG_PUBLISH_ENABLED=1
MASHANG_PUBLISH_ROOT=/Users/zihao_/Documents/github/mashang-publish
# 可选；默认 ~/.mashang-hub/publish-gate
MASHANG_PUBLISH_GATE_DIR=/absolute/private/directory
```

这些变量及 MASHANG_WORKSPACES_CONFIG、WORKER_STATE_FILE 已加入 launchd 配置透传。需在后续获准部署时更新 Hub 和 Worker，再更新/重启 LaunchAgents；本轮没有执行安装或重启。不得只升级 Worker 后就假定旧 Hub 支持已认证 actor。

现有窗口直接输入，无需独立发布 UI 或选择新 workspace：

```text
把这段文字发布到微博：原样正文
确认发布
```

支持三个明确入口：“把这段文字发布到微博：”“发布微博：”“发微博：”。冒号后的正文保留空格、换行及特殊字符；不做模型改写。可用 `发布微博[private,ai]：正文` 指定范围/声明，范围 public/private，声明 original/ai/repost。默认 public/original，在预览明确显示。其他自然语言由无工具 OpenCode 解释入口，不自动推断并执行；未实现自由形式正文编辑。

Worker 返回最终正文、范围、声明、确认 ID 和 120 秒有效期。预览使用通用纯文本展示，避免 Markdown 把正文解释成格式或吞掉首尾空格。浏览器回复“确认发布”时携带最近收到的 confirmationId；也可明确回复“确认发布 <完整ID>”。仅确切确认语句 + 已登录用户来源 + 同一对话的预览 ID 才可执行。模型文本、正文中夹带“确认发布”、权限批准或提供 --confirm 字样都不是授权。

“取消发布”或“拒绝发布”永久关闭该预览；过期、缺失/错误确认 ID、已取消信号均不调用 CLI。页面刷新不会恢复隐式确认 ID，必须使用预览中的完整 ID。SSE 早于 HTTP 返回时浏览器缓冲事件，防止快速 Worker 预览及确认 ID 丢失。

## 执行与恢复约束

Worker 私有目录保存不可覆盖草稿、决策、正文执行 claim 和结果，文件 0600、新目录 0700。执行前用 exclusive create + 文件/目录 fsync 持久化 UNCERTAIN；同一预览只允许一次决策，同一正文/公开范围/声明跨对话也只能建立一次执行 claim。创建失败或记录无法解析即停止，绝不猜测恢复。相同内容的显式再次发布也被阻止，这是本轮保守防重策略。

CLI 使用当前 Worker 的绝对 Node 可执行路径、参数数组和 shell:false；只有该受控执行路径加入 --confirm。子进程只继承 HOME/PATH/TMPDIR，不转发 Hub secret 或 Token 环境变量。CLI 自己经官方 weibo-cli 使用用户授权，Worker 不读取 OAuth 或钥匙串。

读取 CLI 的预览 JSON 和终态 JSON；PUBLISHED 必须携带合法字符串微博 ID，链接为 https://weibo.com/detail/<id>。明确 FAILED 返回失败状态；异常退出、超时、非 JSON、无法识别响应、执行后持久化失败或中断均保持 UNCERTAIN，不自动重试，不输出任意 stderr。Worker ledger 的执行 claim 与 mashang-publish 自身操作日志共同保护崩溃窗口，没有改动业务归档格式。

取消在执行前阻止启动；执行后取消不能撤销已到达平台的发布，显示 UNCERTAIN 并要求人工核对。Hub 超时、断线或取消时，已标记可能有外部副作用的任务也会提示人工核对。Worker 重启只读取历史决策和结果，不扫描并自动恢复执行。

不要删除 ledger 来重试，也不要换 ledger 路径绕过防重。UNCERTAIN 应先人工检查微博和 mashang-publish 本地操作日志；本轮不提供自动核对或重开入口。磁盘损坏、清除持久化目录或人工修改记录会破坏防重前提。部署应将 gate 目录保存在 Mac 持久磁盘并限制访问。

## Mock 自动化验收

`npm test` 包含全部既有测试，以及 `tests/publishing.mjs`、`tests/publishing-bridge.mjs`：

- 明确意图识别，Unicode、引号、反引号、$()、换行原样传递。
- 预览展示范围/声明，未确认、错误对话、Agent 来源或未登录时不执行。
- 确认仅执行一次，并发重复确认、重复消息和跨对话同内容不重复发布。
- 拒绝/取消/过期不执行；子进程取消与超时保持 UNCERTAIN。
- 实际 Node Mock CLI 参数传递，shell:false，secret/Token 环境不继承。
- CLI 明确失败、错误输出、异常退出、超时与 UNCERTAIN，不泄漏 stderr、不自动重试。
- durable claim 后模拟崩溃，后续读取 UNCERTAIN；真实 Worker 进程重启后历史成功确认与执行中取消产生的 UNCERTAIN 确认不再次调用 CLI；损坏决策日志拒绝执行。
- 已登录 Hub → 真 Worker → Mock CLI 完整链路；客户端伪造 actor 不覆盖服务端来源；未登录 API 被拒绝。
- OpenCode session 创建 deny-all 规则；服务端不返回规则时拒绝模型请求。
- 浏览器早到 SSE 事件缓冲、confirmationId 绑定、正文纯文本显示；Hub/浏览器代码没有业务 CLI/凭证引用。
- launchd 配置透传与原有任务、Artifact、Runtime 回归。

验收结果：完整 `npm test` 通过；最终的取消、重启及逐轮权限加固改动又通过 `npm run test:publishing` 专项回归。相关文件 `node --check` 与 `git diff --check` 通过。

Mock 不访问真实账号、不消耗微博 Credit。测试所需回环监听在沙箱内被拒绝后，通过获准的 npm test 在沙箱外执行。

## 已做本机只读检查与待验收

只读检查现有 Worker plist：HOME 指向当前用户，Node 是已安装的绝对路径，PATH 包含 /opt/homebrew/bin；node、weibo-cli、opencode 都可在该目录找到。未打印 Worker secret，未读取微博 Token。

待后续真实环境验收：

1. 实际 OpenCode 对 deny-all 的执行行为，包括自定义工具/插件；先无副作用测试拒绝 Shell/MCP，并确认旧宽权限任务已停止。
2. 更新后浏览器/手机交互、SSE 断线、Hub watchdog 与外部操作提示的端到端体验。
3. launchd 用户会话下官方 CLI 钥匙串授权可用性；PATH 存在不等于凭证可访问。任何真实只读 API 检查先明确次数/Credit。
4. 只有另行明确批准才执行一次真实文字发布，核对内容/范围/声明、ID、链接与归档，确认重复请求不会再次发布。当前链接格式继承现有 CLI 约定，未通过真实浏览器核对。

当前状态：代码与 Mock 验证完成，集成开关默认关闭，等待部署及上述真实环境验收。
