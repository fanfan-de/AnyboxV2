# Claude Agent Client Gateway 组件

0.1.10 将应用私有 `GET /apps/claude-agent/account` 加入本机和远端共用的代理白名单；账号与额度数据只从所选执行目标读取，不从客户端机器猜测，不开放写入或认证凭据接口。`web/account.ts` 提供侧栏“账号与额度”面板、真实套餐、5 小时/每周进度、剩余百分比、当地重置时间、每秒倒计时与手动刷新；过期提示刷新而不自行归零。刷新期间清空旧数据，读取失败明确提示；切换目标、隐藏及 dispose 取消观察、清理计时器并忽略迟到结果，不保存账号到浏览器存储。

[Claude Agent 模块](README.md) · [本应用连接组件](client-connections.md)

## 职责与入口

向浏览器提供独立的受管本机目标、本应用私有远端连接管理和执行设备列表，把白名单内的请求转发到所选目标。本机使用应用自己的角色通道协议，远端使用本应用私有连接组件与访问凭据。连接组件和网关随本应用启停，不依赖 Harness。浏览器入口、资源清单与样式由 `client/registration.ts` 与 `client/assets.ts` 登记，不是组件。

| 项目 | 定义 |
| --- | --- |
| 源码 | [client/gateway.ts](../../../packages/app-claude-agent/src/client/gateway.ts) |
| 工厂 / Nya 名称 | `createClaudeAgentGatewayComponent({ localInstanceId?, localChannel? }, directoryPicker = false)` / `claude-agent-client-gateway` |
| 服务 | `claude-agent.gateway`（handle、幂等 close） |
| `inject` | `claude-agent.connections`（本应用私有连接）、`app.activity`；本代取得兼容目录能力时才加入 `host.directory-picker` |

本机/远端的业务白名单与页面激活语义保持一致；本机内部请求的执行、背压、取消和资源等待详见[本机执行组件](local-execution.md)。

客户端注册声明 required `storage.sqlite@^1.0.0` 与 optional `system.directory-picker@^1.0.0`。每代应用工厂根据冻结的能力版本元数据向网关传入 `directoryPicker`，组件只从本轮 `deps` 读取实际声明的服务。未取得时不留下必需目录依赖，`picker` 保持 undefined，应用使用自己的目录浏览或路径输入；即使根上有其他应用持有的目录服务，也不查找它作为跨版本后备。默认组合仅登记惰性提供方，首次兼容消费者打开时安装，最后消费者实际退出后才释放；不支持平台不会执行提供方工厂。

## 接口

路径相对 `/api/client/v1/apps/claude-agent`。正式受管角色取得 `localChannel` 后：

- `GET /local` 返回 `{ managed: true, instanceId, picker, device }`；`device` 为 `{ id: 'local', kind: 'local', name: '本机', instanceId, revision: 1 }`。对端尚未 ready 或退出时返回本机不可用状态 `local-execution-unavailable`，不要求用户添加本机连接。查询只描述对端，不打开 Claude 业务。
- `/local/v1/<path>` 通过应用私有协议访问同包执行端，业务 DTO 和 SSE 复用既有 handler；`POST /local/pick` 在本代取得兼容目录能力时打开本机目录窗口。客户端与执行端之间没有公开监听、设备令牌或本机 Vault 记录。
- `GET /connections` 保留应用自己的已保存远端连接列表，本机 `device` 不混入其中。远端继续通过 `/connections/:id/v1/<path>` 使用原有凭据转发；管理连接的新增、检查、删除不修改受管本机目标。

旧 distribution 完整发行没有 `localChannel` 时保留以下兼容接口：`GET /connections` 返回 `{ connections, localInstanceId }`（不含凭据）；`GET /local` 返回 `{ instanceId, picker, status? }`，`picker` 为真表示本代已取得且平台支持的目录能力在受信本机可用；`POST /connections/:id/pick {}` 只在该连接的 instanceId 等于受信本机身份（桌面配对或启动器 `localInstanceId`）且平台支持时打开宿主的系统目录窗口，返回 `{ path }`（取消为 null），先校验浏览器头中的预期实例与连接版本，窗口关闭后再次核对连接未变；远端设备或不支持的平台返回 403 `picker-unavailable`，窗口占用 409 `picker-busy`，其余失败 503 `picker-unsupported` / `picker-unavailable`。`/connections/:id/v1/<path>` 经本应用 `client/connection-proxy.ts` 的 `forwardConnectionRequest` 转发。白名单仅 `GET /instance`、`GET /products/claude-agent`、`POST /products/claude-agent/(open|stop|retry)` 和 `/apps/claude-agent/` 下的 `environment`、`threads`、`events`、`projects/recent`、`models`（只读当前 Claude 环境的可选模型，`cwd` 为项目查询参数）、`models/recent`、`directories`（`path`/`showHidden` 为正常查询参数）、线程、Run 与审批路由；保留查询参数绑定一律拒绝，`.`/`..` 段拒绝。每个请求登记本应用的 Activity 租约（POST 阻止停止）。

## 执行、取消与清理

本机转发等待私有通道请求、帧观察及 handler 实际退出，远端转发等待双向管道实际退出；两者断开都只结束观察，不取消执行端已经接受的 Run。Effect 中止并等待在途转发，包括正在打开的目录窗口请求（窗口进程由目录提供方等待，应用退出完成后才释放其消费租约）。设备身份与版本由浏览器头固定，变化返回 409。

浏览器项目选择按需在原生 dialog 中打开，为每次系统目录窗口、路径校验和目录读取持有独立取消信号；关闭窗口、隐藏界面、切换设备或销毁面板时中止请求。即使宿主的结果已经在途，旧请求的结果、错误与按钮恢复也只属于原请求，不能修改新设备的项目选择。

浏览器每次激活界面都重新读取本应用连接记录、本机身份与设备能力，正式受管本机角色就绪后，切回界面即可通过 `/local` 发现；旧兼容客户端则在显式启动并配对后发现对应连接。`select`、`restore` 与路由激活只读取执行设备状态；只有显式 `open` 或“启动 Claude Agent”允许启动该设备上的应用。当前连接的 ID、实例、版本与地址未变时，刷新复用当前设备与线程、Run 订阅和未发送输入；单次能力或状态探测失败不会把仍保存的当前连接当作删除。设备明确回答不再支持 Claude Agent、连接被删除或身份发生变化时，中止旧设备代的请求与订阅，再按最新目录选择设备，未发送的提示词仍保留。

连接发现与激活意图按请求代取消：后续激活、手动切换设备或隐藏界面会撤销旧发现/启动意图，旧结果不能覆盖新设备，也不能在隐藏后继续启动应用；已有线程的 Run 观察继续保留。销毁界面停止请求准入、中止发现和设备请求、清空自身 DOM，并等待已登记的请求返回。

浏览器工作区的导航、Markdown、工具摘要和草稿属于现有 Web 控制器，不新增 Nya 组件。草稿按设备实例和会话保存在页面内存；任一未发送草稿与在途提交阻止 `canClose`，独立草稿窗口可显式丢弃无法再打开设备的草稿。迟到提交回执只修改原会话，不覆盖后来选中的会话或新草稿。详情见 [Web 界面](../../claude-agent-design.md#web-界面) 和 [界面审计](../../claude-agent-ui-audit.md)。

## 失败与兼容

连接不存在 404，实例不匹配/版本变化 409，上游不可达 502 `connection-unavailable`，应用未打开 503。本应用自己的“管理连接”调用 `POST /connections` 保存连接，`POST /connections/:id/check|delete` 检查或删除，旧发行兼容的 `POST /local/retry` 显式启动并配对旧本机服务。正式受管本机目标的启动走 `/local/v1/products/claude-agent/open`，不创建连接或凭据。

`web/connections.ts` 是本应用网关的浏览器控制器，不是 Nya 组件。关闭或停用立即清空令牌草稿、移除本代 DOM、中止请求，再等待已登记请求退出；迟到保存不得更新新一代窗口或设备选择。无需打开 Harness。

## 测试

`tests/application-optional-capabilities.test.mjs`：能力缺失、平台不支持、版本冲突时网关自行降级，不消费其他应用持有的不兼容服务。

[claude-agent-client.test.mjs](../../../tests/claude-agent-client.test.mjs)：白名单、转发头与 SSE 透传、Harness 保持关闭时本应用独立管理连接并到达远端执行设备、目录窗口只对本机连接开放及其失败映射。

[claude-agent-project-panel.test.mjs](../../../tests/claude-agent-project-panel.test.mjs)：实际项目面板的目录窗口成功、切换设备取消、迟到结果与错误隔离、新请求按钮状态及销毁清理。

[claude-agent-local-client.test.mjs](../../../tests/claude-agent-local-client.test.mjs)：独立本机目标、远端列表并存、受管本机无连接与令牌表单、目录选择路由及不可用状态。

[claude-agent-device-refresh.test.mjs](../../../tests/claude-agent-device-refresh.test.mjs)：实际挂载界面的空连接到本机配对、`open` 与普通激活的启动边界、保留当前线程/Run 观察/未发送字段、连接换代和删除、并发发现及隐藏/销毁的取消与等待。
