# Anybox CLI（预开发 v1）

`anybox` 是 distribution 的统一命令入口。它显式组合受信的应用 CLI 注册，仅在执行具体命令时导入该应用的执行模块。当前组合注册了 Anybox Harness；Claude Agent、Personal Agent 和未来应用未注册 CLI，因此不会出现在应用命令列表中。磁盘上已安装包的自动发现尚未接入，不能把当前静态组合当作已经完成安装包 CLI 集成。

通用契约和解析器位于 `@anybox/application-api/cli`，Node 标准输入输出和进程信号适配位于 `/cli-node`。它们不导入 host、应用实现、Nya、Models 或业务存储。distribution 负责选择目录；Harness 自己负责目标、认证、HTTP/SSE 和业务命令。这里没有新增 Nya 组件或业务 Context。

## 入口与兼容

构建工作区后，distribution 的 npm bin 为 `anybox`，Harness 的独立 bin 为 `anybox-harness`。仓库内也可直接运行：

```sh
node packages/distribution/dist/entrypoints/anybox-main.js --help
node packages/distribution/dist/entrypoints/anybox-main.js harness agents list --json
node packages/app-harness/dist/entrypoints/cli-main.js agents list --json
```

`anybox-harness <args>` 把 Harness 注册挂在自己的根上，共用同一解析器、元数据和执行模块；执行上下文里的命令路径仍是 `harness …`。独立入口 `--version` 返回应用包版本，统一入口返回 distribution 版本。

既有 `anybox client`、`anybox harness-server …`、`anybox computer-worker …` 继续把参数原样传给原角色入口，保留原输出、退出处理和进程生命周期。旧角色必须放在第一个参数位置，`--json` 和本文的新退出码契约仅用于新 CLI 命令；旧角色不被包装为 JSON，也不自动改变其参数。`npm run client`、`harness:server`、`computer:worker` 等脚本保留。

## 显式配置 Harness 目标

CLI 是已有 harness server 的 HTTP/SSE 客户端。它不启动服务、不装配 Agent 运行时、不打开桌面业务 SQLite，也不读取桌面连接或 Models Vault。用户先独立启动服务，并通过现有服务访问管理取得令牌。

```sh
# 交互式终端隐藏输入令牌；令牌不放在命令参数中。
anybox harness target add local --endpoint http://127.0.0.1:3001

# 自动化时从安全输入来源提供一行令牌；输入到 EOF 后完成。
# 不把真实令牌写入脚本、命令参数或 shell 历史。
secure-token-source | anybox harness target add remote --endpoint https://harness.example --token-stdin --json

anybox harness target list
anybox harness target use remote
anybox harness target check
anybox harness target check local
anybox harness target remove local
anybox harness --target remote agents list --json
```

只接受隐藏终端输入或 `--token-stdin`，没有 `--token` 参数、令牌环境变量或令牌输出。非终端且未指定 `--token-stdin` 时拒绝添加。stdin 要求一行非空的 ASCII token，可带一个末尾换行。目标名最长 64 字符，只允许字母、数字、点、下划线和连字符，首字符为字母或数字。

端点必须是完整 HTTPS origin，或 `localhost` / `127.0.0.1` / `[::1]` 上的 HTTP origin，不含用户信息、路径、query 或 fragment。不跟随 HTTP 重定向。添加时认证查询 `/api/v1/instance`，成功后固定 instanceId 才保存；每个业务调用先复核实例，后续请求携带固定的 `X-Anybox-Instance-Id`。实例改变返回冲突，需要显式移除并重新添加。名称重复不覆盖。添加第一个目标时选中；移除选中目标后清空选择，不自动切换其他设备。

默认配置文件：

| 平台 | 路径及支持情况 |
| --- | --- |
| Linux | `$XDG_CONFIG_HOME/Anybox/harness-cli/targets.json`；未设置绝对 XDG 路径时用 `~/.config/Anybox/harness-cli/targets.json` |
| macOS | `~/Library/Application Support/Anybox/harness-cli/targets.json`；尚未实机验收 |
| Windows | 预留 `%APPDATA%/Anybox/harness-cli/targets.json`；目标存储暂拒绝操作，等待 Windows ACL 适配 |

`ANYBOX_HARNESS_CLI_CONFIG` 可显式覆盖配置文件路径，相对路径以本次 cwd 解析。这个文件包含应用自有的连接 token 原文，目录为 `0700`、文件为 `0600`，读取时核对所有者及权限并拒绝配置文件或直接父目录的符号链接；不把 POSIX mode 当作 Windows ACL 保证。写入使用独占 `.lock`、同目录私有临时文件、sync 和原子 rename。锁遗留时不根据 PID/时间自动删除；确认旧写入者已经退出后才能手工移除锁。`target list` 仅返回名称、地址、实例和选中项，不联网。所有命令均不显示保存的 token；远端正文中反射出的当前 token 也会脱敏。

## Harness 命令

| 命令 | 参数与行为 |
| --- | --- |
| `target add <name>` | 必填 `--endpoint`；可选 `--token-stdin`；认证成功才保存 |
| `target list/use <name>/check [name]/remove <name>` | `list` 无位置参数；`check` 可使用 `--target` 或位置目标名 |
| `agents list` | 查询目标 Agent 列表 |
| `models list` | 查询可运行模型配置，不刷新目录、不调用模型 |
| `projects list` | 查询服务器已有项目；不创建本机项目 |
| `session list --project <id>` | 查询指定项目的未归档会话 |
| `session show <id>` | 查询会话元数据；不输出完整对话树 |
| `session create --project <id> --agent <id> [--model <id>]` | 创建会话；服务端当前没有创建幂等键，未知结果不能盲目重试 |
| `run start <sessionId>` | 必填 `--parent <nodeId或root>`、`--request-id <key>`；`--input <text>` 和 `--stdin` 二选一，可选 `--model`、`--detach` |
| `run show <runId>` | 查询 Run 快照；即便业务状态失败，成功查询仍退出 0 |
| `run watch <runId>` | 观察到终态；completed 退出 0，其他终态退出 8 |
| `run cancel <runId>` | 显式请求取消，返回当前状态；用 watch 等实际退出 |
| `run find <sessionId> --request-id <key>` | 通过原幂等键查询服务器已接受的 Run |

业务命令可在 `harness` 后使用 `--target <name>`，未提供时使用已选目标。`session create` 和 `run start` 只提交到已有服务器；Agent 工具配置和会话工具快照继续由服务器既有规则决定。`session create`、`run start`、`run cancel` 均不自动重试写入。

```sh
anybox harness session create --project PROJECT --agent assistant --json
printf '%s' '解释这个项目的结构' | anybox harness run start SESSION \
  --parent root --request-id first-question --stdin --json
anybox harness run start SESSION --parent NODE --request-id second-question \
  --input '继续说明这个节点' --detach --json
anybox harness run find SESSION --request-id first-question --json
anybox harness run watch RUN --json
anybox harness run cancel RUN --json
```

`root` 明确映射为可空父节点 `null`；不猜测会话 head，不隐式接续最新成功节点。输入保留服务端既有文本规则。stdin 最多读取 1 MiB，序列化后的 JSON 请求仍必须满足服务器现有 65,536 字节限制；过大时本地拒绝，不发送请求。

`run start` 先输出带 sessionId/requestId 的 `request` 信封，再发送唯一一次 POST。`request` 不表示服务器已接受。`--detach` 成功后输出 `accepted` 并退出；未 detach 则观察权威 Run 快照。请求丢失、超时或成功写入的响应损坏均返回 `unknown-outcome` / 退出 7；保留原 request-id，用 `run find` 查询，不生成新键或自动重发。显式再次 start 仍由服务端既有同键同输入幂等规则判定。

watch 查询初始快照，以 SSE 的连接、数据和断开为查询提示，并每秒兜底查询；连续提示最多约每 100 ms 一次查询。SSE 正文不被当作 Run 状态、不使用 Last-Event-ID、不拼接 token delta 为历史，不消费可重放日志。订阅每 10 秒续建；每次重连/EOF 都触发查询。订阅失败仍通过查询补齐；权威查询失败则退出，之后可重新 watch。HTTP JSON 请求超时 15 秒，响应最多 8 MiB。退出观察会取消并等待本 CLI 的订阅、查询及输入清理，不取消服务器已接受的 Run；只有显式 cancel 请求业务取消。

## 参数、输出和退出码

全局 `--help` / `-h`、`help <path>`、`--version`、`--json` 都只依赖静态目录，help、版本和补全不加载应用执行模块。字符串选项支持 `--name value` 与 `--name=value`；布尔选项不接受值；重复/未知选项、缺失必填参数、额外位置参数返回 usage 错误。`--` 后按位置参数读取，避免把以 `-` 开头的字面量误认为选项。错误信息不回显原始参数。

补全提供与 shell 无关的静态候选，一行一个；`--json` 则返回字符串数组。输入为已完整输入的命令路径，不提供磁盘/网络查询或动态资源 ID 补全，shell 可在本地过滤当前前缀：

```sh
anybox completion
anybox completion harness run
anybox completion harness run start --json
anybox-harness completion run
```

`--json` 下 stdout 为 UTF-8 NDJSON，每行独立 JSON，固定 `schemaVersion: 1`。只读命令通常一行，start/watch 可以多行。错误信封写 stderr；业务终态失败已写出快照，退出 8 不再虚构一份 HTTP 错误。交互隐藏输入的提示仍写 stderr，自动化使用 `--token-stdin` 避免提示混入。

```json
{"schemaVersion":1,"type":"result","data":[]}
{"schemaVersion":1,"type":"request","data":{"sessionId":"s1","requestId":"k1"}}
{"schemaVersion":1,"type":"accepted","data":{"id":"r1","sessionId":"s1","status":"running","revision":1}}
{"schemaVersion":1,"type":"snapshot","data":{"id":"r1","sessionId":"s1","status":"completed","revision":2,"output":"answer"}}
{"schemaVersion":1,"type":"error","error":{"code":"target-not-found","message":"Configure or select a CLI target first","exitCode":4}}
```

| 退出码 | 含义 |
| --- | --- |
| 0 | 命令成功；detach 只表示提交已获确认 |
| 1 | 内部/未分类错误；不输出原始异常或堆栈 |
| 2 | 参数、输入或已知请求格式错误 |
| 3 | 认证或权限拒绝（HTTP 401/403） |
| 4 | 目标或远端资源不存在 |
| 5 | 配置写锁、实例更换或服务器冲突 |
| 6 | 网络、服务、重定向、限流、损坏响应或不支持的平台存储 |
| 7 | 写入结果未知；不自动重试 |
| 8 | start/watch 观察到 failed、cancelled 或 interrupted |
| 130 | SIGINT/SIGTERM 或输入取消；已接受 Run 继续 |

非 JSON 模式以格式化 JSON 展示业务数据，help 和版本有文本格式；首版没有表格美化或逐 token 文本输出。

## 应用接入契约

应用导出一个轻量 `ApplicationCliRegistration`，静态元数据不能间接导入业务模块。`contractVersion: 1` 固定协议代次，`appId` 为应用身份，`command` 为名称/描述/参数/选项/子命令树，`load()` 只在最终叶命令执行时调用。目录拒绝重复 appId、命令名、子命令和继承选项冲突，并冻结元数据快照。distribution 对旧角色名另作保留。

```ts
import type { ApplicationCliRegistration } from '@anybox/application-api/cli'
export const cli: ApplicationCliRegistration = {
  contractVersion: 1,
  appId: 'miao',
  command: {
    name: 'miao', description: 'Miao application',
    commands: [{ name: 'status', description: 'Read application status' }],
  },
  load: () => import('./cli/commands.js'),
}
```

执行模块导出 `execute(invocation, context)`，收到规范命令路径、解析后的选项和位置参数。context 提供异步 stdout/stderr 写入、可迭代 stdin、只读 env/cwd、取消 signal、可选隐藏输入和 `emit(data, text?, type?)`。结构化数据必须为 JSON 值；用 emit 遵守信封，不能在 JSON 模式夹入自由文本。执行函数 resolve 表示所属资源确实退出；框架不假定 Promise 结束能代替应用清理。

预期错误使用 `cliFailure(code, safeMessage, cliExit.*, safeDetails?)`，只放安全信息；未知错误被框架统一脱敏。显式失败码来自 `cliExit`；不能返回任意整数。应用负责 HTTP、凭据、业务取消与实际退出；框架只传播信号。standalone 入口调用同一 `runNodeCli(args, registrations, { name, version, application: 'miao' })` 即可挂载单应用，无需复制命令实现。

新增应用需要同时把轻量注册加入 distribution 的 `applicationClis`；未注册的应用不列出。宿主包、Products 和应用安装服务不需要知道其业务命令。

## 验证与后续

测试入口：`packages/application-api/tests/cli.test.mjs`、`packages/app-harness/tests/cli.test.mjs`、`packages/app-harness/tests/cli-server.test.mjs`、`packages/distribution/tests/cli-framework.test.mjs`。真实服务集成使用临时 SQLite/Models JSON、内存凭据、禁用目录联网和受控假模型；无 keychain 或真实模型调用。完整检查为 `npm run check`，本轮实际结果和环境限制见[框架记录](cli-predev-notes/2026-11-15-cli-framework.md)与[应用记录](cli-predev-notes/2026-11-15-harness-cli.md)。

后续单独设计服务端审批契约、按会话工具环境选择、桌面零配置共享、自动启动服务。还需把已安装应用 CLI 与耐久包身份/使用锚和卸载 guard 接通，补齐 Windows ACL、真实终端信号/隐藏输入与各平台实测；当前 help/元数据契约不能替代这些加载安全条件。应用安装归档格式本轮没有新增 cli 入口字段。
