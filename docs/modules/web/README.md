# 执行宿主与客户端接入

[模块导航](../README.md) · [部署说明](../../harness-server-deployment.md)

每个进程独立一个 Nya 根。`packages/host/src/` 拥有访问管理、监听器、HTTP 分派和浏览器外壳；执行设备连接与凭据各归应用私有组件；本机目录窗口归 `directory-picker` 基础适配；`packages/app-harness/src/` 的应用层拥有业务 HTTP、网关和 Anybox Harness 界面。distribution 默认客户端组合安装应用外壳并登记目录能力的惰性提供方；各应用打开时安装自己的连接与网关，按本代选中的可选能力条件注入目录服务，停止时独立清理。D0b 已按消费者装配目录基础适配，最后消费者实际退出后才卸载，不支持平台不执行工厂。浏览器代码、静态映射和路由函数没有单独组件身份。

Harness 独立服务另由应用自己安装 `harness-access` 并持有应用监听器，复用相同业务 HTTP 适配器；不导入宿主监听或认证实现。Anybox 托管组合仍由宿主认证、分派和活动保护。业务装配与进程边界见 [D0a.1 独立服务](../../application-standalone-services.md)。

Anybox Harness 的三栏工作区、目录树与文件标签由这些组件的浏览器入口实现，资源归属和恢复规则见[三栏工作区](../../harness-three-column-workspace.md)。

浏览器内部的 `web/session-menu.ts` 管理会话行三个点触发的悬浮操作菜单，包括视口定位、键盘焦点与临时监听清理；它由工作区创建和销毁，不新增 Nya 组件或服务。行为验证位于 `tests/session-menu.test.mjs`。

Anybox Harness 的模型设置由 `web/models-client.ts` 管理。模型能力、推理档位、模式及预算范围只读展示，实际原生生成参数仍可编辑。能力修正需停止所属执行设备的 Agent，在实际 Models JSON 配置中修改，再重新启动；界面保存也写入同一配置文件。界面与草稿规则见[Web 客户端设计](../../web-client-design.md)，格式及生效步骤见[模型 JSON 配置](../../harness-server-deployment.md#模型-json-配置)。浏览器控制器不新增组件。

| 组件 | 职责 |
| --- | --- |
| [Application HTTP](web-frontend.md) | 常驻认证、应用控制与按目录分派 |
| [harness server HTTP](harness-http.md) | Anybox Harness 业务路由、安全 DTO、Models 管理、通知 SSE |
| [Host Access](host-access.md) | 业务库实例身份、设备令牌摘要、撤销 |
| [Harness Access](harness-access.md) | Harness 独立服务自己的身份与认证，兼容原 host-access 数据和令牌 |
| [Harness Listener](harness-listener.md) | Harness 独立服务监听、认证请求、流式与保留操作退出，依赖撤销时关闭重绑 |
| [Client Connections](client-connections.md) | Harness 私有设备连接、系统凭据、配对、身份校验与转发，随应用启停 |
| [Client Shell](client-shell.md) | 常驻静态页面、应用目录与控制 HTTP |
| [Client Computer](client-computer.md) | 独立 worker 本机管理、只读状态与显式启动 |
| [Client Gateway](client-gateway.md) | Anybox Harness 内部连接与白名单转发、网络生命周期 |
| [Directory Picker](directory-picker.md) | 独立共享包的本机系统目录窗口，按兼容消费者装配与最后释放；各客户端应用在已确认本机设备上添加或选择项目时使用 |

已确认本机身份且平台支持时，“添加项目”直接打开系统目录窗口，确认后向固定目标登记；远程设备或原生能力未确认可用时，[应用内项目目录选择](../../project-directory-picker.md)由客户端视图、网关、harness server API 与既有 Projects 协作。声明 `projects.create-directory` 的目标支持在当前浏览目录下新建文件夹，创建后进入该目录，再选择登记；不新增组件。

执行入口 `packages/distribution/src/entrypoints/harness-server-main.ts` 和客户端入口 `packages/distribution/src/entrypoints/client-main.ts` 负责默认 Anybox Harness 组合；通用装配在 `packages/host/src/execution.ts` 与 `packages/host/src/client.ts`。执行进程不安装浏览器静态服务和目录窗口，客户端不安装 Models、Session 或 Run。`packages/distribution/src/entrypoints/serve.ts` 只启动并管理两个独立进程，关闭策略见部署说明。
