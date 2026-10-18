# Harness 独立服务 HTTP 监听组件

[Web 与服务接入](README.md) · [Harness Access](harness-access.md) · [业务 HTTP](harness-http.md) · [独立业务服务](../../application-standalone-services.md)

`packages/app-harness/src/http/server.ts` 的 `createHarnessServerListenerComponent(root,{port?,host?})` 创建 `harness-listener`，提供 `harness.listener: HarnessServerListener`（`url` 与幂等 `close()`）。只注入 `harness.access`，不注入业务 HTTP 服务；每次业务请求在首次异步工作前通过根的 `get()` 捕获当前 `harness.http`，缺失返回 503。

组件拥有 TCP 监听 socket、生命周期信号、活动请求/响应、请求体读取与保留操作集合、令牌撤销订阅。`apply` 启动监听并返回，不长期阻塞。配置端口 `0` 分配临时端口，默认回环地址；HTTP 实例响应合并本应用实际业务能力，不声明宿主产品管理能力。

拥有者请求使用现有 Bearer 格式，除实例查询外要求 `X-Anybox-Instance-Id` 匹配。它提供 `/api/v1/instance`、令牌管理以及 `/api/v1/apps/agent`；原项目、Session、Run、Models、Prompt 等旧 `/api/v1` 别名继续委托同一业务适配器。单元路径只在应用的规范前缀下可达，交由 Harness 单元组件认证；设备令牌不能替代单元凭据。没有 Anybox 页面、静态外壳或应用管理接口。

`close()` 同步停止新请求、发送取消信号并终止未完成请求体，等待请求、SSE、socket 和 `retainUntil()` 的保留操作实际退出。撤销关闭所属 actor 的响应，不自动取消已接受 Run。Effect 使用同一关闭操作，等待监听资源释放后才允许访问依赖清理。

独立服务先安装访问与监听，再安装业务。监听器不依赖业务 HTTP，根的清理顺序可以先取消业务 Run，再等待监听器保留的请求退出；访问依赖撤销则由 Nya 关闭并重绑监听。`prepareClose()` 先启动监听关闭和业务准入关闭，`close()` 并行等待整根清理与 HTTP 排空，不能先等待 HTTP 再取消 Run。业务运行时不拥有独立监听器，Anybox 注册时不安装此组件。

验证入口：独立服务认证/SSE/取消/根关闭与依赖重启测试、隔离安装测试以及根 `npm run check`。退出需确认端口和数据库锁释放；配置、命令及数据兼容详见[独立业务服务](../../application-standalone-services.md)。
