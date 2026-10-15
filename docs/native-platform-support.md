# 原生平台支持与验收

[文档首页](README.md) · [运行角色](runtime-roles-and-distribution.md) · [系统服务](platform-services.md) · [发行包](desktop-packaging.md)

2026-10-15 本轮实现保留 Windows、macOS、Linux 的平台接口；用户将本轮验收范围收敛为 Windows。代码具备其他平台分支不等于对应平台的完整产品已经通过验收。

## Windows 运行路径

Computer worker 使用本机 Node、原生 Windows 文件系统及 Credential Manager，不启动 WSL。`codex_exec_command` 默认 PowerShell 7；固定 Bash 契约使用 PortableGit/Git Bash。发布目录包含后台 Node、PowerShell、Git Bash、ripgrep、图片原生依赖及进程与 SCM helper，均按实际平台和架构校验。

所有工具进程（包括搜索）经同一内部进程适配器执行。Windows 10+/Server 2016+ 通过 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在创建挂起进程时原子加入独占 Job Object，再恢复执行；不保留创建与归属之间的孤儿窗口。Run 取消、scope 关闭、worker 所有者异常退出都会清理所属树；helper 自身死亡时内核关闭唯一 Job 句柄并终止树，但缺失回执仍视为清理失败。初始进程退出与完整资源退出分开观察；未知退出不能生成成功清理事实。普通客户端关闭仍只关闭观察，harness server 异常退出不取消独立 worker 的已接纳操作。

默认 shell 使用 UTF-8 管道；显式选择其他 shell 时命令遵循该 shell 的语法与退出规则。例如 PowerShell 的命令模式可能把未显式 `exit` 的原生命令失败映射为 1，工具报告实际 shell 退出码。PTY、脱离 Run 的独立后台任务与操作系统文件沙箱不在当前契约内。

worker endpoint 目录使用当前账户与 SYSTEM 的受保护 DACL；目录上限由实际目录身份和祖先关系判断，不统一折叠 NTFS 大小写。junction 不能绕过附着上限。文件、补丁、图片锁、进程账本及所有者代次沿用共享实现。凭据缺失条目的平台返回值归一为统一端口语义，凭据不落入 JSON/SQLite。

## 验证入口

| 范围 | 入口与检查内容 |
| --- | --- |
| 完整代码检查 | `npm run check`，构建平台 helper、TypeScript strict、根与 Models 行为测试 |
| 原生进程 | `managed-process-runtime.test.mjs`：参数、Unicode、stdin、Job 隔离、后代清理、所有者与 helper 强杀、输出上限、干净启动失败 |
| 工具 | `native-tool-platform.test.mjs`、`process-tools.test.mjs`、`bash-component.test.mjs`、四种原生协议工具循环 |
| 文件与权限 | `platform-worker-files.test.mjs`、文件/补丁/图片/项目文件测试；DACL、真实身份、junction 与锁恢复 |
| Worker | `native-worker-lifecycle.test.mjs`、`computer-worker*.test.mjs`、`computer-unit-faults.test.mjs`：附着、权限撤销、恢复和强杀故障 |
| 桌面进程归属 | `windows-desktop-worker-lifetime.test.mjs`：真实 Electron main 与 UtilityProcess 均退出后，外部观察确认 idle worker 原 PID/boot 继续运行，再显式停止并等待操作系统退出 |
| 系统凭据 | `ANYBOX_KEYRING_TESTS=1` 的真实 Credential Manager 跨进程读写、更新和删除 |
| 服务管理 | `platform-services.test.mjs`：服务配置、注册命令、秘密 stdin、真实 Node runner 启停与 EOF；SCM helper 原生编译 |
| 发行 | `desktop-package.mjs`、`verify-staged-application.mjs`：目标二进制架构、离线运行时、完整资源图 |

真实 SCM 安装、服务账户登录与服务会话中的 Credential Manager 需要具备管理员权限及“作为服务登录”权限的测试账户。配置生成和 Node runner 测试不能替代这些验收；本地测试不自动安装永久服务。

### Windows x64 实测记录（2026-10-15）

在原生 Windows x64 上开启 `ANYBOX_KEYRING_TESTS=1` 与 `ANYBOX_DEPLOYMENT_TESTS=1` 运行 `npm run check`，退出码 0。TypeScript strict、完整构建和 1,400 项测试完成：1,387 通过、0 失败、0 取消、13 跳过。跳过项为 macOS 专用路径/发行检查、Unix 权限或 Linux 无 Secret Service 场景，以及 8 项真实模型 API 门控；四协议的受控模型工具循环已运行。日志为 `data/native-windows-check-final.log`。

加入系统 PowerShell 5 查询及 Electron/worker 进程归属验证后，再次以相同门控完整运行 `npm run check`，退出码 0：1,402 项测试、1,389 通过、0 失败、0 取消、13 跳过，行为测试耗时约 142 秒。此轮同时运行成品 smoke，worker 强杀后的恢复用例通过。最终日志为 `data/native-windows-release-check.log`。

源码 Electron 的完整 smoke 已通过真实 Credential Manager、SQLite、三种图片编解码、原生目录窗口取消、Bash/Apply Patch、文件快照、隐藏窗口保持 Run、退出取消本机 Run、远端 Run 继续完成及锁释放。报告为 `artifacts/desktop-smoke-source-6b0c7c9de79d4882924559da38762e00/smoke-report.json`。原生退出确认框的人工点击场景未启用；退出准入与取消生命周期通过自动化验证。

Windows x64 成品 `artifacts/desktop/out/make/zip/win32/x64/Anybox-win32-x64-0.0.0.zip` 为 494,629,937 字节，SHA-256 为 `4a5b8f599fede733c632957408f2841a0488d02191704c58e9c446a706cd0c1c`。在 PATH 仅包含 Windows 系统目录时，随包 Node 22.19.0 完成独立 worker、PowerShell、Bash、文件读写、补丁、搜索与进程清理，报告为 `artifacts/desktop/out/Anybox-win32-x64/runtime-smoke-report.json`。成品 Electron 44.5.1（内部 Node 24.21.0）的完整 smoke 也通过，报告为 `artifacts/desktop-smoke-installed-83e9f12901f440aa9f70137e727d5874/smoke-report.json`，`passed` 与 `installed` 均为 true。

发行验证扫描了 837 个原生 PE；Rust helper 静态链接 CRT，Keyring 所需 VC DLL 随包提供。成品 smoke 的 `loaded-runtime-modules.json` 记录 Electron UtilityProcess 与独立 Node worker 实际加载各自随包 VC DLL；`artifacts/runtime-module-evidence/archive-content-check.json` 对账 ZIP 内六个关键文件与实测目录的哈希。测试用凭据、worker 和子进程已清理。此包尚未覆盖真实 SCM 服务安装与人工退出确认点击，也不代表其他架构或系统的发行验收。

进程后端已覆盖 worker 所有者强杀及 helper 自身强杀；后者即使整棵树被 Job 清理，观察仍报告失败而不伪造成功。私有目录回归包含“当前用户是 owner、继承权限只有 Modify”的实际场景，仅在 owner 不同时请求变更所有者。无头部署门控使用独立临时目录与随机凭据命名空间，验证客户端配对、图片原字节、独立 worker 的 Bash/PowerShell，并清理凭据和进程。

真实 Electron 主进程和 UtilityProcess 全部退出后，外部 Node 已验证 idle worker 保持原 PID/boot 且 HTTP 可用；随后显式停止并观察实际进程退出。此项排除了 Windows 外层 Job 意外绑定独立 worker 生命周期的情况。系统 PowerShell 5 服务入口固定使用自身 Modules，实际只读 SCM 查询覆盖从 PowerShell 7 继承不兼容模块路径的场景；未注册永久服务。

发行检查期间，一次完整并发回归的“强杀 worker 后下一次调用重新启动”出现 `worker-startup-failed`，当时临时目录清理未保留 worker 日志，根因尚未确认。已为该用例补充启动阶段、实际退出断言及失败时的 worker 日志；随后 96 次隔离重复与 32 项生命周期并发用例全部通过。这些结果不能证明该偶发问题已修复，不以未经证实的 PID 复用或锁释放假设修改生产代码。原始记录为 `data/native-windows-post-package-fixes.log`，并发诊断记录为 `data/worker-respawn-concurrent-diagnostics.log`。

现有单元传输在已领取的回复丢失或附着撤销后，可能等待默认 60 秒回复超时再重新观察或结算；这与本机进程树是否已清理分开判断。故障用例注入较短回复超时以覆盖相同路径，本轮没有修改生产重试协议。

## 其他平台

macOS/Linux 保留 Bash 与 Unix 进程组实现，Linux helper 使用 subreaper 回收退出后代。当前 Unix 清理契约不支持主动 setsid/daemon 化逃出进程组。Linux 的原生进程后端已在 Ubuntu WSL 真实编译并运行专项；WSL 验证不代表 Linux 桌面成品验收。

macOS LaunchAgents 与 Linux systemd 用户服务适配及 CI 矩阵保留。此轮未验证 macOS 实机、三平台全部架构、签名、公证或各平台实际系统服务安装；这些状态需在对应环境单独更新。
