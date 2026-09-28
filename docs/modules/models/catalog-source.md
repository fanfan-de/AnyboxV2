# models.dev 目录来源

[返回 Models 模块](README.md)

## 定位与装配

源码：[catalog-source.ts](../../../packages/models/src/catalog-source.ts)，数据规范化与校验在 [catalog-domain.ts](../../../packages/models/src/catalog-domain.ts)。工厂 `createModelsDevCatalogSourceComponent(options?)`，组件名 `models-catalog-source`，提供 `models.catalog-source: ModelsCatalogSource`，无注入依赖。

来源组件只负责匿名 HTTP 与规范化，目录调度由 [Catalog](catalog.md)负责，持久缓存由 [Cache](catalog-cache.md)负责，统一定义最终由 `models.source-data` 接纳。源码还导出 `createModelsDevCatalogSource(options?)` 独立服务工厂；该返回值没有组件级 close 接口，应用一般应安装 Nya 组件以获得整体清理所有权。

## 配置与接口

`ModelsDevCatalogSourceOptions` 包含可选 `url`、`fetch` 和 `now`。默认地址为 `https://models.dev/api.json?type=all`，自定义地址也强制设置 `type=all`。地址只允许 HTTP/HTTPS，不允许 URL 用户名、密码或 fragment；`fetch` 与 `now` 可替换以做离线测试。

服务固定 `id: 'models.dev'`，`cacheKey` 由该来源 ID 和完整请求 endpoint 组成，避免代理或不同端点共享错误 ETag。`fetch({ etag?, signal })` 返回 `CatalogOperation`：

- `result`：`{ status: 'modified', snapshot, etag? }` 或 `{ status: 'not-modified', etag? }`。
- `done`：HTTP、reader、取消与锁释放的实际退出。
- `cancel(reason?)`：发出取消请求，不代表已经退出。

调用者 signal 必须是 `AbortSignal`，ETag 不得含 CR/LF。来源自身不设置刷新周期或超时，交由调度组件管理。

## 获取与规范化流程

请求使用 GET、`Accept: application/json`、可选 `If-None-Match` 和 `credentials: 'omit'`；不读取配置 Key，不附认证头。仅携带已有 ETag 时接受 304，否则为无效响应。

正常响应按块读取，严格解码 UTF-8；`Content-Length` 或实际累计数据超过 32 MiB 即拒绝。解析 JSON 后调用 `normalizeModelsDevCatalog`，产生 schema 2 的 `SourceSnapshot`，包含来源身份、内容版本、抓取时间及统一 Provider/Model 定义。

规范化保留已知的模态、能力、价格、上下文/输出限制和展示 controls，不将未知支持改为支持。来源原始 ID 通过命名空间变成稳定内部 ID；时间变化不改变相同内容的内容版本。SDK 标签只用来规范化显式提示，不动态加载代码；定义和快照校验拒绝不匹配身份、内容版本与秘密形状字段。文本模型筛选在后续查询/补齐边界执行，来源不会先丢弃其他模态。

## 资源、取消与错误

每次 fetch 独占其控制器、response reader、取消 promise 和监听器。取消先尝试 `reader.cancel()` 再 abort fetch，避免已 errored reader 造成错误的重复清理判断。已读失败的流直接释放锁。操作结果可能先于 reader 清理，调用者必须等待 `done`，或使用调度层已经合并的 `refresh()`。

HTTP/网络失败为固定 `unavailable`，无效内容为 `invalid-response`，取消为 `cancelled`，reader 清理失败为 `cleanup-failure`。来源会记住已完成操作的清理失败；组件卸载仍报告它。Effect 关闭同步停止准入，取消所有在途获取并等待退出，重复关闭复用同一 promise。

## 扩展与测试

要换其他目录来源，应实现 `ModelsCatalogSource`，提供隔离的 `id/cacheKey`、规范化快照及可靠的 `result/done/cancel`，无需修改模型执行链路。通用目录调度对非 models.dev 来源默认使用空初始快照，可注入匹配的 `bundledSnapshot`。

[catalog-source.test.mjs](../../../packages/models/tests/catalog-source.test.mjs) 验证匿名请求、分块 UTF-8、ETag、固定错误、迟到 fetch、reader 清理及组件卸载；[catalog.test.mjs](../../../packages/models/tests/catalog.test.mjs) 验证快照身份、版本与集成刷新。关联：[目录调度](catalog.md)、[目录验收记录](../../models-catalog-validation.md)。
