# AnyboxV2 多实例架构图

> 本页为历史架构快照；文中链接指向当前入口，图源节点和已导出的 SVG/PNG 保留绘制时的命名及结构。当前三层命名以 [命名规范](../naming.md) 为准。

> 当前装配已统一为 Responses、Chat Completions、Anthropic Messages 和 Gemini Interactions 四种协议。DeepSeek 使用标准 Chat，不保留旧驱动或协议别名；旧协议历史仅供查看，不能续接执行。下文及图中的独立 DeepSeek 驱动和五种绑定仅反映绘制当时结构。

> 此图记录 2026-09-29 的部署结构。通用应用注册、多标签、host.http 与 harness.http 的当前边界以[应用宿主设计](../products-v1.md)和[组件清单](../modules/README.md)为准。


[返回文档首页](../README.md) · [Anybox Harness 模块边界](../harness-module-boundary.md) · [组件清单](../modules/README.md)

核对日期：2026-09-29，对应提交 `fd53c6a` 的源码装配。三张图分别说明进程与外部资源、执行根内的组件注入关系，以及一次 Run 的执行时序。每个进程只有一个 Nya 根 Context；图中的子图只按职责分组，不表示子 Context、npm 包或独立服务。

同日较早的[单进程框架图](./anybox-current-framework-2026-09-29.md)记录多实例拆分前的装配，保留其历史语义。

## 01 · 进程与外部资源

一个客户端可以同时连接多个执行端。执行端之间不共享项目、Models、业务库或图片；客户端只保存连接记录，不安装执行服务。

```mermaid
flowchart LR
  subgraph Browser["浏览器 · web/ + src/applications/harness/web/"]
    UI["工作区 UI<br/>项目 · 会话树 · 最多 4 面板<br/>设置：模型 / Prompt / 连接"]
  end

  subgraph ClientProc["客户端进程 · npm run client · 独立 Nya 根"]
    GW["client-gateway<br/>同源监听 · 路由白名单转发"]
    CONN["client-connections<br/>执行端地址 · instanceId · 令牌引用"]
    PICK["host-directory-picker<br/>本机目录窗口"]
  end

  subgraph LocalProc["本机执行端 · npm run harness · 独立 Nya 根"]
    API["host-harness-api<br/>HTTP API + SSE"]
    ACC["host-access<br/>实例身份 · 令牌摘要"]
    CORE["Harness 组件<br/>Run · Session · Prompt · 工具（见图 02）"]
    MODELS["@anybox/models<br/>配置 · 凭据 · 协议驱动 · 目录"]
  end

  REMOTE["其他执行端<br/>云端 / 另一台电脑<br/>结构同本机执行端，数据各自独立"]

  CDB[("client.sqlite")]
  HDB[("harness.sqlite")]
  IMGDIR[("图片原字节目录")]
  MDB[("models.sqlite")]
  CATDB[("models-catalog.sqlite")]
  KC[["系统凭据库<br/>客户端与 Models 使用独立命名空间"]]
  FS[["项目目录<br/>Bash 子进程 · 文本文件"]]
  LLM[["模型服务商原生 API<br/>Responses / Chat / Anthropic / Gemini / DeepSeek"]]
  MDEV[["models.dev 公开目录"]]

  UI -->|同源 HTTP / SSE| GW
  GW --> CONN
  GW --> PICK
  CONN --> CDB
  CONN -.->|连接令牌| KC
  GW -->|"HTTP + Bearer + instanceId"| API
  GW -->|"HTTPS · 外部 TLS 代理"| REMOTE
  API --> ACC
  API --> CORE
  API --> MODELS
  CORE --> MODELS
  CORE --> HDB
  CORE --> IMGDIR
  CORE --> FS
  ACC --> HDB
  MODELS --> MDB
  MODELS --> CATDB
  MODELS -.->|API Key| KC
  MODELS -->|原生 HTTP / 流式| LLM
  MODELS -.->|匿名 ETag 刷新| MDEV
```

- 网关每个请求固定连接版本、地址、凭据和期望 instanceId，不跨实例重试。关闭客户端只断开观察，不取消远端 Run。
- 业务库、Models 配置库和目录缓存库各有独占连接；API Key 和连接令牌只存系统凭据库。

## 02 · 执行根组件与注入关系

箭头 `A → B` 表示 A 通过 `inject` 依赖 B 所在组件提供的服务，图中画出执行根的全部注入关系。执行根共 30 个运行期组件：Models 11 个（含宿主的 DeepSeek 驱动扩展），Anybox Harness 16 个（协议绑定按已安装驱动各装一个），另有 `local-sqlite`、`host-access` 和 `host-harness-api`。客户端根另有 `local-sqlite`、`client-connections`、`host-directory-picker` 和 `client-gateway`。

```mermaid
flowchart TB
  subgraph Host["宿主 · src/host"]
    API["host-harness-api"]
    ACC["host-access"]
  end

  subgraph Exec["执行 · run/ + protocol-agents/"]
    RUNS["harness-runs<br/>准入 · 幂等 · 准备 program"]
    RT["harness-run-runtime<br/>操作屏障 · 取消 · 结算"]
    PA["harness-protocol-agents<br/>协议到 Loop 的注册表"]
    PAB["协议应用绑定 ×5<br/>Responses / Chat / Anthropic / Gemini / DeepSeek Loop"]
  end

  subgraph Data["项目与会话"]
    SES["harness-sessions<br/>harness.sessions + harness.session-runs"]
    PRJ["harness-projects"]
    PF["harness-project-files"]
    IMG["harness-image-assets"]
  end

  subgraph PromptGroup["Prompt"]
    PR["harness-prompts"]
    AP["harness-agent-prompts"]
  end

  subgraph Tools["工具"]
    BASH["bash-tool"]
    PATCH["apply-patch-tool"]
  end

  subgraph Models["packages/models"]
    MOD["models<br/>models · settings · protocols · source-data"]
    STORE["models-store"]
    VAULT["models-vault"]
    DRV["协议驱动 ×5<br/>登记到 models.protocols"]
    CAT["models-catalog"]
    CSRC["models-catalog-source"]
    CCACHE["models-catalog-cache"]
  end

  SQL[("local-sqlite<br/>服务 local-storage")]

  API --> RUNS & SES & PRJ & PR & AP & MOD & CAT & ACC
  RUNS --> SES & AP & MOD & PA & RT & PRJ
  RT --> SES & BASH & PATCH
  PAB --> PA & MOD
  PA --> MOD & IMG
  SES --> PRJ & IMG & PF
  PF --> PRJ
  AP --> PR
  BASH --> PRJ
  PATCH --> PRJ
  DRV --> MOD
  MOD --> STORE & VAULT
  CAT --> CSRC & CCACHE & MOD
  SES & PRJ & PF & IMG & PR & AP & ACC --> SQL
```

- 协议语义只出现在 Models 驱动和对应 Loop 中；RunRuntime 与 Session 不解释 `stop_reason` 或原生结构。
- Models 的 `NativeExecution` 和 `PreparedRunProgram` 是运行对象，不是 Nya 组件，所以不出现在图中。

## 03 · 一次 Run 的执行时序

```mermaid
sequenceDiagram
  autonumber
  participant C as Harness API
  participant R as harness.runs
  participant S as Session 组件
  participant P as protocol-agents
  participant M as models.openNative
  participant RT as RunRuntime
  participant L as 协议 Loop
  participant T as Bash / Apply Patch
  participant X as 模型服务商

  C->>R: startRun(sessionId, parentNodeId, input, idempotencyKey)
  R->>S: findAcceptedRun（幂等键命中则直接返回）
  R->>S: getSession / loadNativeHistory(parentNodeId)
  R->>P: prepare(initialization, input, history)
  P->>M: 固定配置 · 驱动代 · 读取一次凭据
  M-->>P: NativeExecution
  P-->>R: PreparedRunProgram
  R->>S: registerRun（接受事务，固定协议与父链）
  R->>RT: start(program)，同步接管所有权
  RT->>L: program.execute(host)
  loop 每次模型调用
    L->>RT: host.perform(descriptor, start)
    RT->>S: startOperation（先持久化意图）
    RT->>X: start()，经 NativeExecution 流式请求
    L->>RT: host.publish(frame)
    RT-->>C: runViewEvent → SSE 临时投影
    X-->>RT: result + done（等待实际退出）
    RT->>S: observeOperation（提交原生记录）
    opt 模型请求调用工具
      L->>RT: host.executeTools(requests)
      RT->>T: 串行执行：意图 → 启动 → 等待退出 → 观察
    end
  end
  L-->>RT: ProtocolConclusion
  RT->>RT: 取消残余操作 → 等待退出 → program.close()
  RT->>S: settleRun（Run · 记录 · 链节 · 节点 · 终态事件同一事务）
  RT-->>C: Run 终态
```

- 所有权交接点是 `RT.start()`：在它之前 program 由 Run 准入清理，之后由 RunRuntime 清理。
- SSE 投影只用于展示；最终内容以 `settleRun` 提交的持久记录为准。失败、取消和 interrupted 的 Run 不生成可继续的节点。

## 源码依据

- 进程装配：[执行端入口](../../src/entrypoints/harness-server-main.ts)、[客户端入口](../../src/entrypoints/client-main.ts)、[Models 装配](../../src/applications/harness/server-models.ts)、[harness server 组合根](../../src/applications/harness/core/index.ts)。
- 注入关系：各组件工厂的 `inject` 声明，入口见[组件清单](../modules/README.md)。
- 执行时序：[Run](../../src/applications/harness/core/run/component.ts)、[RunRuntime](../../src/applications/harness/core/run/runtime-component.ts)、[程序契约](../../src/applications/harness/core/run/program.ts)、[Loop 公共运行器](../../src/applications/harness/core/protocol-agents/shared.ts)。

组件、注入依赖或进程边界变化时，同步核对本文三张图。
