# Anybox Harness 原生 Computer 支持

[文档首页](README.md) · [Computer 模块](modules/computers/README.md) · [工具模块](modules/tools/README.md) · [部署](harness-server-deployment.md)

2026-10-19 将 `feat/composable-units-u0` 的 `a2150b2` 中 Windows Computer 实现迁入当前 workspace 结构。功能属于 `@anybox/app-harness` 0.1.2。Claude Agent 的 SDK 适配独立维护，不使用此 Computer 后端；后续全仓 Windows 兼容修复见其[SDK 手册](modules/claude-agent/sdk.md#windows-兼容验证2026-10-19)。

## 归属与运行边界

`packages/app-harness/src/core/platform/` 是既有 Bash、Processes、Files 和 Computer worker 的私有平台适配，包含进程监督器、shell 选择、目录身份、私有目录权限与后台 Node 定位。它不注册 Nya 服务、不新增组件或 Context，也不是宿主或其他应用的共享业务层。进程和文件资源继续归各工具组件、Run scope 与独立 worker 所有，迁移域、附着协议和业务数据位置保持兼容。

Windows 原生 worker 使用本机 Node、Windows 文件系统与 Credential Manager；不调用 WSL。`codex_exec_command` 默认 PowerShell 7，明确命名为 Bash 的契约使用 Git Bash/PortableGit。Unix 默认 Bash。命令语法、路径和依赖按执行 Computer 的平台解释，不自动翻译；新初始化为通用命令工具附加对应平台提示，已固定的历史初始化保持原样。

Windows 10+/Server 2016+ 的工具进程经原生 helper 在创建时用 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 原子加入独占 Job Object，再恢复运行。Job 使用 `KILL_ON_JOB_CLOSE`，取消或 scope 关闭终止所属树；helper 死亡虽由内核关闭 Job 并清树，缺少回执仍报告未知清理，不能伪造成功。Unix 继续使用进程组，Linux helper 使用 subreaper。初始命令退出、完整树退出及输出排空分别观察，`done` 等待实际资源退出。

Worker endpoint 目录在 Windows 使用当前账户与 SYSTEM 的受保护 DACL；目录接纳同时检查设备 ceiling 与批准 scope，以真实路径和目录身份防止 junction 或大小写别名扩大授权。文件工具、补丁与图片仍遵守原字节、链接、事务保留和取消规则；项目路径不是操作系统沙箱。PTY、脱离 Run 的独立后台任务和 Unix 主动 `setsid` 逃逸不在当前契约内。

## 本机 Node 与可选工具运行时

先运行 `npm install` 与 `npm run build`；Harness 包构建会编译当前平台的进程 helper，发布包包含生成的 `dist/core/platform/native`。Windows 源码构建需要匹配目标的 Rust 工具链；运行已构建包不需要 Rust。helper 缺失时明确报告平台后端不可用，不回退未受管的工具进程。

| 配置 | 当前行为 |
| --- | --- |
| 普通 Node 启动 | 默认用当前 `process.execPath` 启动本包的 Computer worker 入口 |
| `ANYBOX_POWERSHELL` | 可选 PowerShell 可执行文件绝对路径；否则查可选运行时、PATH 与 PowerShell 7 安装位置 |
| `ANYBOX_BASH` | 可选原生 Bash 可执行文件绝对路径；Windows 否则查 Git Bash，拒绝 WSL 启动器 |
| `ANYBOX_RUNTIME_DIRECTORY` | 可选 Harness 工具运行时目录；可提供 `node.exe`/`node`、`powershell/pwsh.exe` 与 `bash/bin/bash.exe`，本次不自动下载或承诺全量随包运行时 |
| 源码 Electron 启动 | 需要独立 Node，可使用可选运行时或 `ANYBOX_DEVELOPMENT_NODE_EXECUTABLE`；不把 Electron RunAsNode 视为独立 Node |
| 受信 `ComputerWorkerOptions.executable` / `launch` | 保留显式 Node 路径或已有应用角色启动适配；`launch` 分支先于默认运行时定位 |

Worker CLI 仍是本包 `entrypoints/computer-worker-main`，distribution 只提供兼容命令转交。客户端关闭只结束观察，已经发布的 idle worker 继续运行；启动失败在发布前终止并等待子进程退出，再释放启动协调锁。系统服务进程的直接启动保护继续保留，系统托管 worker 应属于独立停止范围。本次没有加入系统服务安装器、后台服务账户管理或新桌面目录选择器。

完整 Electron 成品会将 JS 放入 ASAR，独立 Node 不能读取其中的 worker 入口及依赖；仅提供 Node 路径并不足以支持该发行形态。监督器已加入 Harness 专属的 ASAR 解包资源，但完整桌面仍需独立物理应用副本或受信角色启动适配，不能由本轮源码 Web/独立包测试推定可用。

## 与宿主包管理的区别

原生 Windows Computer worker 可由 Harness 独立入口和当前静态组合使用。宿主包管理的后台 `prepare` 和 `startRole(... ownership: independent)` 仍有自己的 Windows/Electron 运行时限制；此次没有修改 `packages/host` 的这些适配，也不宣称 Windows 已完成安装、生效、独立角色或卸载验收。具体限制见[归档与准备](modules/package-management/archives.md)、[正式加载与生效](modules/package-management/activation.md)。原生 worker 支持不扩大宿主、桌面成品或系统服务的验收范围。

## 验证记录

原提交 `a2150b2` 在 2026-10-15 的 Windows x64 记录为 1,402 项测试、1,389 通过、0 失败、13 跳过，日志 `data/native-windows-release-check.log`。这是旧分支的历史证据，包含当时的发行与服务相关代码，不能替代当前包结构的重新验证，也不继承其成品 smoke 或完整随包发行承诺。

2026-10-19 在 Windows x64 完成本轮重新验证：

| 检查 | 结果 |
| --- | --- |
| 根 `npm run check` | TypeScript strict、全部 workspace 构建及浏览器资源校验通过；2,086 项测试中 1,883 通过、143 失败、7 取消、53 跳过，整体未通过 |
| Harness 应用包测试 | 79 项全部通过，包含独立业务服务与本包原生资源复制后实际执行 |
| Windows 平台与工具专项 | 94 项中 92 通过、2 项 macOS 专用跳过；覆盖 Job、Unicode、PowerShell/Bash、ACL、文件授权及取消清理 |
| Worker 启动与路由复测 | 12 项全部通过；包含未发布子进程的实际退出等待、独立观察、U1 远端与混合路由 |
| 应用边界与 ASAR 资源 | 6 项全部通过；核心依赖留在 Harness 内，应用不依赖 Claude 或宿主业务 |
| 新目录下独立原生包与角色交接 | 4 项全部通过，helper 由 Harness 包独占携带 |
| 本机运行检查 | Web 3000 与执行服务 3001 已恢复；管理 API 返回 `state:running`、`supported:true`、`platform:win32`、`architecture:x64` |

全量失败集中在未修改的宿主包管理目录 `fsync`、Windows 文件模式/链接假设，以及 Claude SDK 夹具、Models 存储等测试，不能把本轮标记为全仓库通过。完整记录为 `data/windows-harness-integration-check-current.log`；专项记录为 `data/windows-harness-targeted-{platform,worker,runtime,worker-recheck}.log`、`data/windows-harness-package-check.log`、`data/windows-harness-boundaries-check.log`、`data/windows-harness-native-package-current.log`。旧的 `packages/application/dist` 残留构建目录已保留到本机 `data/backups/`，不作为当前 workspace。

本轮修复了迁入时的两处真实回归：目录身份检查须允许授权目录内普通文件的 U1 `stat`；未发布 worker 子进程必须保持引用直至清理完成，发布后才解除引用。并为 Windows CLI 测试使用实际 JS 入口、通过显式关闭请求等待同一业务清理，保留 Unix 的链接及 SIGTERM 验证。

完整检查为根 `npm run check`；专项入口如下：

- `tests/managed-process-runtime.test.mjs`：参数、Unicode、stdin、树隔离、取消、owner/helper 强杀和实际退出。
- `tests/native-tool-platform.test.mjs`、`process-tools.test.mjs`、`bash-component.test.mjs`、`file-tools.test.mjs`：原生 shell、工具输入输出、搜索、文件及 scope 清理。
- `tests/platform-worker-files.test.mjs`：私有目录 DACL、真实目录身份、junction、图片锁与后台入口。
- `tests/native-worker-lifecycle.test.mjs`、`computer-worker-startup.test.mjs`、`computer-worker-resume.test.mjs`：真实 worker、启动竞争、观察关闭、失败清理与重启恢复。

真实模型和系统凭据仍按原门控分别记录；测试替身不代表真实平台 Vault、跨机器服务或桌面发行已验收。

## Windows 全仓兼容收尾（2026-10-19）

在上述 Computer 迁入之后，继续修复宿主、Models 与 Claude 应用各自的 Windows 兼容边界：宿主使用 NTFS 可表示属性核对签名载荷，保留原始逻辑模式与内容摘要，安装和回收区分目录同步与普通文件同步，并实际持有目录身份句柄；Models 归一系统凭据缺失值；Claude SDK JavaScript 入口使用当前 Node，所有查询与 Run 等待真实 ChildProcess 及管道 close。`web:local` 在 Windows 经继承的私有 IPC 关闭子角色并等待退出，Unix 保留信号关闭；各应用仍拥有自己的业务和资源清理。

测试夹具修正本机路径、CRLF 文档读取、无特权 junction、真实计时等待及 SQLite 所有者关闭顺序。活跃 SQLite 替换被 Windows 内核拒绝时验证拒绝本身，并在退出后继续验证复制锚的身份拒绝；没有用跳过或放宽完整性、退出和清理断言消除失败。

最终根 `npm run check` 退出 0：全部 workspace 的严格类型检查、重新构建和资源校验通过；**2,086 项测试，2,033 通过、0 失败、0 取消、53 项既有门控跳过**，测试耗时 175,224.3656 ms。没有新增跳过项。完整日志为 `data/windows-full-compat-check.log`；专项日志为 `data/windows-models-compat-check.log`、`data/windows-claude-agent-final.log`、`data/windows-host-command-recheck.log`、`data/windows-host-package-third.log` 与 `data/windows-root-runtime-recheck.log`。

本节替代初始迁入结果中“全仓未通过”的当前状态，历史记录保留。Windows Node 目录同步的断电保证及宿主 prepare / 独立包角色 / Electron 成品的既有支持范围仍按各模块手册说明；真实模型与系统凭据门控没有启用。
