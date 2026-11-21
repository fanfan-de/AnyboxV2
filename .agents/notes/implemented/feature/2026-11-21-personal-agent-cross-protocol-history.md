# Agent Note: Personal Agent 会话历史支持切换 API

Status: implemented

## 问题

连续 Session 的可见历史由应用持有，模型请求却只能从同协议原生父记录恢复。选择另一种 API 会拒绝现有会话继续发送。

## 决策

SQLite `run-state` v18 在成功结算事务按 Run 追加版本化的应用历史，保存逐条用户输入、图片引用、助手输出、工具调用和对应结果。新 Run 沿当前节点的祖先路径读取，按所选协议编排请求。兼容的原生后缀保留推理签名和固定请求前缀。旧记录按各自协议还原，包括曾自动切段的历史。Models 接纳受信宿主编码的内存前缀，增量记录仍只保存本轮交换。

## 备选方案

放弃历史、自动新开上下文或将近期问答包装为一条摘要都会改变会话连续性。将上一轮接口的原生请求直接提供给另一种协议无法保证字段和工具关联正确。

## 影响与代价

切换后需要把完整应用历史重新编码。供应商专属推理、签名和执行状态保存在原始记录中。跨协议传递服务端搜索可读的调用和结果元数据。已选模型的容量、目录资源边界和同一提供方的凭据恢复身份仍参加准入。已接纳 Run 用固定的父引用和组包选择恢复。真实提供方可能限制导入工具历史。

## 验证

- 根工作区构建通过。最终的 Models 与 Personal Agent 构建及 519 项定向测试通过，范围包含 Models、Personal Agent、原生协议和会话视图。
- 回环 HTTP 用例通过会话选模入口依次切换四种协议，重启后恢复旧问答、图片、工具调用和原始结果，并切回 Chat Completions。核对各 Run 独立保存的应用事件、恢复前缀和对应的原生后缀。旧库升级、同协议换模型和生成参数、超预算及同一提供方换 Key 的准入用例通过。
- 两项定向用例核对跨协议可携带的服务端搜索调用和结果字段。验证使用临时执行库和模型替身，真实供应商请求未验收。 `git diff --check` 通过。

## 关联

- [更换 Key 后继续原会话](../simplification/2026-11-21-personal-agent-continue-after-key-rotation.md)替代应用历史重新组包时的凭据准入规则。
- [复用已组装的模型上下文](2026-11-21-personal-agent-native-context-reuse.md)为兼容的连续 Run 缓存当前末端的原生上下文。
- [Personal Agent 连续历史](../../../../docs/modules/personal-agent/history.md)
- [完整原生父链](../bug-fix/2026-11-21-personal-agent-strict-native-continuity.md)
- [Personal Agent HTTP 验证](../../../../packages/app-personal-agent/tests/http.test.mjs)
- [统一从 Agent 设置选模](../simplification/2026-11-21-personal-agent-default-model-in-settings.md) 将客户端换模入口移到 Agent 设置。
