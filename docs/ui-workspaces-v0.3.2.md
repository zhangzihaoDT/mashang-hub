# 0.3.2 · 统一外壳，多种工作空间

Hub 是四个业务系统的统一入口。导航切换整个工作空间，保留每个系统适合的交互方式。本版不建立统一业务能力协议、不新增 capability discovery API。

| 工作空间 | 本版交互 |
| --- | --- |
| Service | 自然语言分析、对话流内的任务状态与结果、Markdown 与附件预览/下载 |
| Fetch | 显示 Worker 上报的服务状态和独立 UI 地址，用户主动在新窗口打开 |
| Knbase | 显示知识工作台状态和独立 UI 地址，用户主动在新窗口打开 |
| Publish | 独立对话上下文，用于起草、审阅、快照预览和审批发布；真实执行默认关闭，待隔离部署 |

## 交互边界

切换导航不会执行任务，不会启动服务或发布内容。Service / Publish 分别保存当前页面中的草稿、会话 ID、结果与附件；正在后台执行的结果归属原工作空间。切换不会取消正在执行的任务。

左侧固定轻导航承载四个同级应用入口，右侧整体切换应用工作空间。保留原配色与控件样式，标题仅显示当前模块和会话操作。Fetch / Knbase 的区域独立于对话，后续可接入原有 UI。

任务只有在用户发送后创建。空闲时不显示独立结果卡片；任务回复嵌入对话流，整合状态、执行模型、完成耗时、回答和附件；执行 ID 等诊断信息保留在执行详情中。后续对话时保留当前页面中的历史结果。当前模型仍由用户选择。

Service 沿用既有任务 API。Publish 使用独立 Hub Conversation；起草/审阅沿用消息入口，预览由 Worker 生成不可变快照，审批复用 Runtime Control 与 Task Store。正式路线需要快照摘要与 Hub 签名；未启用正式开关。UI 不是凭证隔离的替代，OS 隔离仍是正式发布前置条件。详见 [Publish Operation 验收](publish-operation-acceptance.md)。

刷新页面可恢复会话关联及当前任务状态，但普通聊天正文、输入框草稿和聊天历史结果仍仅在页面内存中；发布快照在 Worker 持久化，刷新后按需读取，发布 Operation 状态由 Task Store 恢复，不宣称已持久化聊天历史。Service 使用原 localStorage session 键以兼容旧页面，Publish 使用独立 session 键。

## 独立 UI 地址

复用 runtime.snapshot.services[].openUrl，Hub 没有新增业务后端。Worker 本地探测和浏览器入口分别配置：

```sh
# Worker 可选配置，替换为本设备可达的真实地址
MASHANG_FETCH_UI_URL=https://<fetch-ui>/
MYKNBASE_UI_URL=https://<knbase-ui>/
```

这两个变量只覆盖 openUrl，不修改本地 health probe、服务端口或启动命令；launchd 安装器支持透传。已有 MASHANG_RUNTIME_CONFIG 的 service openUrl 配置仍可覆盖默认值。

未配置时沿用 Worker 本机地址。页面明确提示 localhost 不一定可从手机或其他设备访问。Hub 不代理独立 UI，也不尝试嵌入可能拒绝 iframe 的页面。服务在线不等于当前浏览器已验证可达；没有地址时隐藏打开按钮。

## 验收

- npm test：既有任务、Runtime、Artifact、Workspace、发布实验与恢复回归通过。
- tests/workbench-browser.mjs：真实临时 Hub + Mock Worker + Chrome，无真实业务访问。验证四入口切换不执行、草稿/会话/结果隔离、后台结果归属、独立链接、Markdown 附件预览、桌面与 390px 手机布局及无横向溢出。
- 浏览器截图在 `.local/ui-preview/`，内容为 Mock 示例，仅用于视觉验收。
- 浏览器专项需要 Playwright；可通过 PLAYWRIGHT_MODULE 指定已安装模块路径，通过 CHROME_BIN 指定浏览器。运行 `npm run test:workbench-browser`。

本版未部署 Sealos、未重启正式 Worker、未修改运行中的 LaunchAgents、未访问真实 Fetch/Knbase UI、未真实发布微博。

## Workspace 内的 Runtime

Worker Registry 通过可选 `workspace` 元数据关联运行实体与应用入口，状态采集、启动/停止/重启和 Operation 执行仍由 Worker 负责。该字段经 Runtime V1 快照和 Hub 白名单透传，不传本地命令、文件路径或凭证。旧 Worker 可使用既有应用 ID 与分组作展示兼容。

Service 的运行控制区域展示常驻进程、Job 和按需 Operation；Fetch / Knbase 在入口区域展示各自服务及控制审批。所有控制共用同一个前端状态管理器和现有 `/api/runtime/control`、decision、cancel 接口，Worker 离线时禁止操作。顶部仅保留 Mac Worker 状态；全局运行总览入口与弹窗已移除。运行状态、审批和控制记录均在对应 Workspace 展示。

Publish 不虚构常驻服务；Worker 未注册快照 Operation 时显示未接入。能力已注册时，预览、明确审批及发布链接在原对话中展示，不提供脱离快照的 Run 按钮。Fetch / Knbase 继续用外部链接打开原 UI。Worker 连通性、服务探测结果和浏览器可访问性分别展示；快照附带采集时间。Offline 不等于已确认进程停止。

日志目前只有 Worker 本地 `mashang logs` CLI，尚无 Hub 浏览器日志读取协议，本版提示本地查看方式，不添加无效按钮。原始探测错误仍留在 Worker，不上传本地细节。

Fetch / Knbase 复用紧凑启动与运行控制卡。在线时打开工作台为主操作，离线时启动为主操作；未知、Worker 离线或快照超过 60 秒时不提供运行操作。运行实体、Worker ID、快照时间、入口端口、探测说明和日志限制默认折叠在运行详情中。页面按内容高度布局，取消单独的应用说明区，外部 UI 始终在新窗口打开。
