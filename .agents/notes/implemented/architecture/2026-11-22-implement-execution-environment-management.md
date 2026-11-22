# Agent Note: 实施 Agent 执行环境管理

Status: implemented

## 问题

用户要求在独立分支实施执行环境管理设计。运行时需要将 Agent 授权与工具偏好分别保存，对每次函数调用和托管搜索的实际出站进行准入，并能解释撤权后的在途状态。

## 方向

新增共享包 `@anybox/execution-environments`，由两款应用各自在执行端装配。目录、授权与偏好、环境选择与 Run 绑定、逐操作准入和设置视图可以复用。保留两款应用的独立存储、连接、凭据和工作目录。模型协议驱动在实际 HTTP 发送处校验清单。执行库升级到布局 2，以主库、独立检查点与旧程序已有的锁识别规则约束降级和离线恢复。

## 备选方案

仅共用界面无法覆盖后台执行；跨应用共享凭据和授权会改变资源所有权。保留已有资源提供方与历史读取，替换重复的管理和准入路径。

## 影响与代价

Anybox Harness 0.1.7 和 Personal Agent 0.2.1 的执行角色要求宿主的 `storage.sqlite` 1.1.0。首次打开受管执行端会升级执行库。提供方配置或 Key 变化后要重新授权该搜索目标。旧 Run 仍保留历史，不能证明的原调用或退出保持未确认。普通会话冻结声明，Personal Agent 连续会话可以显式采纳新环境。设计检查点为 `b3f68c3`，实施分支为 `codex/agent-execution-environments`。

## 验证

- 最终 `npm run check` 通过类型检查与构建，2449 项测试中 2431 项通过，18 项跳过，0 失败、0 取消。暂存差异已通过 `git diff --cached --check`。
- 从 `b3f68c3` 取出实际旧 SQLite 写入者创建数据库，在升级、正常退出后，用同一旧代码重开被拒绝。当前存储测试另验证恢复较旧的 v1 和 v2 主库、检查点缺失与切换失败后的已排队写入。
- 四种真实协议驱动连接本机 HTTP 对端，核对空授权、函数声明、匹配的搜索、恢复及提供方修订在发送前变化。使用基线版本产生的四份[退役工具历史样本](../../../../tests/fixtures/retired-native-plans/)验证保留历史及拒绝新调用。
- 两款应用的 HTTP 网关在同一个宿主上运行，验证相同 Agent ID 的授权、偏好和变更回执互相隔离。真实 worker 与服务端 SIGKILL 用例覆盖原操作查回、退出未知、重新附着与清理。无外部模型费用。浏览器使用无头 Chromium 验证选择、保存与回读。
- 在 macOS arm64 上构建两款应用的完整本地安装目录，校验文件索引、浏览器资源闭包及共享运行时。未在生产实例安装，没有进行 Windows/Linux 桌面实测。整组历史备份的离线恢复要求见[存储手册](../../../../docs/modules/infrastructure/local-sqlite.md)。

## 关联

- [设计稿](../../../../docs/agent-execution-environments-design.md)
- [执行环境手册](../../../../docs/modules/tools/execution-environments.md)
- [前项设计记录](2026-11-22-agent-execution-environment-management.md)
- [后续：按实际工具目标确认退出与恢复](../bug-fix/2026-11-22-tool-environment-target-exit-proof.md)
