# Knbase P3 切换前复核

2026-11-06，北京时间。当前授权范围为切换前检查。

候选 Git revision 为 `aaea72ab4dde6a12b5bdbbd789dceb3070211b55`，父提交为 `39bef26a37cc2e7fc6e791aece64fde4ee069800`。在临时克隆中纳入 Knbase 当前全部受跟踪文件和非忽略的未提交文件，源仓库保留原分支及工作树。候选包括 supervisor、健康检查、扫描子进程、稳定性和资料关系修复、独立应用管理及其测试。

| 制品 | SHA-256 |
| --- | --- |
| `.local/knbase-p3/knbase-aaea72ab4dde6a12b5bdbbd789dceb3070211b55.bundle` | `55c337568b2eac22c279868d869bc5967d3dc8182fe44a85ed754ff240d3e104` |
| `.local/knbase-p3/knbase-aaea72ab4dde6a12b5bdbbd789dceb3070211b55-macos-arm64.tar.gz` | `5ec14bc346f9364aa194d81ecac6a67d2b61d110a2fe3081601a906033dcce1a` |

运行包含锁定源码、当前已安装且依赖树校验通过的 Node 模块，以及从候选源码编译的 ARM64 废纸篓工具。解包至单独发布目录，使用本机绝对 Node 路径和配置中原生产库的绝对路径。旧工作树仍是回滚入口。运行中的 PID 2444 加载早于工作树最近的 HTTP 改动，无法由工作树 revision 推定其已加载的精确字节。运行身份以进程树、实际健康响应、端口与写锁交叉核验。

| 检查 | 结果 |
| --- | --- |
| 资料基线 | 库 ID `1f605402-a8d5-4af1-badf-99dd4d2a3856`。487 张 Card、487 个唯一资产 ID。191 present、257 missing、39 trashed。无外库 ID。28 条加工记录、2 条附件关系且目标均存在。资产 ID 集合摘要 `9f6dcf42f27921f84de470b2b50a7f5e85bee35d9a5f1d53c6b986e7a90e102a`。 |
| 生产状态 | 4317 的监听者与写锁持有者同为 PID 2444，由旧 supervisor 和 npm 管理。14:04 采样健康、无进行中的库操作。Content 在线，取样无写锁，作业状态仅 PREVIEW / SAVED / SYNCED。Fetch 7860 无监听且旧 PID 已退出。 |
| 共享写入 | 正式窗口先停止提交并等 Content 在途任务完成，确认无 PROCESSING、发送中任务及写锁。通过已校验的 plist 在用户会话中卸载并恢复 Content web LaunchAgent，暂停期间避免 CLI、Finder、Agent 等直接写入。恢复后核对 4175 健康及新笔记可见。隔离 Content 测试验证只读模式拒绝写入和服务重启。Fetch 当前保持离线，窗口前复查 PID 和端口。若届时在线，排空后在 Fetch 目录用 npm run down 暂停并以 npm run up 恢复，仅恢复窗口开始时在线的服务。 |
| Hub P2 | 生产 Hub HEAD `53e6175e8ac132cd7008a91eb57bed68a6366c1e`。补丁在当前差异上通过 apply check。隔离应用后，默认和含旧 override 的 registry 对比均只有 myknbase 服务退出。DOM、runtime、Chrome 工作台回归通过。 |
| 停服与回滚 | 旧 Worker registry 仍能解析 myknbase 的启动、SIGTERM 和健康探针。窗口内先在旧 Hub checkout 用 `node worker/mashang.mjs down myknbase`，确认进程树、端口和写锁释放，再应用 P2。新入口从发布目录执行 `node scripts/knbase.mjs install`、`start`、`status`。回滚时先执行新入口的 `stop` 并确认退出，再逆向应用已应用的 P2 变更、恢复原 Worker 配置及重载，用旧入口 `node worker/mashang.mjs up myknbase` 恢复。测试 LaunchAgent 已验证安装、启动、停止、重启、卸载和故障恢复。若发布远程前端，发布前另记其当前镜像摘要供回滚。 |
| 备份 | 目标卷有约 42 GiB 可用，预计原资料、索引及 Content 数据合计约 1.05 GiB。正式路径为 `~/Library/Application Support/Knbase/backups/<切换时间>`，目录 0700。排空写入并停止旧服务后，用 ditto 分别复制 library、.knbase、Content data，并保存旧 plist 与 Hub 差异。源在备份前后分别生成相对路径、类型、常规文件 SHA-256 和符号链接目标清单，与目标比对。还需复核库 ID、Card、加工和附件关系，抽查可恢复性。已在临时目录实测 ditto、带空格文件名摘要及符号链接保留。 |
| Chrome 与登录 | Chrome 已安装。候选服务的 manifest 和 MIME 通过测试，应用名为 Knbase，display 为 standalone，图标文件存在。正式服务健康后在 Chrome 菜单安装，验证独立窗口、桌面替身与 Dock。用户会话重新登录后核对 RunAtLoad、launchctl、唯一监听 PID / 写锁和健康；注销属于独立验收动作。 |

切换窗口开始时复核制品摘要、资产基线、端口、锁和共享写入状态。任一关键校验出现变化时先排查。正式切换须等用户单独确认。
