# Models 目录调度

[返回 Models 模块](README.md)

## 定位与装配

源码：[catalog.ts](../../../packages/models/src/catalog.ts)，随包数据加载：[catalog-builtin.ts](../../../packages/models/src/catalog-builtin.ts)。工厂 `createModelsCatalogComponent(options?)`，组件名 `models-catalog`，提供 `models.catalog: ModelsCatalogService`，注入 `models.catalog-source`、`models.catalog-cache` 和 `models.source-data`。

该组件协调来源选择、后台检查与本地接纳，不再提供单独的 Provider/Model 目录查询；统一查询使用 `models.settings.providers/models`。执行核心不注入目录，因此配置完成后模型请求不需要实时目录。

## 配置与接口

| 配置 | 默认值与用途 |
| --- | --- |
| `bundledSnapshot` | models.dev 使用经校验的随包快照；其他来源默认空快照 |
| `autoRefresh` | 默认为 `true`，关闭后仍允许显式刷新 |
| `refreshIntervalMs` | 24 小时 |
| `retryIntervalMs` | 1 小时 |
| `timeoutMs` | 30 秒，只约束获取阶段 |
| `scheduler` | 可替换 `now/setTimeout/clearTimeout`，默认 timer 使用 `unref()` |

三个时长必须为正的安全整数且不超过 `2_147_483_647`。快照来源 ID 必须与 source 匹配。

`status()` 返回来源 ID、快照版本/抓取时间、`origin`（`bundled/cache/network/store`）、刷新中与过期状态、检查/下次刷新时间、缓存持久性、各连接补齐状态和固定错误。`refresh(signal?)` 返回上述状态的 promise；并发刷新返回 `busy`，关闭后返回 `closed`。

## 启动来源选择

1. 读取并验证独立缓存，损坏或不可读时记录 `storage-unavailable`，继续启动。
2. 优先采用 `models.source-data.accepted(source.id)` 返回的已接纳数据，以业务配置库中的来源账本为权威。
3. 在随包快照与缓存中选择时间较新的候选。只有无已接纳数据、候选更新或内容版本相同，才尝试接纳；旧缓存/快照不能降级已接受内容。
4. 只有缓存内容版本与最终已接纳版本相同，才沿用 ETag 和检查时间。等时间不同内容保留 store 数据并清除 ETag，下一次完整响应可确认来源。
5. 提供服务后安排后台定时器；从未检查或已过期时立即异步刷新，不把长期定时循环放在 `apply` 中。

随包加载校验原始文件 SHA-256、provenance 中的固定源地址、格式及时间，然后规范化。素材在 `packages/models/assets/`，带上游许可；只有 `npm --prefix packages/models run catalog:update` 显式下载更新，普通构建与测试不更新快照。

## 刷新、接纳与状态

获取阶段使用私有控制器链接调用者信号和超时，向来源发送匹配内容的 ETag。先等待来源 `result` 和 `done` 实际退出，再检查取消与组件准入状态。

`modified` 响应必须包含正确来源快照；`not-modified` 必须建立在已有 ETag 上。进入本地提交前最后检查取消，随后标记 `committing` 并取消超时计时器：

1. 原子保存缓存快照、ETag 与本次检查时间。
2. 调用 `sourceData.accept(candidate, { confirmed: modified })`，等待统一定义事务与已接纳的连接补齐。
3. 重新读取权威来源，发布状态；只有内容版本一致才保存 ETag/check 时间并标记 `origin: 'network'`，否则保留 `store`。

缓存先写入意味着统一定义提交失败后，下次启动可重放已提交缓存。接纳成功与单个连接补齐失败分开表达：来源可以已更新，同时某连接 `sync.state` 为 `failed`，Key 仍保留并可显式重试。

## 生命周期、取消与失败

刷新在进入提交阶段前可取消；一旦本地提交已准入，迟到取消不回滚缓存、定义或补齐，关闭必须等待这一整段退出。`refresh()` 成功意味着 HTTP reader 退出以及本地接纳/初始化均已等待。

获取超时报告 `timeout`；格式错误、存储错误、清理错误使用对应固定 code，其他错误归为 `unavailable`。失败保留原有来源，默认一小时后重试；成功按正常周期安排下一次。普通调用者取消不是来源故障，按正常间隔安排后续检查。清理失败被记住并在关闭时报告。

Effect 关闭同步停止新刷新、清掉调度器、取消当前获取，等待初始化和已准入刷新结束。依赖替换由 Nya 先关闭旧门面后创建新组件，旧门面不可复用。调度仅拥有自身 timer 和刷新工作；source 的 HTTP、cache 的 SQLite、core 的定义写入各自由其组件收尾。

## 测试与扩展

[catalog.test.mjs](../../../packages/models/tests/catalog.test.mjs) 覆盖启动来源优先级、防降级、ETag/304、时钟调度、取消/超时、持久写入等待、依赖替换和缓存重放；[source-definitions.test.mjs](../../../packages/models/tests/source-definitions.test.mjs) 验证接纳与补齐并发。Web 集成见 [models-directory-web.test.mjs](../../../tests/models-directory-web.test.mjs)。

可替换来源、缓存及 scheduler；来源查询统一走 Settings，不因扩展目录重新建立模型定义副本。参见 [目录来源](catalog-source.md)、[目录缓存](catalog-cache.md)、[Models 协调服务](models.md) 和 [目录验证记录](../../models-catalog-validation.md)。
