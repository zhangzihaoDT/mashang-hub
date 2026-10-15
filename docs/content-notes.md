# Content Notes / Publish 接入与验收

## 用户交互

- 唯一顶层入口 Content，Notes / Publish 位于标题下方，默认 Notes。保留现有全局侧栏、对话区、输入框、结果与附件组件。
- 内部继续使用 publish 标识及原会话存储键，兼容已有会话、任务、签名和审批。切换只改变引导与快捷操作，不启动任务或改变当前结果。
- 笔记卡片展示标题、正文和标签，根据当前阶段提供修改、保存、同步 Flomo。修改后重新预览；输入编辑会使原待审批记录失效。
- “只整理，不保存”只展示卡片；“记下来”“保存到本地”保存笔记。“同步到 Flomo”产生业务确认按钮。“保存到本地并同步 Flomo”先保存本地，再等待外部确认。
- 明确“直接同步到 Flomo：正文”可由已认证的本轮请求授予限定授权；明确“直接同步到 Flomo”也可以绑定当前展示的笔记。没有可绑定的正文、摘要不匹配、目标不匹配或浏览器缺少安全摘要能力时，仍走预览确认，不推测扩大授权。模型输出不携带授权权限。
- 用户自然语言意图优先于选中的能力入口。在 Notes 中要求改写微博，会产生微博草稿及预览按钮；后续复用原微博确认链。发布这条微博可引用当前会话最近的微博草稿，仍需正文预览与确认。
- 本地保存与外部同步分别显示。未知结果只提示“尚未确认是否发送成功，请先核对”，无自动重发按钮；“检查结果”仅核对已有执行证据，不重新发送。开发诊断保留在原入口，不增加 Content 常驻面板。
- 桌面、390px 和 320px 移动端使用相同逻辑，按钮可换行，无横向滚动。

## 受控调用边界

Hub 新增通用有界内容卡片协议及任务预览引用，只保存引用与摘要，不保存正文。由 Worker 读取本地不可变预览；只允许白名单显示字段，不转发路径、命令或配置。

Worker Notes 适配器调用 Content 现有 notes / Storage API；内容生成由禁用全部工具的模型请求完成。模型仅输出 final_note，执行目标由用户指令或受控卡片动作确定。原文与整理稿分别持久化，按当前会话引用讨论，跨会话的卡片动作拒绝执行。

Flomo 复用现有签名审批服务、永久 claim、Worker journal、重启对账；只新增目标参数，原微博目标和签名版本保持兼容。调用前关联 Content task ID；超时、响应丢失或重启只读核对持久化结果，不重新执行外部写入。相同正文的已有去重记录可作为同步证据。

审批同时绑定正文与目标；内容修改生成新引用。结果记录关联起草任务，避免旧审批或旧成功结果展示在新笔记上。已有未含该字段的微博审批继续使用旧兼容路径。

## 本机启用配置

在原 Worker 的受控配置中设置以下字段，不将实际配置提交到 Git：

```text
MASHANG_CONTENT_ENABLED=1
MASHANG_CONTENT_ROOT=<Content 仓库根目录>
MASHANG_CONTENT_PUBLIC_KEY_FILE=<现有 Hub 审批公钥文件>
```

可选：

```text
MASHANG_CONTENT_DATA_DIR=<运行数据目录，默认 Content/data>
MASHANG_CONTENT_NOTES_DIR=<新笔记目录，默认 Content/notes/entries>
MASHANG_CONTENT_STATE_DIR=<Notes 预览与关联记录目录，默认 Worker 状态文件旁>
```

原 MASHANG_PUBLISH_DIRECT / MASHANG_PUBLISH_SERVICE_URL 与审批签名配置继续保留；两种微博执行模式仍互斥。MASHANG_CONTENT_ROOT 优先作为新业务根目录，未配置时兼容 MASHANG_PUBLISH_ROOT，最终默认 ~/Documents/github/content。旧配置如果显式指向已删除的 mashang-publish 路径，需要对齐；代码默认值不能覆盖显式旧配置。

Flomo 配置继续由 Content 的受控运行目录管理，Hub 无需也不得配置 webhook。Worker 需要 Python 3.10+ 及现有 Node 环境。Hub 原签名私钥只由 Hub 持有，使用原可信调用边界；本次不新增或宣称额外的 OS 身份隔离。

部署时需要更新 Hub 的静态资源、服务端代码及 Worker。仅更新静态资源不代表 Notes 已启用。本次没有修改运行中的配置、重启正式服务或部署。

## 验证

```sh
npm test
# 需要相邻 Content 仓库，或指定 CONTENT_TEST_ROOT
npm run test:content
# 使用本机既有 Playwright 与 Chrome，不新增 UI 框架或运行依赖
CONTENT_BROWSER=1 PLAYWRIGHT_MODULE=<playwright 模块路径> CHROME_BIN=<Chrome 路径> npm run test:content
PUBLICATION_BROWSER=1 PLAYWRIGHT_MODULE=<playwright 模块路径> CHROME_BIN=<Chrome 路径> npm run test:publication-operation
PLAYWRIGHT_MODULE=<playwright 模块路径> CHROME_BIN=<Chrome 路径> npm run test:workbench-browser
```

自动化使用临时目录和合成内容。新增闭环测试启动实际 Hub / Worker 并调用实际 Content 文件 API，模型和发送执行器完全 mock。覆盖本地保存、预览确认、错摘要、跨会话拒绝、重复点击、改稿失效、超时、进程重启、生成阶段 Worker 崩溃不重放、对账不重发、来源/目标限定授权、对话讨论引用和 UI 恢复。

浏览器验证覆盖默认 Notes、保留输入的能力切换、卡片保存/同步、只显示业务术语、HTML 文本转义、改稿、直接同步、Notes 内微博草稿，以及桌面/移动端布局。截图在被忽略的 .local/content-preview/ 下。

原微博签名/不可变审批、直连适配器、防重、Hub/Worker 重启及浏览器发布预览专项均使用 mock 验证；未消耗 Credit，未发布或同步真实内容。真实模型格式稳定性、真实 Flomo / 微博端到端、在线部署效果尚未验收。

未实现历史笔记浏览/搜索、批量发布或内容管理后台，符合本轮边界。
