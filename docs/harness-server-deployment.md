# harness server 独立部署与多设备连接

harness server 是 Anybox Harness 的通用服务端核心，可部署在本地设备或远端服务器。执行端支持 macOS / Linux，要求 Node.js >=22.13.0。命名与客户端边界见 [命名规范](naming.md)。每台设备独立运行一个应用宿主，在同一个根上按 Anybox Harness 打开目标装配内部 Models、Prompt 和 Agent 能力，并独立保存配置、业务数据库与附件目录。本机客户端拥有独立 `client.sqlite` 与系统凭据命名空间，不需要本机 harness server 在线。

## 开发仓库启动

```sh
npm run harness:server:init
npm run web
```

初始化命令在业务库中建立稳定实例身份，并只在本次终端输出完整设备令牌。通过 Anybox Harness 工作区侧栏的「管理连接」打开连接管理并填写令牌；本机默认服务地址 `http://127.0.0.1:3001`，客户端页面 `http://127.0.0.1:3000`。配对成功后完整令牌只保存在客户端系统凭据库。浏览器不保存令牌。

分别启动 harness server 与 Anybox Harness 客户端时使用 `npm run harness:server` 与 `npm run client`。旧 `npm run harness` 和 `npm run harness:init` 保留为服务端启动及初始化的兼容别名。`npm run web` 启动两个独立子进程；harness server 初始化失败时客户端仍启动。停止组合命令会关闭其启动的两个应用。关闭浏览器或单独客户端服务不会取消任何远端 Run；重新连接通过原实例和幂等键补查。取消 Run 是单独的显式操作，关闭远端进程仅由其宿主负责；Anybox Harness 连接管理通过「启动 Agent」「停止 Agent」显式控制对应设备的执行组件。

新安装显示代码注册的应用目录，正式目录目前提供 Anybox Harness。点击打开后直接进入项目与会话工作区，在侧栏「管理连接」中配对本地或远程设备，并启动对应 Agent；侧栏「执行设备」选择新增项目的归属及模型、Prompt 设置的管理范围，已有会话保持所属设备。已有 run-state 的安装在首次迁移时保留 Agent 运行目标。模型与 Prompt 管理统一从工作区「设置」进入，按所选设备管理，不提供独立功能页面或应用。选择设备不启动其执行组件，选择远程设备不启动本机执行服务。

添加项目时固定所选设备的身份和连接版本。组合启动器确认的本机实例且客户端平台支持时，直接打开系统目录窗口，确认后立即向固定目标登记，取消不登记，也不打开应用内对话框。远程设备、本机身份未确认或原生能力检查未确认可用时打开应用内目录选择器，首次定位**目标 harness server 运行账户的主目录**，可浏览、筛选或输入绝对路径跳转；原生窗口启动或登记失败通过通知显示，不自动回退或换设备登记。`ANYBOX_PROJECTS='["/srv/my-project"]'` 在 Agent 能力每次成功装配时幂等登记项目，包括首次在运行中启用。真实目录浏览要求客户端、网关与目标 harness server 升级；旧 API v1 harness server 缺少 projects.browse 时显示升级说明及应用内手动路径入口。没有数据库迁移，已有项目 ID、会话和资源保持不变。协议与资源边界见[项目目录选择](project-directory-picker.md)。

## 可独立安装的发行物

仓库开发可使用相邻 NyaCore；发行物将构建后的 Nya、Models（含离线目录快照）和 api-key-manager 打成固定 tarball，不保留相邻目录依赖。

```sh
npm run release -- /tmp/anybox-app-release
# 复制整个发行目录到目标机器，再在目标机器执行：
npm ci --omit=dev --include=optional
npm run harness:server:init
npm run harness:server
```

构建和发行都会验证登记的浏览器入口、相对依赖、MIME 与全部资源文件。输出目录必须为空。`package-lock.json` 固定全部直接、间接与平台可选依赖，`release.json` 记录内置包完整性和锁文件 SHA-256。目标机器运行 `npm ci --omit=dev --include=optional` 准备匹配平台和架构的 keyring、sharp、随包 ripgrep 等原生依赖；不要直接复制另一种平台的 node_modules。目录快照随 Models 包携带，普通构建与测试不更新快照。

## 配置与持久目录

| 环境变量 | 默认值 / 用途 |
| --- | --- |
| `ANYBOX_HARNESS_BIND` | `127.0.0.1`，推荐由同机反向代理接入 |
| `ANYBOX_HARNESS_PORT` | `3001`，执行 API 端口，0 为临时端口 |
| `ANYBOX_HARNESS_NAME` | `harness server`，新实例显示名称；已有实例名保留 |
| `ANYBOX_HARNESS_DATABASE` | `./data/harness.sqlite`，含 `host-access`、`app-products` 与各业务迁移域 |
| `ANYBOX_MODELS_CONFIG` | 当前 Models JSON 配置；默认 `./data/models.json`，或旧 Models 路径对应的 JSON 文件 |
| `ANYBOX_MODELS_DATABASE` | `./data/models.sqlite`，仅 JSON 不存在时的旧配置导入源 |
| `ANYBOX_MODELS_CATALOG_DATABASE` | 旧 Models 路径旁的 `models-catalog.sqlite`；独立覆盖 JSON 路径不移动它 |
| `ANYBOX_IMAGE_ASSETS_DIRECTORY` | `${harnessDatabasePath}.images`，原字节 |
| `ANYBOX_PROJECTS` | `[]`，JSON 绝对路径数组 |
| `ANYBOX_MODELS_NAMESPACE` | `anybox.models`，模型凭据 |
| `ANYBOX_CLIENT_DATABASE` | `./data/client.sqlite`，客户端连接记录 |
| `ANYBOX_CLIENT_NAMESPACE` | `anybox.client`，客户端访问凭据 |
| `ANYBOX_WEB_PORT` | `3000`，回环客户端页面端口 |

harness server 的端口规范变量为 `ANYBOX_HARNESS_PORT`；配置解析保留旧 `ANYBOX_WEB_PORT` 入口作为兼容回退。客户端继续使用 `ANYBOX_WEB_PORT` 配置自己的页面端口。

执行端 Models JSON、旧 SQLite 导入源、目录缓存、业务数据库与客户端数据库必须分开，不能共用文件或文件别名。客户端配置中只有令牌引用，没有完整令牌。业务库只存设备令牌 SHA-256 摘要；这些令牌均代表实例拥有者，Prompt 仍映射 `local-web-user`。不使用 dotenv。

Linux 的 Models 凭据和客户端凭据要求用户 D-Bus 会话中可用且已解锁的 Secret Service；禁止退回内核 keyring、文件或 SQLite。无桌面服务器需由运维准备 Secret Service 和解锁过程。凭据库不可用时仍可查看非秘密元数据，但不能读取 Key 或配对写入令牌。macOS 使用当前用户 Keychain。

### 模型 JSON 配置

Models 的非秘密配置直接保存在 JSON，默认路径为 `data/models.json`。`ANYBOX_MODELS_CONFIG` 指定当前文件；未设置时，从 `ANYBOX_MODELS_DATABASE` 的路径派生：`.sqlite` 或 `.db` 后缀替换为 `.json`，其他路径追加 `.json`。目录缓存的默认位置仍取旧 Models 路径所在目录，不随单独的 JSON 路径覆盖移动。

首次装配且 JSON 不存在时，从 `ANYBOX_MODELS_DATABASE` 导入旧 SQLite，保留 ID、不可变版本、能力、参数、连接、来源状态及凭据引用；旧库保留，后续以 JSON 为权威。已有 JSON 损坏时拒绝启动，不退回旧库。密钥值始终保存在系统 Vault，文件只保存引用和清理意图。

模型设置只读展示工具、流式、图片输入、服务端搜索与推理能力，包括推理档位、模式和预算范围。推理能力为“支持”表示模型可以使用推理；实际启用方式和档位由可编辑的原生生成参数与提供方默认行为决定。

人工修正能力时，先在所属执行设备的「管理连接」中停止 Agent，打开 JSON，在 `configurations` 数组中按 `id`、`connectionId` 和名称定位模型配置，只修改该项的 `capabilities`。例如推理声明可为：

```json
{
  "support": "supported",
  "efforts": ["low", "high"],
  "modes": ["enabled", "disabled"]
}
```

实际模式与档位须符合模型和协议；`support` 只接受 `supported`、`unsupported`、`unknown`，预算声明使用 `budget: {"min": ..., "max": ...}`。不要修改 ID、关联、修订号、版本、时间、凭据引用、epoch、来源账本、历史或删除账本，也不要直接增删记录；连接删除仍通过管理界面完成，以便清理系统凭据。来源拥有的定义继续由目录维护，目录刷新不覆盖已保存配置能力。完整文件结构见 [JSON 配置存储](modules/models/json-store.md#文件与管理契约)。

保存后重新启动该设备的 Agent，或重启 harness server。启动校验合法修改并自动生成新配置版本；地址或认证方式修改还会更新 `historyScopeEpoch`。格式、关联或身份错误保留文件并拒绝启动；与原生参数冲突的能力不能用于执行。关闭浏览器界面或刷新页面不会重新加载文件，运行中无文件监听器；外部改文件后后续保存会报告冲突，避免覆盖修改。已打开 execution 和历史保持原快照，后续执行使用重新加载的配置。

活动 Run 期间按既有规则拒绝停止 Agent。配置文件、保存队列、原子替换临时资源及 `${path}.lock` 所有权锁由 `models-json-store` 独占；正常关闭等待已接纳保存退出再释放锁。只在确认原进程不存在后回收遗留锁，无法确认的旧锁拒绝自动移除。升级前先关闭宿主并备份旧库，导入后将 JSON 一并纳入备份；旧代码不会读取新 JSON，回退需恢复对应备份。

## HTTPS 和进程服务

远端地址必须是 HTTPS。显式 `127.0.0.1` / `[::1]` 可使用 HTTP；不按域名解析或转发头推断本机身份。TLS 证书由外部反向代理管理，参考发行物中的 `deploy/harness-server.nginx.conf.example`。SSE 必须关闭缓冲、缓存并保持长连接，图片请求大小不能小于 10 MiB。API 不信任代理注入的业务用户身份。

`deploy/harness-server.service.example` 为 Linux 用户级 systemd 示例。按实际 Node 路径和安装目录修改，准备凭据服务后以 `harness-server.service` 安装到 `~/.config/systemd/user/`，再用 `systemctl --user daemon-reload` 和 `systemctl --user enable --now harness-server` 启用。`KillMode=control-group` 清理异常退出后留下的 Bash 子进程；正常停止先关闭应用准入，再等 harness server 取消、实际退出和结算。连接管理中的「停止 Agent」属于运行期控制路径：正在准备或执行 Run、写入或导入时拒绝停用；空闲时等待观察退出并卸载该 harness server 组件。宿主窄条的「停止应用」控制 Anybox Harness 客户端，其生命周期保持独立。超时强杀后的遗留 Run 下次启动标记 `interrupted`，不会重放外部副作用。

## 令牌管理与恢复

所有执行接口要求 Bearer。`GET /api/v1/instance` 返回身份、名称、API 版本和能力；后续业务请求还必须携带 `X-Anybox-Instance-Id`，在处理业务前核对身份。

认证后的 `POST /api/v1/access/tokens {"name":"Laptop"}` 发行设备令牌并只返回一次完整值；GET 同路径只列元数据；`POST /api/v1/access/tokens/:id/revoke {}` 幂等撤销，关闭该令牌的观察连接、拒绝后续请求，保留已接受 Run。客户端「连接管理 → 访问令牌」提供同样操作。

丢失全部有效令牌时停止服务，再执行 `node dist/entrypoints/harness-server-main.js recover-access "Recovery device"`。命令必须取得数据库排他锁，在线服务仍运行时拒绝恢复。正常重启、同一实例的备份恢复保留 instanceId；复制数据创建另一台独立实例时，停机执行 `node dist/entrypoints/harness-server-main.js new-identity "New owner"`，生成新身份并撤销全部继承令牌，然后按新实例配对。

## 旧数据与异常恢复

Session、Models 与附件原有格式不因部署拆分或产品停用改变。只读 Anybox Harness 应用定义来自代码，打开目标保存在各进程业务库 app-products v2 独立迁移域。停用保留全部领域数据；重新启用时重新建立组件运行代。执行端 Models 配置和系统凭据仅在打开所选 Agent 时初始化；客户端连接凭据仅在打开 Anybox Harness 时初始化。空应用外壳不启动 Models 目录刷新或图片目录。业务 SQLite 使用实际取得且跨事务保留的 `locking_mode=EXCLUSIVE` 锁；进程退出即由 OS 释放。若存在旧版无所有者 `.lock` 目录，**在打开数据库前拒绝启动**。停止所有旧宿主、离线确认没有持有者、备份数据库后，由运维显式移走该旧目录；应用不会猜测并自动删除。

浏览器新状态以 instanceId 限定项目、会话、资源和模型；连接 ID 只负责本机路由。旧键完整保留。只有组合启动器确认本机身份，且旧会话与项目在该实例验证匹配后，才复制旧布局、草稿、位置和 pending 到新命名空间；无法确认时保留待确认提示，不重发旧 pending。未知请求结果始终向原实例查询。

## 验证入口与验收限制

运行 `npm run check`。新增测试覆盖身份持久化、摘要、撤销、凭据写入失败、实例替换、网关认证覆盖、客户端退出后任务继续、幂等查回、多实例同 ID、四面板布局、旧状态迁移、进程强杀锁释放、失败启动释放资源和模块依赖方向。

`ANYBOX_KEYRING_TESTS=1` 执行真实系统凭据测试；`ANYBOX_DEPLOYMENT_TESTS=1` 执行当前 macOS/Linux 进程、图片和客户端/执行端凭据实际操作验收。应分别在 macOS 与无桌面 Linux 运行并保存结果。普通检查跳过的真实平台或真实模型联网测试不代表已通过；模拟三个实例也不能替代真实跨机器 HTTPS 与系统服务部署验收。

## 多应用宿主

源码中 `src/host/` 是不依赖具体应用的 Anybox 宿主，`src/applications/harness/` 是完整 Anybox Harness 应用。`src/entrypoints/` 组合正式目录，服务端规范命令为 `harness:server` / `harness:server:init`，保留 `harness` / `harness:init` 兼容别名以及 `client` / `web` 命令；通用宿主工厂显式接收应用目录。目录调整不改变 API 路径、稳定应用 ID、数据库迁移或浏览器持久格式，当前结构见[目录边界](harness-module-boundary.md)。

客户端与执行端分别通过受信目录注册应用，详见[接入说明](application-development.md)。应用默认关闭，按 ID 分别保存和恢复目标；移出目录不删除数据。Web 标签状态只保存在当前浏览器 sessionStorage。关闭标签不停止后台应用，显式“停止应用”成功后才卸载组件并清理标签。Anybox Harness 连接与目标控制在自身页面，修改连接不重载其他应用。服务端清理失败禁止本应用重装，需重启进程；其他应用保留自己的状态。
