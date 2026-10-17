# Anybox 统一发行与独立运行角色

[文档首页](README.md) · [桌面运行边界](desktop-runtime.md) · [桌面打包](desktop-packaging.md) · [部署说明](harness-server-deployment.md) · [组件手册](modules/README.md)

状态：2026-10-15 已确定的产品与架构原则。本文固定发行与进程边界；当前实现及待补齐事项见第 6 节，不表示三平台发行、独立服务管理或 Windows Computer 已完成。

## 1. 发行原则

Windows、macOS、Linux 各自统一提供一个完整的 Anybox 产品发行包，包含桌面界面、客户端服务、harness server 和 Computer worker 的运行能力。用户安装同一个产品，再选择本设备承担的角色；不按角色分别发行客户端版、服务端版或 Computer 版。

各运行角色使用独立进程，支持单独部署；桌面发行包负责把它们组合成易用的产品。独立部署表示从同一发行物中只启用所需角色，其他角色无需运行。无头设备必须能完成安装、配置和服务启动，无需启动 Electron 窗口、桌面会话或客户端服务。

同一个发行包可以包含多个可执行入口、服务运行时、共享代码及静态资源。CPU 架构支持与具体安装封装格式在平台打包实现时明确，不以增加角色专属产品版本解决。角色使用同一发行版本的代码；跨设备不同版本的通信仍需遵守各接口的兼容约束。

发行体积与运行占用分别验收。未启用角色不创建进程、不装配组件、不打开其数据与凭据、不启动其后台任务；入口应在加载角色专属实现前完成角色选择。角色之间可以共享无副作用的代码与契约。无头服务使用包内可独立启动的运行时，不依赖桌面主进程的私有启动消息或外部 Node/npm 安装。

## 2. 进程与资源归属

| 运行角色 | 职责与独占资源 | 部署位置 |
| --- | --- | --- |
| 桌面界面 | 窗口、展示、用户交互、原生桌面适配及有明确归属的本机进程控制；不直接持有业务服务或业务数据库 | 用户电脑 |
| 客户端服务 | 连接管理、客户端数据库与访问凭据、请求转发、页面及流式观察 | 用户电脑或 Web 客户端服务所在设备 |
| harness server | 访问管理、会话与 Run、模型调用、Agent 运行协调、业务数据库、Models 配置与模型凭据、会话资源 | 本机或远端服务器 |
| Computer worker | 文件操作、命令执行、工具进程与 Run scope、执行账本、worker 图片及附着凭据 | 实际执行工具的设备 |

每个服务进程只使用一个应用 Nya 根 Context，按真实依赖装配组件。Models、Session、Run、RunRuntime 等组件继续在 harness server 所属进程内组合；工具执行组件属于 Computer worker 根。进程控制面管理进程身份、启动配置及退出，不复制进程内部的 Nya 依赖图、Effect 清理或服务重启逻辑。

桌面界面是一个运行角色，Electron 主进程、renderer、GPU 等平台进程仍按桌面运行时需要存在；四个角色不意味着操作系统中固定只有四个 PID。这里的客户端服务进程也不同于执行工具的 Computer worker，桌面代码中的 client/execution utility worker 不新增产品角色。

数据库、Models JSON、图片目录、worker 账本与文件锁保持各自的排他所有权。其他角色通过接口访问数据，不直接打开另一个服务正在持有的存储。凭据继续使用所属角色的系统 Vault；独立部署不引入明文文件或 SQLite 凭据后备。

## 3. 部署组合

| 场景 | 用户电脑 | 远端服务器 |
| --- | --- | --- |
| 全部本机运行 | 桌面界面、客户端服务、harness server、Computer worker | 无 |
| 远端运行 Agent，本机执行工具 | 桌面界面、客户端服务、Computer worker | harness server |
| 全部远端执行 | 桌面界面、客户端服务 | harness server、Computer worker |

Web 访问可以用浏览器替代桌面界面，客户端服务独立部署在提供 Web 客户端的设备上。客户端服务与 harness server 仍然各有独立进程与资源归属。

仅作为远端 Computer 的设备必须能够在没有本机 harness server 的情况下完成附着、配置上限、查询状态和撤销。全远端形态必须能完全不启动本机 harness server 与 Computer worker。各组合按显式配置启用，不因安装了完整产品、读取状态或选择远端连接而启动无关角色。

## 4. 通信与生命周期

客户端服务经现有认证的 HTTP/SSE 接口访问 harness server；每次请求固定连接版本和实例，不跨实例重试。Computer 继续使用已有本机 worker 接口或远端附着与拨出传输，保持身份、epoch、Run 归属与未知结果处理规则。桌面可以使用私有 IPC 进行原生适配和管理它启动的进程，但服务的独立启动与业务执行不得要求该 IPC 存在。

| 操作或故障 | 约束 |
| --- | --- |
| 隐藏或关闭界面窗口 | 展示层操作不取消已接受 Run；保留当前桌面关闭窗口即隐藏的行为 |
| 停止客户端服务或断开观察 | 排空客户端自身操作，不向远端自动发送取消 Run 或关闭服务请求 |
| 正常停止 harness server | 先关闭准入，再取消并等待所属 Run、模型与工具实际退出和结算；独立 idle worker 保持运行 |
| 停止 Computer worker | 关闭该 worker 准入，取消并等待其操作、工具进程及根清理；调用方按实际结果或未知结果处理 |
| 某角色异常退出 | 其他角色不因共享父进程的统一清理而被无条件终止；依赖该角色的请求可以失败或等待恢复，不能保证业务无感继续 |
| 重启单个服务 | 重新建立本代服务与通信，验证身份和兼容性；恢复按已持久事实执行，未知副作用不自动重放 |

每个实例必须有明确的生命周期管理者。桌面托管实例由桌面负责启动和按已有退出流程关闭；用户选择独立常驻的实例由系统服务管理器负责，桌面退出只断开连接，不接管或停止这些实例。一个实例不能同时由桌面和系统服务管理器监督；发现同一数据目录已被持有时，应验证既有实例或明确报告冲突，不能再启动第二个所有者。

Linux systemd、macOS launchd 与 Windows 服务的配置分别验收独立启动、停止、重启和状态观察。需要跨 harness server 进程故障继续工作的 worker 必须位于独立服务停止范围；现有 detached 启动不等于脱离 systemd cgroup。进程隔离缩小故障影响，实际恢复能力仍受接口、资源所有权、持久记录及操作系统管理规则约束。

## 5. 产品组合与实现范围

桌面负责安装后的默认组合、本机角色选择、状态展示和有归属的启停；后台角色也提供无界面入口。面向用户统一使用 Anybox、Anybox Harness、harness server 与 Computer 等现有名称，不因为多进程另建产品品牌。当前 CLI 命令见[部署说明](harness-server-deployment.md)，桌面默认纯客户端，本机服务经明确操作启用。

这次确定四种运行角色，不采纳独立 Models 服务、拨入传输、节点发现或额外节点应用等扩展。Models 远端与共用仍按[可组合部署单元设计](composable-units-design.md)后续阶段另行推进；[节点程序设计](anybox-node-program-design.md)中独立于本次决定的提议继续保留为未采纳草案。

## 6. 当前实现与差距

| 边界 | 当前证据 | 待补齐 |
| --- | --- | --- |
| 桌面与后台分进程 | [desktop-main.ts](../src/entrypoints/desktop-main.ts) 默认仅创建客户端；连接管理或原生菜单启动本机服务，`--local` 显式组合；Computer 另有进程 | 独立常驻服务管理与完整角色配置 |
| 服务独立入口 | [anybox-main.ts](../src/entrypoints/anybox-main.ts) 按角色动态分派到 [client-main.ts](../src/entrypoints/client-main.ts)、[harness-server-main.ts](../src/entrypoints/harness-server-main.ts)、[computer-worker-main.ts](../src/entrypoints/computer-worker-main.ts)；Node 发行同步提供入口 | 桌面成品包内的独立无头运行时及平台服务管理 |
| 角色按需加载 | 客户端注册与服务端注册分离，桌面分别使用 [desktop-client.ts](../src/entrypoints/desktop-client.ts)、[desktop-execution.ts](../src/entrypoints/desktop-execution.ts)；纯客户端子进程测试禁止执行端导入及子进程启动；2026-10-17 在真实 Electron utility process 复验纯客户端资源归属及独立执行端启停 | 系统 Vault、完整桌面 smoke 和三平台成品包验收 |
| Computer 独立控制 | [独立管理](computer-worker-management.md)提供客户端本机入口与 CLI；附着、权限、状态与撤销直接访问 worker，读取状态不启动 | 真实平台、系统服务与成品包验收 |
| 统一发行 | [桌面打包](desktop-packaging.md)当前限定 macOS arm64；[Node 发行](harness-server-deployment.md)仍依赖目标机器安装 Node/npm 依赖 | Windows/macOS/Linux 完整统一产品包、无桌面环境安装与按角色启动 |
| 平台支持 | Linux/macOS worker 沿用 Unix 工具与进程管理；Windows 真实 worker 尚不支持 | Windows 工具契约与进程清理实现，以及三平台独立服务、系统凭据和成品包验收 |

2026-10-15 首轮已实现独立角色入口与按需启动，未改变持久数据格式或 Windows Computer 支持范围。`npm run client`/`web` 只运行客户端，`web:local` 显式组合。随后已补齐 Computer 独立控制面；服务管理和平台发行继续独立推进。

2026-10-15 Windows 首轮验证：`npm run check` 的类型检查与构建通过；1352 项测试中 1058 通过、249 失败、45 跳过，失败名称与变更前完全一致，新增 11 项全部通过。纯客户端测试使用真实 Node 子进程，禁止执行端导入及子进程创建，并验证应用恢复和文件归属；桌面主入口测试使用真实角色子进程，替换 Electron 原生平台与系统 Vault。当时 Electron 二进制缺失且下载失败，未完成真实 Electron/成品包验收；这些结果不解除 Windows Computer 的限制。

2026-10-17 在 macOS 上整合桌面角色时，修复权限清理失败后的准入、同观察端与跨进程启动竞争，以及 Claude Agent 在新本机配对后的设备刷新，新增 16 项回归。真实 Electron 的有限复验在隔离 userData 中通过：客户端同时列出 Anybox Harness 与 Claude Agent，打开两个客户端应用没有触发本机服务启动，数据目录只生成客户端数据库；独立启动执行端后可查询 Claude Agent 能力，两个 utility process 经 prepareClose/close 均以 0 退出，HTTP 监听实际关闭。该验证未读写系统 Vault、未运行模型或工具 Run，不代替完整桌面 smoke、成品安装或其他平台验收。全量检查记录见[阶段验收](harness-server-plan.md)。

## 7. 完成条件

- 在各支持平台的干净设备上，从同一个产品发行包分别启动客户端服务、harness server 和 Computer worker；不需要源码、相邻 NyaCore、外部 Node/npm 或桌面会话。
- 验证第 3 节三种部署组合；单独 Computer 完成远端附着和工具 Run，纯客户端形态没有本机执行服务进程或资源访问。
- 对每个后台角色验证启动、健康状态、正常停止、异常退出与独立重启；界面崩溃和客户端断开不取消远端 Run，harness server/worker 故障遵守既有持久恢复与未知结果规则。
- 分别记录各角色空闲与实际工作负载的内存、CPU、启动时间，以及完整组合的总占用；采用一致测量口径，不以安装包大小或简单累加共享内存代替测量。
- 验证单实例锁、独立数据目录、系统凭据、升级兼容和清理等待。发行前运行 `npm run check` 并记录真实平台与成品包验收；被跳过的真实凭据、平台或故障测试不能视为通过。

2026-10-15 Computer 独立管理验证：`npm run check` 类型检查和构建通过，1358 项测试中 1064 通过、249 失败、45 跳过，失败名称与上一轮完全一致。新增 6 项全部通过；工具退出测试使用受控 OS 工具和内存凭据，未解除 Windows 真实 worker 限制。
