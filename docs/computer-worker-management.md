# Computer worker 独立管理

[文档首页](README.md) · [运行角色](runtime-roles-and-distribution.md) · [部署](harness-server-deployment.md) · [客户端组件](modules/web/client-computer.md)

Computer worker 可以由本机客户端或命令行直接管理，无须安装、打开或连接本机 harness server。worker 独占执行账本、附着记录与系统凭据，管理端只读取私有回环 endpoint 并发送请求，不打开 worker 数据库，也不安装 Models、Session 或 Run。

## 桌面与 Web 客户端

打开 Anybox Harness 的“管理连接”，点击“管理本机 Computer worker”。这个入口始终指向**客户端服务所在设备**，与选择的远端连接无关；浏览器部署在另一台机器时，也不会操作浏览器所在机器。

1. 读取状态不会启动 worker；未运行时明确点击“启动 Computer worker”。当前平台必须具备随包原生进程后端；Windows 使用原生 Job Object，无需 WSL，缺少或架构不匹配时才禁用启动。
2. 在目标 harness server 的“单元附着”设置生成 Computer 附着码。
3. 在本机管理入口填写目标 HTTPS 地址、附着码和目录／工具上限。仅回环地址允许 HTTP。附着码提交即从输入框清除；网络结果不明时先刷新状态，不自动再次消费。
4. “刷新状态”显示 worker 身份、附着及 connected / connecting / offline / instance-mismatch / revoked 状态与最近错误。
5. “配置权限”可修改目录和工具上限；不限需明确勾选，未勾选且列表为空表示不允许。保存会暂停该附着准入，持久化新上限，取消并等待其当前工具退出，再开放新请求。已接受事实和历史保留。这里的目录是项目／工具接纳上限，不是操作系统文件沙箱；远端已批准的 scope 仍约束远端可发起的工作，扩大本地上限不会自动扩大远端授权。
6. “撤销附着”先在本机阻止新调用、取消并排空该附着的 Run、删除系统凭据，再尽力通知远端；远端离线也能本地撤销。撤销后重新连接需要新附着码。

关闭面板、客户端或桌面只结束管理观察，不停止独立 worker，也不撤销附着。worker 故障不会由状态查看自动重启；需要显式启动，常驻部署使用独立系统服务管理器。

桌面固定使用用户数据目录下 `data/harness.sqlite.computer-worker`，与已有本机执行角色共用同一 worker 实例。独立客户端的默认目录为 `${ANYBOX_HARNESS_DATABASE ?? './data/harness.sqlite'}.computer-worker`，可通过 `ANYBOX_COMPUTER_WORKER_DIRECTORY` 指向已经部署的 worker。该变量只为客户端选择管理目标，不修改 harness server 的 worker 配置。目录沿用既有格式，未迁移或合并任何数据库。

## 无界面命令

构建后使用 `node dist/entrypoints/anybox-main.js computer-worker …`；源码启动也可用 `npm run computer:worker -- …`，后者会先构建。

```sh
# 前台运行，适用于系统服务（旧形式 <directory> 仍兼容）
node dist/entrypoints/anybox-main.js computer-worker serve ./data/worker
# 明确启动后台进程或复用现有实例
node dist/entrypoints/anybox-main.js computer-worker start ./data/worker
# 只读，不创建数据目录或启动进程
node dist/entrypoints/anybox-main.js computer-worker status ./data/worker
# 已运行的 worker 消费标准输入中的 JSON
node dist/entrypoints/anybox-main.js computer-worker attach ./data/worker
node dist/entrypoints/anybox-main.js computer-worker permissions ./data/worker <attachment-id>
node dist/entrypoints/anybox-main.js computer-worker revoke ./data/worker <attachment-id>
# 停止全部附着服务，取消并等待 worker 工具及根清理
node dist/entrypoints/anybox-main.js computer-worker stop ./data/worker
```

`attach` / `permissions` 必须通过管道提供 JSON 标准输入；直接以交互终端调用会提示输入方式。附着码不作为命令行参数，不在输出中回显。输出为非秘密 JSON，错误退出码为 1。attach / permissions / revoke 要求 worker 已运行，不隐式启动它。

`attach` 输入：

```json
{"harnessUrl":"https://harness.example.com","code":"<一次性附着码>","ceiling":{"kind":"computer","projects":["/work/project"],"tools":["anybox.bash"]}}
```

`permissions` 输入是 ceiling 本身：

```json
{"kind":"computer","projects":["/work/project"],"tools":["anybox.bash","anybox.apply_patch"]}
```

目录必须是执行设备上的绝对路径。`"all"` 表示不限，`[]` 表示不允许。使用交互输入或受信管道提供附着码，不需要把凭据写入文件；正式单元凭据仍仅存在 worker 的系统 Vault（`ANYBOX_COMPUTER_WORKER_NAMESPACE`，默认 `anybox.computer-worker`）。

## 生命周期与兼容

管理请求固定一次连接，不自动重放附着、权限修改或撤销。关闭管理观察只中止等待；worker 已接纳的管理变更继续完成，应重连查询实际状态。权限变更与撤销按附着串行，不允许并发修改恢复已撤销的记录。worker 根关闭取消拨出请求，并等待在途管理操作、工具执行和存储退出。

`endpoint.json` 的回环令牌留在设备上，不返回浏览器或 CLI。既有 harness server `/units/local-computer/attachments` 路由保留兼容；新版本机管理界面不再调用它。远端拨出协议、attachment ID、epoch、数据库格式和持久凭据位置保持兼容。

验证入口：`tests/computer-worker-management.test.mjs`（真实存储、执行器、拨出与 HTTP 适配器，替换 OS 工具和远端 HTTP）、`tests/units-client.test.mjs`、`tests/runtime-roles.test.mjs`、`tests/native-worker-lifecycle.test.mjs`（真实原生 worker），完整检查 `npm run check`。原生平台验收记录见[平台支持](native-platform-support.md)，系统服务与交互用户进程的验证分别记录。

初次管理界面接入时曾在 Windows 客户端验证平台受限提示及 700px 窄窗口布局；该历史记录不再代表 Windows worker 的当前可用性。当前状态依据原生后端探测。现有 Classic 页面固定浅色；沿用其 token 与控件。
