# Harness 独立部署与多设备连接

执行端支持 macOS / Linux，要求 Node.js >=22.13.0。每台设备独立运行一个 Harness，独立保存 Models、业务数据库与附件目录。本机客户端拥有独立 `client.sqlite` 与系统凭据命名空间，不需要本机 Harness 在线。

## 开发仓库启动

```sh
npm run harness:init
npm run web
```

初始化命令在业务库中建立稳定实例身份，并只在本次终端输出完整设备令牌。将令牌填入浏览器的「连接管理」；本机默认服务地址 `http://127.0.0.1:3001`，客户端页面 `http://127.0.0.1:3000`。配对成功后完整令牌只保存在客户端系统凭据库。浏览器不保存令牌。

分别启动时使用 `npm run harness` 与 `npm run client`。`npm run web` 启动两个独立子进程；Harness 初始化失败时客户端仍启动。停止组合命令会关闭其启动的两个应用。关闭浏览器或单独客户端服务不会取消任何远端 Run；重新连接通过原实例和幂等键补查。取消 Run 是单独的显式操作，没有远程关闭 Harness 的接口。

首次使用时在选定设备的「设置 → 模型服务」配置模型 Key，然后为该设备登记项目。远程项目输入**目标机器的绝对路径**。`ANYBOX_PROJECTS='["/srv/my-project"]'` 可预登记项目。只有组合启动器确认的本机实例可使用原生目录窗口，独立客户端和远端采用路径输入。

## 可独立安装的发行物

仓库开发可使用相邻 NyaCore；发行物将构建后的 Nya、Models（含离线目录快照）和 api-key-manager 打成固定 tarball，不保留相邻目录依赖。

```sh
npm run release -- /tmp/anybox-app-release
# 复制整个发行目录到目标机器，再在目标机器执行：
npm ci --omit=dev
npm run harness:init
npm run harness
```

输出目录必须为空。`package-lock.json` 固定全部直接、间接与平台可选依赖，`release.json` 记录内置包完整性和锁文件 SHA-256。目标机器运行 `npm ci` 准备匹配平台和架构的 keyring、sharp 等原生依赖；不要直接复制另一种平台的 node_modules。目录快照随 Models 包携带，普通构建与测试不更新快照。

## 配置与持久目录

| 环境变量 | 默认值 / 用途 |
| --- | --- |
| `ANYBOX_HARNESS_BIND` | `127.0.0.1`，推荐由同机反向代理接入 |
| `ANYBOX_HARNESS_PORT` | `3001`，执行 API 端口，0 为临时端口 |
| `ANYBOX_HARNESS_NAME` | `Anybox Harness`，实例显示名称 |
| `ANYBOX_HARNESS_DATABASE` | `./data/harness.sqlite`，含 `host-access` 独立迁移域 |
| `ANYBOX_MODELS_DATABASE` | `./data/models.sqlite`，模型配置 |
| `ANYBOX_MODELS_CATALOG_DATABASE` | Models 配置库旁的 `models-catalog.sqlite` |
| `ANYBOX_IMAGE_ASSETS_DIRECTORY` | `${harnessDatabasePath}.images`，原字节 |
| `ANYBOX_PROJECTS` | `[]`，JSON 绝对路径数组 |
| `ANYBOX_MODELS_NAMESPACE` | `anybox.models`，模型凭据 |
| `ANYBOX_CLIENT_DATABASE` | `./data/client.sqlite`，客户端连接记录 |
| `ANYBOX_CLIENT_NAMESPACE` | `anybox.client`，客户端访问凭据 |
| `ANYBOX_WEB_PORT` | `3000`，回环客户端页面端口 |

执行端三个 SQLite 文件与客户端数据库必须分开。客户端配置中只有令牌引用，没有完整令牌。业务库只存设备令牌 SHA-256 摘要；这些令牌均代表实例拥有者，Prompt 仍映射 `local-web-user`。不使用 dotenv。

Linux 的 Models 凭据和客户端凭据要求用户 D-Bus 会话中可用且已解锁的 Secret Service；禁止退回内核 keyring、文件或 SQLite。无桌面服务器需由运维准备 Secret Service 和解锁过程。凭据库不可用时仍可查看非秘密元数据，但不能读取 Key 或配对写入令牌。macOS 使用当前用户 Keychain。

## HTTPS 和进程服务

远端地址必须是 HTTPS。显式 `127.0.0.1` / `[::1]` 可使用 HTTP；不按域名解析或转发头推断本机身份。TLS 证书由外部反向代理管理，参考发行物中的 `deploy/nginx.conf.example`。SSE 必须关闭缓冲、缓存并保持长连接，图片请求大小不能小于 10 MiB。API 不信任代理注入的业务用户身份。

`deploy/anybox-harness.service.example` 为 Linux 用户级 systemd 示例。按实际 Node 路径和安装目录修改，准备凭据服务后安装到 `~/.config/systemd/user/`，再用 `systemctl --user daemon-reload` 和 `systemctl --user enable --now anybox-harness` 启用。`KillMode=control-group` 清理异常退出后留下的 Bash 子进程；正常停止先等 Harness 取消、实际退出和结算。超时强杀后的遗留 Run 下次启动标记 `interrupted`，不会重放外部副作用。

## 令牌管理与恢复

所有执行接口要求 Bearer。`GET /api/v1/instance` 返回身份、名称、API 版本和能力；后续业务请求还必须携带 `X-Anybox-Instance-Id`，在处理业务前核对身份。

认证后的 `POST /api/v1/access/tokens {"name":"Laptop"}` 发行设备令牌并只返回一次完整值；GET 同路径只列元数据；`POST /api/v1/access/tokens/:id/revoke {}` 幂等撤销，关闭该令牌的观察连接、拒绝后续请求，保留已接受 Run。客户端「连接管理 → 访问令牌」提供同样操作。

丢失全部有效令牌时停止服务，再执行 `node dist/host/harness-main.js recover-access "Recovery device"`。命令必须取得数据库排他锁，在线服务仍运行时拒绝恢复。正常重启、同一实例的备份恢复保留 instanceId；复制数据创建另一台独立实例时，停机执行 `node dist/host/harness-main.js new-identity "New owner"`，生成新身份并撤销全部继承令牌，然后按新实例配对。

## 旧数据与异常恢复

Session、Models 与附件原有格式不因部署拆分改变。业务 SQLite 使用实际取得且跨事务保留的 `locking_mode=EXCLUSIVE` 锁；进程退出即由 OS 释放。若存在旧版无所有者 `.lock` 目录，**在打开数据库前拒绝启动**。停止所有旧宿主、离线确认没有持有者、备份数据库后，由运维显式移走该旧目录；应用不会猜测并自动删除。

浏览器新状态以 instanceId 限定项目、会话、资源和模型；连接 ID 只负责本机路由。旧键完整保留。只有组合启动器确认本机身份，且旧会话与项目在该实例验证匹配后，才复制旧布局、草稿、位置和 pending 到新命名空间；无法确认时保留待确认提示，不重发旧 pending。未知请求结果始终向原实例查询。

## 验证入口与验收限制

运行 `npm run check`。新增测试覆盖身份持久化、摘要、撤销、凭据写入失败、实例替换、网关认证覆盖、客户端退出后任务继续、幂等查回、多实例同 ID、四面板布局、旧状态迁移、进程强杀锁释放、失败启动释放资源和模块依赖方向。

`ANYBOX_KEYRING_TESTS=1` 执行真实系统凭据测试；`ANYBOX_DEPLOYMENT_TESTS=1` 执行当前 macOS/Linux 进程、图片和客户端/执行端凭据实际操作验收。应分别在 macOS 与无桌面 Linux 运行并保存结果。普通检查跳过的真实平台或真实模型联网测试不代表已通过；模拟三个实例也不能替代真实跨机器 HTTPS 与系统服务部署验收。
