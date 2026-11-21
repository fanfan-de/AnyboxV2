# Agent Note: Personal Agent 复用已组装的模型上下文

Status: implemented

## 问题

每个连续 Run 都从 SQLite 逐段读取并重放原生历史。长会话的兼容请求会反复解析相同记录和组装同一前缀。

## 决策

成功结算后缓存该连续 Session 最新成功节点的不可变原生上下文、末尾记录 ID、图片引用与累计预算统计。命中时跳过祖先扫描和原生重放，开启本轮的新 execution 并追加输入。仍核对持久末端、参数、模型和凭据恢复身份、驱动代次、预算与图片许可。切换 API、进程重启或缓存不匹配时使用既有持久历史恢复。工具清理只读取本轮恢复游标。

## 备选方案

复用整个 execution 会延长旧请求的凭据、资源与取消作用域。逐节点存储已组装上下文会重复持久化整个历史。

## 影响与代价

缓存最多保留 16 个连续会话末端，总估算体积上限为 16 MiB。完整出站请求及应用历史保持逐条。收益限于本地历史读取和恢复，供应商接收的上下文不因缓存减少。

## 验证

- Models 与 Personal Agent 构建通过，522 项定向测试通过。回环测试核对同配置续接无需读取旧记录，切换 API 和重启后可重建完整前缀，且出站 JSON、工具结果关联、图片及用量一致。
- Models 单元测试核对命中跳过驱动恢复、与冷恢复发出相同请求、换 Key 或替换驱动代次撤销旧句柄，以及取消和失败不产生句柄。图片由新 execution 的资源端口读原字节。
- 300 次合成交换的 Chat Completions 基准，仅测 Models 打开 execution。各 7 次样本的中位数为冷恢复 127.18 ms，复用 0.13 ms。未测量端到端耗时及真实提供方。

## 关联

- [Personal Agent 连续历史](../../../../docs/modules/personal-agent/history.md)
- [跨协议会话历史](2026-11-21-personal-agent-cross-protocol-history.md)
- [Models 续接测试](../../../../packages/models/tests/continuation.test.mjs)
- [完整请求与历史读取断言](../../../../packages/app-personal-agent/tests/http.test.mjs)
