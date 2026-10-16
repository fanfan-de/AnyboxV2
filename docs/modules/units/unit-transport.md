# 单元传输组件

[返回可组合单元模块](README.md) · [单元附着](unit-attachments.md) · [worker 拨出](../computers/worker-dialout.md)

`createUnitTransportComponent(inputs)` 在 harness server 根安装 `harness-unit-transport`，提供 `harness.unit-transport: UnitTransportPort`。inject `harness.unit-attachments`。它是单元拨出传输在 harness server 这一端的入口：远端单元用自己的凭证长轮询领取请求，再用 POST 回传回执；harness server 侧的代理组件通过它向单元发请求。源码：[组件](../../../src/applications/harness/core/unit/transport-component.ts)、[纯规则](../../../src/applications/harness/core/unit/transport-domain.ts)。

## 配置与接口

`inputs` 提供 `now()` 与 `newId()`；请求 ID 由 `newId()` 生成。组件没有其他配置；超时常量定义在 `transportLimits`：领取窗口 10 秒、回执窗口 60 秒、单次轮询最长 30 秒（默认 20 秒）、45 秒内没有轮询视为断连。

| 方法 | 行为 |
| --- | --- |
| `authenticate(authorization)` | 解析 `Unit <attachmentId>:<credential>`，经附着账本以常量时间比较凭证摘要；只有 `approved` 附着通过，其余返回 `unit-credential-invalid` 或 `unit-attachment-state` |
| `poll(attachmentId, registration, signal?)` | 单元声明 `unitId`、`bootId`、平台、架构与等待时间；有排队请求立即领取，否则等待到有请求、等待期满、调用方断开或组件关闭。调用方断开时不领取任何请求 |
| `reply(attachmentId, replies)` | 校验回执并结算对应在途请求；未知 `requestId` 忽略。错误回执按原 `code`、`name`、`category` 重建为带 `remote: true` 的 Error |
| `request(attachmentId, { kind, payload }, options?)` | 代理侧发起一次请求：单元在失联窗口内没有轮询过时立即返回 `unit-unavailable`，否则进入该附着的邮箱并唤醒等待中的轮询；领取窗口内无人领取返回 `unit-unavailable`，领取后回执超时返回 `unit-reply-timeout`，`signal` 中止返回 `unit-request-aborted` |
| `connection(attachmentId)` | 最近一次轮询登记的单元身份、平台与时间，以及派生的 `connected`；没有轮询过返回 `undefined` |

单元每次轮询都声明 workerId、bootId、平台与架构；`connection()` 用于连接状态及本代 claim 缓存，实例激活仍通过 `info` 请求向实际 worker 确认身份。单元换了 `bootId` 再来轮询时，上一代领取而未回复的请求立即按 `unit-claimed-unavailable` 失败，该错误保留“已领取、执行结果未知”的事实，不能按无人领取处理；由调用方按原 ID 向活着的单元查回或幂等重传。

## 数据与资源归属

组件只持有内存中的邮箱：每个附着一份排队请求、在途请求和等待中的轮询。没有迁移域，没有持久事实——声明的耐久事实归 Session 与 Computer Operations 账本，接纳与执行事实归单元自己的账本，两边以 `operationId` 协调。连接状态是派生视图，不是事实。`unit-unavailable` 只说明本次未领取；此前已领取的提交仍可能执行，代理需要保留该 Run 的不确定性。

## 执行、取消与清理

所有等待都有上限：请求受领取窗口、回执窗口和调用方 `signal` 约束，轮询受单元声明的等待时间、HTTP 断开和组件关闭约束。Effect 把排队与在途请求全部按 `unit-transport-closed` 拒绝并释放全部轮询；远端单元已接受的操作继续到各自退出，由账本在重连后协调。

## 失败与兼容边界

组件不区分单元种类，Models 远端单元（U3）沿用同一邮箱。它不做请求重投递：领取后丢失的请求超时失败，代理组件按既有"同 ID 同摘要返回原事实"规则重试。它也不校验 instanceId：HTTP 层用 `x-anybox-instance-id` 头与本实例身份比对，单元从附着响应得到该身份。被撤销的附着在下一次 `authenticate` 失败；撤销前已经领取的请求仍可回执。

## 验证

[单元传输测试](../../../tests/unit-transport.test.mjs)覆盖纯规则、认证、领取/回执、唤醒、领取超时、中止、换代、回执超时、断开的轮询不领取、撤销与关闭；[worker 附着测试](../../../tests/computer-worker-attachments.test.mjs)经真实认证监听器验证端到端拨出。完整入口为 `npm run check`。
