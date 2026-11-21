# Agent Note: Personal Agent 轨迹显示输入缓存用量

Status: implemented

## 问题

用户在 Personal Agent 对比连续 Run 的上下文变化，希望在轨迹详情查看 DeepSeek 实际命中和未命中的输入 token 数。先前的展示投影只提供输入和输出总量。

## 决策

复用已有原生响应记录及逐调用展示投影，在轨迹的模型调用明细显示输入缓存用量。Chat Completions 优先使用服务返回的显式命中和未命中数。通用 Chat 用量可以从 `prompt_tokens_details.cached_tokens` 读取命中数。在有命中数和总输入数时，可用非负差值补足缺少的未命中数。保留 `0` 并省略未知项。

## 备选方案

在输入框的用量浮层展示最新缓存统计更显眼，但无法对比同一 Run 内的各次工具续轮，当前把统计放在对应模型调用的明细中。

## 影响与代价

既有响应保留统计时可回看。新增数字随当前展示接口返回，逐次模型调用独立展示。现有原生记录格式仍可直接读取。

## 验证

Personal Agent TypeScript 检查与编译通过。投影和会话视图测试 69 项、Personal Agent 包测试 11 项通过，覆盖原生记录、流式更新、逐调用选择、缺省及零值。Chrome 受控数据验收和浏览器资源校验通过。只读检查本机既有 DeepSeek 记录，确认原生响应中含命中与未命中统计。未重启当前实例或向 DeepSeek 发起新请求。

## 关联

- [Personal Agent 连续历史](2026-11-19-personal-agent-continuous-session.md)
- [历史及轨迹说明](../../../../docs/modules/personal-agent/history.md)
- [用量投影测试](../../../../tests/context-usage-projection.test.mjs)
- [逐调用明细测试](../../../../tests/session-view.test.mjs)
