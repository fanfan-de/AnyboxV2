# Agent Note: 项目分别选择并固定 Computer 执行环境

Status: implemented

## 问题

工作区原有全局本机或远端 Computer 选择，使默认执行目标与服务启动配置耦合。当前待提交改动将本机与多个远端环境同时呈现，并要求每个新增项目固定目标；既有项目、Run 和未知操作不能随默认环境变化而改绑。

本记录于 2026-11-11 审计时补录当前未提交工作区的独立目标；原开发轮次与讨论过程未核实，依据当前源码、差异、组件手册和测试记录最终方向。

## 决策

复用 Unit 附着身份与现有传输，增加只读 Computer 环境投影和应用拥有者侧查询，不另建环境数据库或组件。组合根始终安装惰性本机 worker 客户端，并让路由同时服务本机及已批准远端；列表读取不启动 worker。

新增项目缺省绑定 harness server 所在设备的 `local:computer`，显式远端绑定的路径交给目标 worker 按自身文件系统与授权上限验证。项目以规范路径和附着共同去重，跨操作系统的绝对路径不由 Authority 的平台解释。移除旧全局选择配置并明确拒绝非空旧环境变量及程序化选项，避免旧调用静默落到本机。

Web 先捕获 harness server 连接和实例，再选择项目环境；远端仅填写目标设备的绝对路径，本机继续提供目录浏览和可用的系统窗口。环境、路径记忆及请求代次隔离，失败不切换目标，关闭与切换等待原观察退出。审计同时更正部署文档：已离线项目的新 Run 在准入阶段以 `project-unavailable` 拒绝，与现有集成测试一致；同步 Web 设计、前端与连接组件说明中的旧全局默认环境及原生目录选择流程。

## 备选方案

未核实原开发时比较过的其他方案，不补写讨论或用户确认。现有方案沿用附着授权、操作身份和恢复账本；没有新增全局远端默认值，也没有在目标失败后自动回退另一设备。

## 影响与代价

使用旧非空 `ANYBOX_COMPUTER_UNIT`、`ANYBOX_COMPUTER_ATTACHMENT` 或程序化 `computerUnit`、`defaultComputerAttachmentId` 的调用方必须删除旧设置，并在创建项目时显式选择远端。旧项目、已接受 Run 与恢复身份保持原绑定；新项目默认本机。目录选择依赖目标服务声明环境列表能力，旧服务需要升级。

只读状态是观察时快照，不能保证未来执行可用；远端离线、撤权或未知退出仍按原生命周期等待或拒绝，不重放未知副作用。未扩展工具权限、持久数据迁移或 worker 生命周期所有权。

## 验证

审计追踪了环境列表、认证与网关白名单、Projects 路径登记、worker 路由和 Run 绑定的实际调用链，未发现本目标必须修复的代码缺陷。现有测试覆盖本机与两个独立远端 worker、默认本机与既有远端重装配、离线不回退、权限上限、跨平台路径以及环境切换和关闭等待。

本轮先行聚焦命令在根构建清空 `dist/` 的窗口内启动，三个测试文件因缺少构建产物未进入用例；不视为行为失败。随后统一使用本机 Node 24.16.0 与 Rust 1.94.1 执行根 `npm run check`，类型检查、构建与完整测试通过：2206 项中 2185 项通过、21 项门控跳过、0 失败或取消。未在本轮重新验收真实跨机器网络、Windows/macOS 原生目录窗口或线上部署；此前文档中的独立浏览器验证只作为既有证据保留。

## 关联

- [环境契约与已有验证记录](../../../../docs/modules/computers/environments.md)、[部署与兼容](../../../../docs/harness-server-deployment.md)、[目录选择](../../../../docs/project-directory-picker.md)。
- [纯环境投影](../../../../packages/app-harness/src/core/computer/environments.ts)、[worker 路由](../../../../packages/app-harness/src/core/computer/worker-router.ts)、[项目绑定](../../../../packages/app-harness/src/core/project/component.ts)。
- [环境投影测试](../../../../tests/computer-environments.test.mjs)、[多 worker 集成](../../../../tests/computer-worker-router.test.mjs)、[项目目录](../../../../tests/project-directories.test.mjs)、[网关和认证](../../../../tests/remote-harness-server.test.mjs)。
