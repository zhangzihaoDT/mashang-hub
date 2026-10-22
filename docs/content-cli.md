# Content CLI · 记录入口

当前版本：V0.6.3（2026-10-22，CLI 内模式切换与启动模式）

`mashang content` 是内容记录入口，不是通用 Hub 交互终端。进入 `notes` 或 `flomo` 目标后，每次输入都会自动完成「整理 → 保存/同步」。任务、模型、恢复和幂等仍由 Hub / Worker 处理，不出现在 CLI 的正常输出里。

## 产品原则

**Content 不负责和用户讨论内容，而是负责把用户已经产生的内容变成可长期保存的知识资产。**

输入即素材。Content 只做忠于原文的保守整理、标题与结构处理、本地保存或 Flomo 同步；不主动追问、不补充观点、不把记录改写成公开发布文案。讨论、研究和开放式问答属于其他工作空间。

## 启动

需要 Node >=22.13。先更新并启动本仓库的 Hub 和 Worker；Worker 按 [Content 配置](content-notes.md) 启用 Notes。Hub 必须启用用户登录。客户端可在能访问 Hub 的另一台机器运行；不要求它拥有 Content 仓库。

```sh
# 恢复上次模式；首次默认 Notes
npm run mashang -- content --hub https://your-hub.example

# 显式进入 Notes，整理并保存到本地
npm run mashang -- content notes --hub https://your-hub.example

# 整理并同步到 Flomo
npm run mashang -- content flomo --hub https://your-hub.example

# 已通过 npm link 安装命令时
mashang content
mashang content notes
mashang content flomo
```

不指定启动模式时，按 Hub 地址恢复上次模式；首次使用或旧配置没有模式记录时默认 Notes。显式 `notes` / `flomo` 优先，并成为下次默认模式。`--help` 只显示帮助，不连接 Hub。

首次登录隐藏输入 Hub 用户访问令牌。自动化环境可通过 `HUB_ACCESS_TOKEN` 提供，不能使用 Worker 密钥。Hub 地址也可通过 `HUB_URL` 提供；默认 `http://127.0.0.1:3000` 仅用于本地开发。远程地址必须为 HTTPS。模型和会话由 Hub / 本地客户端配置决定，不作为 CLI 选项暴露。

```text
Content · Notes
直接输入内容，回车即整理并保存。
/notes、/flomo 随时切换。多行可直接粘贴，按 Enter 提交。Ctrl+C 退出。

notes › 今天想清楚的一件事是……
正在整理并保存…
✓ 已保存到本地
  标题：今天想清楚的一件事
  位置：本地 Notes 库

notes ›
```

每条记录按「输入 → 处理进度 → 结果」连成一块：结果在状态行下缩进两格，记录结束后空一行再出现下一次提示符，连续记录之间始终只保留这一个空行。连接恢复、命令提示等临时信息不加空行。

## 输入规则

| 输入 | 行为 |
| --- | --- |
| 一行文字 + 回车 | 立即整理并保存/同步 |
| 直接粘贴多行文本 | 按终端粘贴边界识别为一个整块，每个片段显示一个 `[pasted~Nlines]`；按 Enter 后合并为一条记录提交 |
| `/notes`、`/flomo` | 在同一会话、同一登录内切换；提示符立即更新为 `notes ›` / `flomo ›` |
| `/both` | 提示暂不支持，不提交内容 |
| `/exit`、Ctrl+C、Ctrl+D | 退出；已提交的记录继续由 Hub 处理 |

模式命令独占一行，在粘贴待提交或上一条处理中也可使用。切换保留粘贴片段、手动输入及标记，下一次显式提交使用当前模式；已提交、处理中或待重试/检查的记录仍使用提交时的目标。失败后切换模式再按 Enter，仍重试或检查原目标；提示会说明目标。处理过程中输入的新内容作为未提交草稿保留，完成后再按 Enter 提交。粘贴正文中的 `/notes`、`/flomo` 是原文，不作为命令执行。

终端粘贴使用 bracketed paste 的开始/结束边界。粘贴期间输入不会进入 readline 的逐行处理；粘贴结束后只显示 `[pasted~Nlines]`，不打印正文预览，按 Enter 才整理保存，不会在粘贴结束时自动提交。

每个粘贴片段保留自己的标记，连续粘贴会显示为：

```text
notes › [pasted~11lines][pasted~11lines]
```

手动输入保留原文，直接显示在标记之间：

```text
notes › [pasted~11lines]手动输入的文字[pasted~11lines]
```

这些片段和手动输入在提交时合并为一条记录，不是替换关系。

有些终端会在分段粘贴之间附加换行。CLI 会忽略紧跟在粘贴边界后的这一个空行，避免把第一段提前提交；之后的 Enter 才表示提交。

失败时直接显示原因，原文保留在内存中：

- 明确失败：按 Enter 重新提交，或直接输入新内容。
- 结果待确认：按 Enter 重新检查，不会自动重发；也可以直接输入新内容。

不需要记忆 `/status`、`/retry`、`/cancel`、`/web`、`/new`、`/model`、`/help` 等命令；这些命令已移除。`/paste`、`/end` 也已取消，多行统一用粘贴加 Enter。旧命令不会被当成笔记保存，只会得到一行输入提示。

## 终端快捷键评估

- 退出已有终端原生方式：Ctrl+C 和 Ctrl+D；`/exit` 仅作为可发现的显式退出方式保留。
- 输入内容仍用 Enter 提交单行。
- 终端粘贴使用 bracketed paste 边界：CLI 开启 bracketed paste 模式，截获 `ESC[200~` 到 `ESC[201~` 之间的全部内容，交给待提交缓冲区；边界之外的键盘输入仍原样交给 readline。边界解析在 readline 之前完成，管道输入同样适用。
- 粘贴结束后不自动保存，只显示 `[pasted~Nlines]` 并等待 Enter。这样既能保证整个粘块只产生一个任务，也保留用户提交前的确认机会，同时避免把大段正文重复打印到终端。
- Shift+Enter、Alt+Enter 在不同终端下行为不一致，不作为多行编辑方式。多行只保留「粘贴 → `[pasted~Nlines]` → Enter」这一条路径，不再维护第二套手动输入方式。
- 不支持 bracketed paste 的终端会把粘贴内容按普通输入逐行处理，每行成为一条记录。

## 内容整理

- Notes 和 Flomo 共用 Worker 的整理函数和 Hub 默认模型。
- 忠于原始内容，不补充观点；长文本可整理标题、段落和结构，短文本允许保持简短。
- 不把个人记录改写成公开发布文案；Flomo 格式规则仍由 Content 的既有 `flomo-sync` 规则和校验器决定。
- Notes 使用本地 Markdown 保存；Flomo 使用既有 webhook 执行器。CLI 不直接读写笔记文件或调用 Flomo。

## 执行与可靠性

- **Notes**：只有 Worker 完成本地写入并返回 `已保存到本地` 后才显示成功。
- **Flomo**：CLI 使用与 Web「直接同步到 Flomo」相同的受限授权（目标 + 原文摘要）。只有 Flomo API 确认接收、同步操作完成后才显示成功。
- 明确失败可以按 Enter 重试；结果不确定时 Enter 只重新检查，不重新提交，避免重复写入或重复发布。
- 提交响应丢失时先尝试接续可能已经创建的 Hub 任务，不自动重发。
- Hub 重启、Worker 恢复、任务对账和相同正文去重仍由既有后端能力处理。退出 CLI 不代表取消。
- `/result` 不可用的旧 Hub 会失去部分历史结果恢复能力；实时连接仍可接收本次结果，不会因此重跑任务。

## 共享状态

- 默认在 `~/.mashang/clients/` 按 Hub origin 保存登录 Cookie、当前会话 ID、模型选择、当前模式（`contentTarget`）和最近一次任务标记（`lastTaskId` / `lastTarget`），配置文件权限为 0600。可用 `MASHANG_CLI_STATE_DIR` 修改位置；不保存令牌明文或笔记正文。草稿与可重试原文仅在当前进程内保留；重启只恢复任务状态，不重发原文。
- CLI 与 Web 共用模型选择函数。CLI 启动时自动使用 Hub 的默认可用模型，不要求用户选择。
- 笔记保存位置、原文留存、整理规则、去重与权限仍由 Worker / Content 的既有实现决定。“已保存到本地”指 Worker 所在机器。
- CLI 与 Web 使用相同的后端业务工作流：Notes 使用 `save-input`，Flomo 使用受限的直接同步请求。CLI 不新增内容存储，也不扩展为通用聊天工具。

## 验证

```sh
npm run test:content-cli
CONTENT_BROWSER=1 PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
  CHROME_BIN=/absolute/path/to/chrome npm run test:content-cli
npm test
```

集成测试用实际 CLI、Hub、Worker 与 Content 文件 API，模拟模型和外部发送，数据仅写临时目录。另有真实 readline 配合 mock Hub 的模式回归测试，覆盖首次默认 Notes、记忆/显式启动模式、提示符、同一登录会话、多段粘贴与手动输入保留、处理中切换、双向失败重试绑定原目标、不确定结果仅检查、重启后按原目标恢复。集成测试覆盖 Notes 自动整理保存、Flomo 自动同步确认、失败保留原文、Enter 重试/重新检查、多行输入、重启接续和重复提交防护，以及可选的 Web 会话共享。此功能为源代码实现，不代表已经部署到在线 Hub。
