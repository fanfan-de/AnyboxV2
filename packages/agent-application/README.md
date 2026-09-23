# Agent Application

将 Agent 作为可持久运行的应用装配。公共入口为 `@anybox/agent-application`。

```text
src/
├── index.ts                         公共导出
├── types.ts                         配置和应用接口
├── application.ts                   组合根、启动关闭与根控制面
└── components/agent/component.ts     AgentApplication 组件
tests/                               持久化、替换、崩溃恢复和宿主行为
```

`application.ts` 依次安装 State、MockModel、Tools、Harness、AgentApplication 五个组件。组件共享基础 application 的 Context；外部调用每次读取当前 `agent.application` 服务，避免缓存跨组件重启的服务引用。

`components/agent/component.ts` 注入当前 `agent.kernel`，自动初始化 Agent，提供绑定身份与代次的任务 API。组件关闭由 Nya Effect 及其依赖资源负责。

`application` 包负责通用框架生命周期；本包负责 Agent 应用组合；`agent-kernel` 提供执行和适配实现；`agent-contracts` 定义它们共享的接口。HTTP、信号和退出期限属于 `examples/agent-application-host.mjs` 宿主。

启动、恢复语义和限制见 [Agent 应用说明](../../docs/agent-application-v1.md)。
