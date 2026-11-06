# Knbase P3 生产交接记录

> Knbase Standalone v1 — 本机生产交付完成，远程 Hub 清理待发布。

2026-11-06 14:10，北京时间。已获用户授权。本机运行管理权交接通过。

- 独立发布 revision 为 `aaea72ab4dde6a12b5bdbbd789dceb3070211b55`。用户级 `local.knbase.web` PID 68432 为 supervisor 68446 的父进程。HTTP 进程 68447 是 supervisor 的子进程，同时是 127.0.0.1:4317 的唯一监听者及资料库写锁持有者。健康检查通过。
- Worker 已重载，PID 68426，日志确认 Hub 注册和 OpenCode 连接。当前 registry 无 myknbase 服务。实际执行 `node worker/mashang.mjs up myknbase` 与 `down myknbase`，两次均以退出码 2 返回 `unknown service: myknbase`，独立服务保持健康。旧 Worker 运行记录已清除。
- 停写后将 library、.knbase、Content data 一致性备份到 `~/Library/Application Support/Knbase/backups/20261106-141017`。三份源端前后清单及目标摘要一致。启动后原资料文件和 Card 文件与备份逐项匹配。
- Content web 已恢复并返回健康，readOnly 为 false。未执行生产笔记写入。Fetch 交接时离线。
- 第一次尝试（备份 `20261106-140901`）完成停写和备份校验，重新注册 Worker 时遇到 launchctl I/O 错误。回滚恢复旧注册表及 Knbase、Worker、Content 服务。
- 第二次尝试（备份 `20261106-140937`）等待 Worker 完成卸载后重新注册，独立 LaunchAgent 启动。交接脚本将预期的旧 CLI 拒绝当作错误，在子命令里触发嵌套回滚，之后第二次逆向应用补丁失败。检查后确认旧注册表已恢复、Content 在线，再补齐旧 Worker 和 Knbase 启动。
- 第三次尝试（备份 `20261106-141017`）取消子命令继承回滚处理，在主流程校验 CLI 的预期拒绝，完成交接。最终验收以本记录的进程链和第三份备份为准。
- 本机 Hub checkout 已应用 P2。远程前端发布待办。本机未配置 Kubernetes 当前上下文，Docker daemon 不可用。
- Chrome 已验证页面可加载及安装按钮可见。未发现已安装的 Knbase.app，桌面与 Dock 及重新登录实测待办。

## P4 验收补录

- **Chrome 独立应用交付通过。** 用户确认 Chrome 安装。Knbase 在独立窗口加载了资料库。已建立 `~/Desktop/Knbase.app` 快捷链接并验证可从 Finder 桌面重开独立窗口。Dock 持久固定项已写入并核对，同一应用只有一个固定项。
- **关窗与后台独立性通过。** 关闭窗口后 Chrome 应用退出，4317 仍由 PID 68447 监听且健康。通过桌面入口重新打开后，独立窗口显示原资料库。Dock 刷新后后台健康检查仍通过。

- **登录恢复配置已通过只读核对。** `~/Library/LaunchAgents/local.knbase.web.plist` 通过 plutil 校验，权限 0600，与已准备的 plist 字节一致。RunAtLoad 为 true，绝对 Node 路径可执行，配置文件存在。真实注销再登录待用户选择窗口。
- **Content 协作隔离回归通过。** 使用实际 Content HTTP 服务创建带合成 PNG 的笔记，Knbase 对同一临时资料库扫描后索引了笔记及配图，预览路径正确，返回的 PNG 与输入字节一致。7 项废纸篓测试通过，其中包含配套删除和恢复后稳定 ID、锁冲突保护。生产历史资料未参与测试。
- **远程 Hub 发布受环境限制。** 已复核 P2 及部署条件，发布与回退步骤见 [远程发布说明](knbase-p2-remote-release.md)。
