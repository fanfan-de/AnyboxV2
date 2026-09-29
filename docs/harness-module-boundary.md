# Harness 模块边界与目标目录结构

[返回文档首页](./README.md) · [当前组件手册](./modules/README.md) · [当前组件协作](./harness-components.md)

状态：2026-09-29，已初步认可的模块划分与目录整理方向，作为后续实施依据。本文描述目标结构；当前源码仍位于 `src/` 和 `packages/models/`，尚未完成 Harness 抽包、目录迁移或远程服务接入。实际组件、接口及行为仍以源码和组件手册为准。

## 1. 模块定义与判断标准

Harness 是负责在指定执行环境中管理 Agent 会话、组织输入和上下文、执行模型与工具循环，并保存可恢复执行事实的组件集合。

区分三个边界：

- **模块归属**：谁定义业务语义、数据含义、执行规则与资源保留规则。
- **运行依赖**：Harness 消费哪些可独立提供的能力，例如 Models、Nya 和存储。
- **部署组合**：宿主为了运行一个完整实例安装哪些模块、提供方和接入适配。

一起部署不代表属于同一模块；位于同一模块也不代表合并成一个组件。继续按实际资源和可替换边界保留 Nya 组件，内部纯函数、提供方、配置和目录不额外注册组件。

每个执行实例使用一个应用 Nya 根。模块划分不新增 Harness、项目、Session 或远程连接的子 Context。宿主选择实现和配置，Nya 负责依赖就绪、重启与清理顺序。

## 2. 当前内容的目标归属

| 当前内容／组件 | 目标归属 | 说明 |
| --- | --- | --- |
| `harness-runs`、`harness-run-runtime` | Harness 核心 | Run 准入、幂等、program 交接、运行操作、取消与结算 |
| `harness-sessions` | Harness 核心 | 会话树、归档、Run 事实、原生记录、节点与恢复规则；包括其两个服务 |
| `harness-protocol-agents` 与五种 `harness-protocol-agent-*` 绑定 | Harness 核心 | 绑定驱动代、编码运行输入、执行对应原生协议 Loop 并生成安全投影 |
| AgentDefinition、校验及默认配置语义 | Harness 核心配置 | 保持只读配置，由宿主传入；不新建 Agent 组件 |
| `harness-agent-prompts` | Harness 核心 | Agent 提示词版本选择、模板解析和运行快照 |
| `harness-prompts` | 当前纳入 Harness | 文档、草稿和发布版本服务于当前 Agent 配置；保留独立组件 |
| `harness-projects` | 当前纳入 Harness | 执行端项目身份、规范化目录与可用性 |
| `harness-project-files` | Harness | 输入文件搜索、读取、准备批次、不可变快照与事务保留 |
| `harness-image-assets` | Harness | 图片原字节、草稿续期、Run 引用保留与执行读取 |
| `bash-tool`、`apply-patch-tool` | Harness 内置工具 | 各自持有进程或文件提交资源，RunRuntime 使用既有工具契约 |
| 上述组件的领域函数、表、迁移和内部持久化实现 | 对应 Harness 组件 | 数据库操作的位置不改变业务归属 |
| Models 协调、配置存储、Vault、目录来源／缓存／调度、四种通用原生驱动 | 独立 Models 模块 | 保持 `packages/models`，不依赖 Harness 或 Anybox 客户端 |
| DeepSeek 原生驱动扩展与旧参数转换 | 宿主的 Models 扩展 | 当前在 `src/web/deepseek-protocol.ts`；与 Harness 的 DeepSeek Loop 分开 |
| `local-sqlite` 通用实现 | 宿主使用的基础设施 | 连接、排他所有权、事务和迁移机制；不接收领域迁移列表 |
| Harness 公开 DTO、HTTP 路由与 SSE 适配 | Harness 的可选接入层 | 从现有 Web 中提取，核心执行不依赖 HTTP 或浏览器 |
| Models 管理路由 | 宿主接入适配 | 经 Models 公共服务管理定义、连接、参数、Key 与目录，由宿主组合到 API 入口 |
| 页面、模型／Prompt 表单、分屏、布局、浏览器草稿和展示 | Anybox 客户端 | 消费公开契约，不访问原生恢复记录或运行句柄 |
| `host-directory-picker` | 本机宿主 | 操作系统目录对话框及其进程资源 |
| 启动配置、根 Context、进程信号、网络与静态资源托管配置 | 部署宿主 | 决定如何装配并关闭完整应用 |
| NyaCore | 外部框架依赖 | 只从 `@nya/core` 公共入口使用 |
| `h0-resource-probe` | 验证与诊断 | 不进入正式 Harness 运行路径 |

`web-frontend` 当前同时包含业务接入和页面宿主职责，实施时按上表拆分，不能将整个 `src/web/` 直接迁入 Harness。

## 3. 容易混淆的边界

### 3.1 Models 驱动与 Harness 协议 Loop

Models 驱动负责认证、原生请求、传输、解析、execution 及版本化协议记录。Harness Loop 根据原生结果决定工具调用、工具回填、自动续轮和运行结束；RunRuntime 管理操作和退出，不解释协议停止原因。

以 Anthropic 为例，请求编码与原生响应解析属于 Models；处理工具请求并按 `pause_turn` 决定续轮属于 Harness。DeepSeek 原生参数扩展留在宿主，使用该驱动完成 Agent 循环的绑定留在 Harness。

### 3.2 Projects 与目录选择

Projects 当前定义执行目录身份，Session、Bash 和 Apply Patch 都使用这个身份，因此纳入 Harness。目录选择窗口只提供一个目录输入，属于宿主；侧栏排序、折叠和布局属于客户端。

远程访问时，项目路径由目标 Harness 所在机器解释。本机目录选择能力不能隐式代表远端路径；无界面宿主的项目登记入口需在后续接入设计中明确。

### 3.3 Prompt 与 Agent Prompt

Agent Prompt 的绑定与运行解析属于 Harness。当前 Prompt 草稿、发布和版本管理也纳入 Harness，保留独立组件和职责；编辑表单属于客户端。未来若出现独立的跨应用提示词资产需求，再依据实际消费者提取通用模块，不提前创建提示词平台。

### 3.4 图片与项目文件

两者都定义进入 Run 的资料身份、过期、固定快照、接受时保留和历史复用规则，属于 Harness。Session 接受 Run 时继续通过同一业务事务保留引用；组件资源所有权和存储位置保持现有设计。图片原字节在图片目录，文件快照正文在业务数据库。

客户端负责拖拽、粘贴、选择与预览。文件系统读取、图片验证等内部实现可替换，但不为目录整理额外提取通用资产平台。

### 3.5 工具与运行调度

Bash 与 Apply Patch 是当前 Harness 的内置工具实现，仍是独立 Nya 组件。Bash 拥有子进程，Apply Patch 拥有跨项目串行队列和临时资源；RunRuntime 拥有操作管理与调用交接。保留已知工具判别联合及直接注入，不新增动态工具注册中心。

### 3.6 通用存储与领域持久化

通用 SQLite 实现属于基础设施；Session 的 `sqlite-records.ts`、Prompt 的 `sqlite-storage.ts`、Agent 绑定存储及各组件的表、迁移和查询，跟随相应 Harness 组件。

目标包内的 `storage/port.ts` 表达 Harness 对存储提供方的需求，由宿主基础设施实现。当前端口包含 SQL 和同步事务参与语义，目录迁移不意味着已支持任意数据库。保留既有 SQLite 事务、迁移账本和数据格式，不把领域迁移集中交给通用存储。

### 3.7 API、展示契约与宿主

可序列化的安全展示类型及无 DOM 的校验代码放在中立导出中，供 Harness 和客户端共同使用。协议原生记录的白名单投影仍由 Harness 生成，DOM 挂载与界面交互留在客户端。

HTTP／SSE 适配只提供明确允许的命令、查询、事件和资源读取，不将受信 Harness 门面全部映射为 RPC。`getRunRecords()`、execution、凭据引用、租约和句柄不进入客户端接口；`OwnedCall`、`AbortSignal` 与 `result/done` 也不能直接当作网络对象传递。

宿主确定认证、监听和静态资源配置，组合 Harness 与 Models 路由。实际 HTTP 监听器、连接及在途请求应有唯一组件所有者，并通过 Effect 清理；路由拆分不重复创建监听器或生命周期管理。该拆分完成前，组件手册继续如实描述现有 `web-frontend`。

## 4. 目标目录结构

以下是后续源码迁移采用的目录约定，不代表这些路径已经存在。只在搬入实际实现时创建目录；不先创建空组件、空包或占位宿主。目录名表达职责，不代表增加 Nya 组件。

```text
packages/
├─ harness/                         # 目标独立包 @anybox/harness
│  ├─ package.json
│  ├─ tsconfig.json
│  ├─ README.md
│  ├─ src/
│  │  ├─ index.ts                  # 明确选择的受信宿主公共导出
│  │  ├─ harness.ts                # Harness 门面与组件安装入口
│  │  ├─ contracts.ts              # 执行调用、时间和 ID 等内部共享契约
│  │  ├─ validation.ts
│  │  ├─ agent/                    # AgentDefinition 与 Agent Prompt
│  │  ├─ prompt/                   # Prompt 文档、版本及领域持久化
│  │  ├─ project/                  # 执行项目身份
│  │  ├─ project-files/            # 文件资料、快照与保留
│  │  ├─ session/                  # 会话、节点、记录、恢复及领域持久化
│  │  ├─ image/                    # 图片原字节与引用生命周期
│  │  ├─ run/                      # Run、RunRuntime 与操作契约
│  │  ├─ protocol-agents/          # 原生协议绑定、Loop 与安全投影
│  │  ├─ tool/                     # Bash、Apply Patch 及其领域函数
│  │  ├─ storage/
│  │  │  └─ port.ts                # 存储依赖契约，不含 SQLite 连接实现
│  │  ├─ view/                     # 安全展示类型与无 DOM 校验
│  │  └─ http/                     # 可选公开 API、DTO 与 SSE 适配
│  └─ tests/                       # Harness 行为与模块边界测试
├─ models/                          # 现有独立 Models 包
└─ api-key-manager/                 # 现有独立包与旧凭据读取兼容用途

src/
├─ host/                            # Anybox 执行／页面宿主装配
│  ├─ main.ts                      # 根、组件安装与进程信号
│  ├─ startup-config.ts
│  ├─ models-startup.ts
│  ├─ deepseek-protocol.ts
│  ├─ directory-picker.ts
│  ├─ models-api.ts                # 从现有服务端提取的 Models 管理接入
│  └─ web-host.ts                  # 页面托管及 HTTP 入口组合
├─ infrastructure/
│  └─ storage/
│     └─ sqlite.ts                 # 实现 Harness 存储端口的通用提供方
├─ client/                          # 从 src/web 提取的浏览器代码
│  ├─ client.ts
│  ├─ client-types.ts              # 仅保留 UI 状态类型，复用公开 DTO
│  ├─ protocols/                   # 协议展示、DOM 挂载与客户端 reducer
│  └─ ...                          # 现有 workspace/session/models 等客户端模块
└─ diagnostics/
   └─ resource-probe.ts             # 现有 H0 探针

web/                                # 现有 HTML、CSS 等静态资源
tests/                              # 宿主、客户端与跨模块集成测试
docs/                               # 当前文档入口、组件手册和设计
```

`http/` 是可选接入导出，核心入口不得因此加载 HTTP 服务或页面。`view/` 和公开 DTO 应有浏览器可用的独立导出，不能通过包根间接加载 Node、Nya 或系统凭据模块。首次整理不要求为接入层、工具、Prompt 或存储再创建独立 npm 包。

### 当前路径到目标路径

| 当前路径 | 目标路径／处理方式 |
| --- | --- |
| `src/{agent,prompt,project,project-files,session,image,run,protocol-agents,tool}/` | 对应迁入 `packages/harness/src/`；保持各组件内部资源边界 |
| `src/contracts.ts`、`src/validation.ts` | 迁入 Harness；客户端只共享其中适合公开边界的内容 |
| `src/harness.ts` | 提取模块门面与安装入口到 Harness，整根关闭责任在宿主明确 |
| `src/storage/port.ts` | `packages/harness/src/storage/port.ts`，通过公共子路径供提供方实现 |
| `src/storage/sqlite.ts` | `src/infrastructure/storage/sqlite.ts` |
| `src/web/protocols/types.ts` 与 `view.ts` 的无 DOM 校验 | 提取至 Harness `view/`；DOM 展示与 UI reducer 留在客户端 |
| `src/web/component.ts`、`server.ts`、`run-change-stream.ts` | 按 Harness API、Models API、监听／页面宿主拆分，不整目录搬迁 |
| `src/web/client-types.ts` | 公开 DTO 提取到接入契约，UI 状态留在 `src/client/` |
| `src/web/serve.ts`、`startup-config.ts`、`models-startup.ts`、`deepseek-protocol.ts`、`directory-picker.ts` | 迁入 `src/host/`；入口职责按目标结构拆分 |
| `src/web/` 的浏览器控制器、视图、布局、草稿与表单 | `src/client/`，使用公开契约 |
| `src/resource-probe.ts` | `src/diagnostics/resource-probe.ts` |
| `tests/` 中 Harness 行为测试 | 随包迁移；宿主、浏览器与跨模块测试保留在根测试目录 |

实施时迁入完整职责所需文件并更新导入、构建和测试入口，随后删除已失去用途的旧路径；实际数据读取兼容代码继续跟随其领域组件。组件手册暂保留现有按职责的 `docs/modules/` 导航，更新源码链接即可，不因源码抽包复制一套手册。

## 5. 依赖、数据与生命周期约束

- Harness 可以通过公共入口消费 Models 与 Nya；Models 不依赖 Harness，Harness 不导入应用 `src/` 或浏览器 DOM 代码。
- 宿主通过包的公共入口安装组件和提供依赖，不导入包内未导出的实现；框架变更仍在 NyaCore 仓库进行。
- 组件继续通过 `inject` 和本轮 `deps` 使用依赖。受信根控制面每次请求取当前服务，不缓存跨组件重启的引用。
- Session 继续持有会话、Run 和恢复事实；Run 负责准入与控制；RunRuntime 负责活动 program、操作与清理。不得因抽包重新分配这些职责。
- 业务库、Models 配置库、目录缓存库各有独占连接。图片目录由图片组件独占。各领域自行登记迁移，Session 接受事务继续固定附件引用。
- 当前 `harness.close()` 关闭整个根；迁移时必须明确宿主关闭入口，并保留停止准入、取消、等待真实退出和结算的时序。客户端断开只释放连接和观察，不等价于关闭实例或取消已接受 Run。
- 模块归属与安装位置分开判断。例如图片属于 Harness 模块，但宿主仍可在调用装配入口之前安装其组件；具体安装顺序和依赖就绪由实际组件契约与 Nya 管理。
- 多设备部署时，项目、模型配置、会话、Run 和附件属于目标实例；客户端资源引用与草稿需绑定稳定实例身份。访问同一实例可跨客户端，跨实例迁移会话是另一个显式能力。

## 6. 后续实施与验收

1. 提取 Harness 包、公共契约和现有组件，整理宿主、基础设施与客户端目录；首先保持本机现有行为。
2. 拆分混合的 Web 接入，并区分模块安装与完整应用关闭。独立宿主在无页面、无目录对话框的环境中能够装配执行能力。
3. 再设计并接入远程认证、实例身份、能力协商、项目登记与多实例客户端。浏览器直连还是宿主转发尚未在本文确定，不能视为已实现。

每个实施批次同步维护实际组件手册，运行根 `npm run check`。涉及取消、生命周期或资源归属的变更必须补充行为测试，保留现有幂等、事务、父链恢复、实际退出和旧历史只读兼容验收。

抽包验收还需确认：包不反向依赖应用源码；浏览器导出不带入 Node 运行实现；宿主能通过公共入口安装；独立发行物不依赖相邻 NyaCore 开发目录。现有 [Harness 测试](../tests/harness.test.mjs)、[多项目测试](../tests/multi-project.test.mjs)、[原生 Session 测试](../tests/native-session.test.mjs) 和 [Web 服务测试](../tests/web-server.test.mjs) 是迁移时需保留的行为入口。

远程常驻部署另需验证业务 SQLite 陈旧锁恢复、系统凭据库在无桌面 Linux 下的可用性、进程异常退出后的恢复及工具平台支持。当前 Bash 要求 Unix 宿主，现有目录树和本文规划均不代表已获得 Windows 或云端运行验收。
