# H0 资源探针组件

[返回资源归属验证模块](./README.md)

## 职责与组件契约

探针以最小调用模型验证一个原则：业务结果返回后，调用仍可能持有资源；消费者必须等到实际退出，提供方才能清理。它仅用于 H0 验证，不参与正式原生协议 Agent 的运行。

| 项目 | 定义 |
| --- | --- |
| 工厂 | `createResourceProbe()`，无配置参数 |
| Nya 组件名 | `h0-resource-probe` |
| 提供服务 | `h0.runs`，接口 `RunProbePort` |
| 注入依赖 | `h0.model`，接口 `ProbeModelPort` |
| 入口 | [resource-probe.ts](../../../src/resource-probe.ts) |
| 通用调用契约 | [contracts.ts](../../../src/harness/contracts.ts) 中的 `OwnedCall<Result>` |

`ProbeModelPort.call(prompt: string)` 返回 `OwnedCall<string>`，由测试安装可控替身。这里保留字符串输入是探针本身的契约，不代表项目仍提供统一文本模型执行 API。

## 调用接口与资源所有权

唯一接口 `start(prompt)` 在准入开启时同步调用注入的模型，登记返回句柄及其 `done` 的观察 Promise，并将原句柄返回。组件不转换结果、不写 Session、不分派工具，也不持久化任何状态。

`OwnedCall.result` 表达业务结果；`cancel(reason)` 只发出取消请求；`done` 表达实际调用和资源清理已经退出。探针用 `done.finally(...)` 删除活动登记，不以 `result` 完成作为释放信号。调用者仍负责消费自己的 `result`。

## 关闭与错误

Effect 清理先关闭准入，之后对所有活动调用执行 `cancel('owner-disposed')`，逐一收集同步取消错误，并通过 `Promise.allSettled()` 等待已登记的退出观察。`done` 的拒绝被记录，避免已退出的失败从活动表移除后丢失。

清理错误按对象身份去重：单个错误直接抛出，多个错误合成为 `AggregateError('owned call cleanup failed')`。已关闭实例再调用 `start` 抛出 `run owner is closing`；模型 `call` 的同步错误直接向调用者传播，不会留下未取得的调用登记。

Nya 根据 `inject` 知道探针对模型提供方的依赖。卸载模型提供方时，先撤销并等待探针消费者，再清理提供方；只卸载探针时，模型提供方仍可存续。重新安装应通过当前根取得新服务，不能复用已关闭引用。

## 验证入口与范围

[resource-boundaries.test.mjs](../../../tests/resource-boundaries.test.mjs) 用可控 `done` 证明：结果已返回时卸载仍然等待；取消发出后新调用被拒绝；提供方最后清理；单独卸载消费者不清理提供方。

可在根构建后运行 `node --test tests/resource-boundaries.test.mjs`，完整验证运行 `npm run check`。正式执行的 program 接管、操作持久屏障与结算由 [RunRuntime](../execution/run-runtime.md) 负责，不应向探针扩展业务能力。
