# 独立后台服务

[文档首页](README.md) · [运行角色](runtime-roles-and-distribution.md) · [桌面打包](desktop-packaging.md)

`anybox service install/start/stop/status/uninstall` 管理客户端服务、harness server 或 Computer worker 的独立实例。安装只登记，启动必须显式操作。桌面退出不操作这些系统服务；卸载服务保留业务数据、附着记录和系统凭据。普通客户端启动和状态查询不会注册服务。

每个服务配置独立的名称、角色、工作目录和数据位置。配置只接受白名单非秘密环境设置；不接受 Key、密码、`NODE_OPTIONS` 或任意可执行入口。同一个数据目录不能同时由桌面、CLI 与系统服务持有。worker 与 harness server 分别安装和启动，先启动 worker 服务，再让 harness server 复用其 endpoint。服务 runner 标记进程归属；服务托管的 harness 在没有已运行 worker 时明确拒绝工具启动，不会将 worker 放进自己的 Job Object/cgroup。桌面与普通 CLI 保留原有按需启动能力。

## 入口与配置

成品中 Windows 使用 `resources/runtime/anybox.cmd`；Linux 使用 `resources/runtime/anybox`；macOS 使用 `Anybox.app/Contents/Resources/runtime/anybox`。这些入口使用随包 Node，无需系统 Node/npm。源码开发可以使用 `node dist/entrypoints/anybox-main.js service ...`。

```json
{
  "formatVersion": 1,
  "name": "computer",
  "role": "computer-worker",
  "workingDirectory": "C:\\Users\\owner\\AnyboxService",
  "workerDirectory": "C:\\Users\\owner\\AnyboxService\\worker",
  "account": "DEVICE\\owner",
  "environment": {
    "ANYBOX_COMPUTER_WORKER_NAMESPACE": "anybox.computer-worker"
  }
}
```

`role` 可为 `client`、`harness-server` 或 `computer-worker`。只有 worker 需要 `workerDirectory`。客户端使用 `ANYBOX_CLIENT_DATABASE` / `ANYBOX_WEB_PORT`；harness server 使用现有 `ANYBOX_HARNESS_*`、`ANYBOX_MODELS_*` 和图片位置等非秘密设置。路径必须为绝对路径，工作目录须预先创建。Windows 的 `account` 必须显式等于安装命令的当前账户；Linux/macOS 使用当前用户，不读取这个字段。配置副本保存在该用户的 `.anybox/services/<name>/service.json`。

```text
anybox service install computer.json
anybox service start computer
anybox service status computer
anybox service stop computer
anybox service uninstall computer
```

## Windows

Windows 服务由随包 `anybox-service-host.exe` 接入 SCM。安装需管理员权限，服务账户需已有“作为服务登录”权限；安装器不修改账户权限，也不默认改为 LocalSystem。服务与桌面使用同一用户，保证 Credential Manager、私有 worker 目录及 endpoint 归属一致。密码通过标准输入的 `{"password":"..."}` 提供，安装器只经子进程私有 stdin 交给 `New-Service -Credential`；密码不保存到配置、命令行或环境变量。使用受信的安全输入流程提供它，不把密码写入命令历史或 JSON 文件。

私有标准输入与输出统一使用 UTF-8，入口按流增量解码，避免 PowerShell 5 默认代码页或跨块中文、重音字符、emoji 损坏账号、路径与密码。无效凭据 JSON 只报告固定错误，不回显解析片段。

SCM host 在启动 Node 前建立独占 Job Object。SCM Stop / Shutdown 通过私有 stdin 通知 Node；Node 先等待已接纳的启动，再调用相应宿主 `close()` 并等待真实清理，SCM 持续报告 STOP_PENDING，直到 Node 退出。没有停止超时后伪报成功的分支。host 异常退出时 Job Object 终止其拥有的 Node 和进程；独立 worker 服务有自己的 Job Object。服务日志在配置旁的 `service.log`。

如果只需要本机开发或桌面使用，不必注册服务：现有 Computer “启动”与 CLI `computer-worker start/stop` 已能独立运行。

## Linux 与 macOS 适配

Linux 写入当前用户的 `~/.config/systemd/user/com.anybox.<name>.service`，通过 `systemctl --user` 管理。每个服务独立 `KillMode=control-group`，正常停止不设强杀期限。Secret Service 必须在同一用户的会话中可用且已解锁。后台开机运行和无图形会话的用户服务环境需由设备管理员配置；不引入明文凭据后备。

macOS 写入 `~/Library/LaunchAgents/com.anybox.<name>.plist`，显式 start 才 bootstrap/kickstart 当前 `gui/<uid>` 域，stop 通过 bootout 清理。使用当前用户 Keychain。此入口不是系统级 LaunchDaemon，也不宣称登录前或无用户会话的 Vault 可用。系统级无头账户部署需要另行验收。

本轮用户验收范围是 Windows。Linux/macOS 的适配、纯行为测试和 CI 入口保留；未在本轮运行对应平台的真实服务管理器或成品，不应把配置生成测试当成平台验收。

## 测试与资源边界

`tests/platform-services.test.mjs` 覆盖配置拒绝秘密、Windows 密码只经 stdin、三平台安装不启动、停止等待启动和清理、卸载保留数据以及真实 Node service runner 的 worker 启动/停止/控制管道 EOF。服务管理器测试使用隔离 fixture，不在开发机注册真实服务。Windows SCM host 的构建与版本入口另行验证；真实 SCM 安装/账户登录/凭据验收需在明确授权的测试设备完成。

服务适配不是新的 Nya 组件。`service-runner` 仅选择现有应用工厂并持有其 close 句柄；组件依赖、资源归属、取消与清理由原有根负责。client/harness CLI 与服务共用环境工厂。组合开发启动器通过私有 IPC 停止子进程，避免 Windows `process.kill('SIGTERM')` 直接强杀而跳过清理。
