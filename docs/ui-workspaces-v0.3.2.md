# 0.3.2 · 统一外壳，多种工作空间

Hub 是四个业务系统的统一入口。导航切换整个工作空间，保留每个系统适合的交互方式。本版不建立统一业务能力协议、不新增 capability discovery API。

| 工作空间 | 本版交互 |
| --- | --- |
| Service | 自然语言分析、任务状态、结果卡片、Markdown 与附件预览/下载 |
| Fetch | 显示 Worker 上报的服务状态和独立 UI 地址，用户主动在新窗口打开 |
| Knbase | 显示知识工作台状态和独立 UI 地址，用户主动在新窗口打开 |
| Publish | 独立对话上下文，用于内容起草和审阅；正式发布仍未接入 |

## 交互边界

切换导航不会执行任务，不会启动服务或发布内容。Service / Publish 分别保存当前页面中的草稿、会话 ID、结果与附件；正在后台执行的结果归属原工作空间。切换不会取消正在执行的任务。

任务只有在用户发送后创建。结果卡片整合状态、执行模型、完成耗时、回答和附件；执行 ID 等诊断信息保留在执行详情中。后续对话时保留当前页面中的历史结果。当前模型仍由用户选择。

Service 沿用既有任务 API。Publish 使用独立 Hub Conversation，发送起草/审阅请求，未新增外部操作协议、未启用 Publishing 开关，也不提供真实发布按钮。UI 起草说明不是凭证隔离的替代，OS 隔离仍是正式发布前置条件。

刷新页面可恢复会话关联及当前任务状态，但正文、草稿和历史结果仍仅在页面内存中，不宣称已持久化聊天历史。Service 使用原 localStorage session 键以兼容旧页面，Publish 使用独立 session 键。

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
