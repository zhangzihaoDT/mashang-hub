# AKsignal：第五个独立业务区域

业务入口按领域划分，运行基础设施统一复用。AKsignal 与 Service、Fetch、Knbase、Publish 同级；汽车 Service 不因提供 Scheduler 而拥有 AKsignal。当前只接入 Market Facts，不宣称组合、候选、买卖或自动交易能力已实现。

## 初版操作

- 手动补跑：Worker 注册的 aksignal-daily，只调用 AKsignal `python -m src.daily_schedule --tick`；沿用现有控制请求/审批，无 Agent，不在 Hub 编写 Pipeline。后台批次与短控制请求生命周期分开，REQUEST_HANDLED 不是 PUBLISHED。
- 查询状态：Worker 每轮只读 `python -m src.daily_hub`；展示目标日、RUNNING/WAITING/BLOCKED/PUBLISHED、时间、业务阶段、失败原因、重试时间与最近正式发布。没有数据时 IDLE/UNKNOWN。界面显示快照时间，默认 Worker 30 秒、Hub 15 秒更新；离线/过期禁用补跑。
- 日报：最近正式 HTML/Markdown 附件预览/下载；同时显示发布批次、data_complete 和 warnings/errors。CONFIRMED 与数据完整性分离。当前失败或日历不可用时保留上一正式结果，不把其日期冒充当前目标成功。

AKsignal 仓库 `src/daily_hub.py` 负责 checkpoint/回执业务语义与正式产物清单。Worker `runtime/json-operation.mjs` 负责固定程序 JSON 读取、文件范围与摘要核验；Hub 只理解通用 details/metrics/artifacts。注册属于 Worker；本地仓库路径用 MASHANG_AKSIGNAL_ROOT（默认 ~/Documents/github/AKsignal），不进入 Hub。沒有为此业务创建 OpenCode 工作空间。

## 通用协议扩展

runtime.snapshot V1 增加可选 operation.requestOnly、details、artifacts；旧操作字段保持兼容。details 为日期、时间、阶段、质量、最近发布及标签/值 metrics 的白名单，不包含命令或本地路径。超过协议限制的质量信息明确标注 truncated。

附件 metadata 只有 opaque artifactId、名称、扩展名、大小、digest、runId、targetDate。Worker 保留固定正式批次路径；Hub 通过现有 artifact.request/response 获取 bytes，并再次核对 SHA256。只提供 HTML/Markdown，HTML 沿用现有 CSP。Worker 重连后快照恢复注册；其他 Worker 不能代理该文件。校验失败不登记新附件，不覆盖已登记的正式结果。

短触发可与其他业务长操作共存，同一短操作防并发；原长操作的互斥策略不变。后台运行由 AKsignal 原生锁、checkpoint 和有限重试保护。本入口不支持取消后台进程、自动 --restart 或无界重试。

## 开发验收

- npm run test:runtime、test:operation-provider、test:artifact、test:dom：通过。
- workbench-browser：原四个业务区域回归及五入口导航通过。
- test:aksignal-bridge：本地实际 Hub + Worker + AKsignal Python + Chrome，通过控制请求及审批触发原 --tick；命中隔离正式发布，attempts=0，无计算/重发。两附件的预览/下载逐个核对 SHA256，数据质量完整保留，Agent POST=0。桌面 1440×1050、手机 390×844 无横向溢出，完成截图检查。
- AKsignal 原生测试：60 passed，正式发布文件与原在线验收 hash 不变。

桥接测试只接受显式 AKSIGNAL_TEST_ROOT=/private/tmp/...，应准备拥有当前目标正式发布的隔离 fixture：复制 AKsignal src/config/Makefile/VERSION、已发布 outputs 和对应 run/state/checkpoint，链接既有 .venv；不复制 data/。fixture/guard/sitecustomize.py 拦截 Python socket；默认测试不会请求真实行情。日期不匹配、未正式发布的 fixture 会在触发前拒绝。

示例（使用已安装的 Chrome/Playwright，不增加项目依赖）：

```sh
AKSIGNAL_TEST_ROOT=/private/tmp/aksignal-hub-e2e-fixture \
PLAYWRIGHT_MODULE=/path/to/existing/playwright \
CHROME_BIN='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
npm run test:aksignal-bridge
```

## 上线边界

目前仅本地开发分支验证，尚未推送、部署 Sealos 或重启生产 Worker。正式上线需协调 Hub（静态区域/通用协议）与 Worker（注册/provider）更新，影响 Hub/Worker 短时连接；先确认维护时点与在途任务，再取得用户确认。AKsignal 自动 Scheduler 开关继续关闭，不修改 LaunchAgent、Service 08:50 Daily 或业务算法。后续 Resume、日志、更多附件与策略能力另行实现。

## UI/UX 收敛

最新日报显示从已发布 HTML 各表首行提取的事实速览（明确标记样本，不冒充全市场综合结论）；覆盖市场方向、ETF/固定池趋势及底部位置，不重算。来源确认与数据完整性分开。运行细节和质量全文折叠，查询成功短暂提示状态已更新。

“准备讨论”固定所选正式 trade_date/run_id、质量警告、事实速览和附件摘要，可编辑问题并复制证据上下文；刷新不会丢失草稿或更换所选批次。当前未注册 AKsignal 对话执行器，因此没有真实发送/回答，不冒用 Service 会话。真正 Talk 仍需单独接入批次事实消费与只读执行边界，本改动仅交付 UI/UX 和讨论准备。

## 统一对话与运行控制布局

AKsignal 复用 Service/Publish 的对话主区、输入框、模型选择、草稿与独立会话存储键；正式日报事实速览在主区，run-day 的目标日、阶段、补跑、查询、错误、发布结果和附件在同一“运行控制”栏。已移除准备讨论/复制上下文交互。当前模型发送明确禁用，尚未添加任何新外发路径。自动审批审查要求具体日报数据范围与模型服务授权，等待用户选择后再实现真实只读对话；当前 UI 完成不代表 Talk 后端已接通。
