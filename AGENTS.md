# AnyboxV2 协作说明

当前分支直接基于相邻的 `../NyaCore` 开发 Agent Harness。`src/agent/`、`src/credentials/`、`src/llm/`、`src/run/`、`src/prompt/`、`src/project/`、`src/tool/` 和 `src/storage/` 按职责与可替换边界组织已有领域函数、服务组件和提供方；`src/harness.ts` 是受信组合根；`src/resource-probe.ts` 保留 H0 资源归属探针。只为当前阶段已有实现建目录，不预建后续工具或宿主组件。`src/run/` 中 Session 服务负责入口，Run 服务负责准入与控制，AgentLoop 独占在途调用与清理，SQLite 状态组件共同持有 Session 和 Run 数据，Projects 组件持有项目目录身份。`tests/` 验证 Run 行为、取消和清理等待；`docs/agent-harness-plan.md` 记录阶段与验收，`docs/harness-components.md` 说明各组件；增删组件或改变其服务、依赖与清理行为时同步更新。目前完成无网络的 H1 闭环、多项目持久 Run 状态和受控 Bash 工具循环；DeepSeek 原生工具协议与 Web 过程展示已接入，OpenAI Responses 保持纯文本，流式输出尚未接入。

当前只使用一个应用 Nya 根 Context：凭据组件、大模型 API 组件、本地 SQLite、Prompt、Projects、Bash、状态、Session、Run 和 AgentLoop 等已有组件都直接安装在根上，不建立专门的 Harness 作用域，项目仅为数据归属边界，不设项目或任务 Context。组件仍按真实依赖和资源所有权拆分；Nya 服务按名称在根上注册。应用拥有根上组件的关闭时机；当前 `harness.close()` 是关闭入口，会先阻止新调用，再卸载根上的全部组件并等待清理，包括大模型 API 组件的在途请求和 SQLite 连接。关闭后的 Harness 门面不可复用；重启应用需重新装配组件，通常新建根。通用存储不接收领域迁移列表，各领域组件在 `apply` 中通过 `migrate(domain, migrations)` 登记自己的表。

整个应用启动时只安装一种大模型 API 组件。组件按 API 格式划分（当前为 `src/llm/deepseek-chat-completions/` 的 DeepSeek Chat Completions），直接拥有原生请求格式、HTTP 传输、密钥使用、响应解析、超时、取消与清理，不设独立的供应商适配器层，也不预建其他 API 格式的组件。Run 和 AgentLoop 只依赖 `src/llm/port.ts` 中的最小服务契约；供应商原生的请求与响应类型不得扩散到 Run、状态、Prompt 等组件，凭据不得进入 Run 状态或对外快照。

密钥由 `src/credentials/` 的凭据组件保管，应用只安装其中一种：系统凭据库组件通过 `@napi-rs/keyring@2.1.0` 接入 macOS Keychain、Windows Credential Manager 和 Linux Secret Service（明确禁止回退到内核 keyring），提供 `credentials.read` 与受信宿主使用的 `credentials.manage`；外部来源组件只把无桌面部署方的读取函数接成 `credentials.read`，不落盘也不回退到 SQLite 或明文文件。大模型 API 组件通过 `inject` 获取 `credentials.read`，在每个 Run 的首次 `llm.call()` 内异步读取一次密钥，缺失或读取失败使该 Run 以固定类别失败，`llm` 服务仍可启动。写入或删除成功即影响后续读取，无须重启组件；已读取密钥的 Run 继续使用已取得的值。同一密钥的读、写、删按凭据组件接收顺序执行。原生模块类型、错误和密钥值都留在凭据边界内，凭据错误只有固定类别。`credentials.manage` 与 `credentials.read` 分开注册只是命名约定，Nya 服务不构成访问边界，Harness 门面不转发它。可移植的 `packages/api-key-manager` 包实现通用服务端 Key 管理与系统凭据库存储，不依赖 Anybox 或 Nya；`src/credentials/` 只提供本项目的 Nya 适配。本机 Web 宿主安装自包含的 `createApiKeyServiceComponent`，它不注入其他项目组件，同时提供 `credentials.read` 与 `credentials.settings`；注册允许在 Web 管理的凭据 ID、名称和类别。Web 只注入该服务，不能硬编码某个模型的凭据 ID，也不能接受未注册 ID。真实凭据库测试以 `ANYBOX_KEYRING_TESTS=1` 门控，不进入默认 `npm test`；只有在对应系统上通过才能宣称该平台已验收。

深度使用 NyaCore 的组件式框架：按真实资源和替换边界拆分模型、状态、Session、Run 准入、AgentLoop 和 Bash 等服务组件，由 Nya 负责依赖就绪、重启和清理顺序。Agent 定义是启动时校验的只读配置，由组合根传给 Session、Agent Prompt 和 Run，不建立独立 Nya 组件；修改定义需重新装配 Harness。不要在组合根手工复制依赖图或生命周期。组件通过 `inject` 声明服务，并从 `apply(ctx, config, deps)` 的 `deps` 使用本轮依赖快照；受信根控制面处理外部请求时用 `context.get()` 获取当前服务。不要缓存跨组件重启的服务引用。只从 `@nya/core` 公共入口导入；框架修改在 NyaCore 仓库进行。保持 TypeScript strict。

在合适的位置使用函数式编程：输入校验、提示词组装、状态转换与恢复计划写成无副作用的函数，以显式参数传入时间、ID 和决策，并返回新值。副作用集中在模型、工具、状态提供方、Nya 装配和宿主边界；使用函数组合与闭包管理组件行为和生命周期，不新增业务类。不要为了追求纯函数而绕开 Nya 的服务注入、Effect 或资源所有权。

组件 `apply` 完成初始化后返回，不能让长期执行循环阻塞启动。组件资源通过 Effect 登记清理；在途操作必须支持显式取消和等待实际退出，`result` 与 `done` 的含义不得混淆。关闭先停止接收新 Run，再取消并等待已接收的调用。进程信号与强制退出由未来宿主负责。

只在当前阶段定义必要契约，不按历史计划预建组件目录。项目自有契约保持模型、工具、状态和策略实现可替换；第三方类型、错误和生命周期不得越过对应适配器边界。持久状态提供方须持有单实例排他所有权；异常退出的 Run 明确结算 interrupted，不自动重放外部副作用。

迭代替换实现时，同步删除不再被当前运行路径或明确兼容需求使用的旧实现、入口、专属测试和文档描述，不在源码中保留“以后可能用到”的历史方案。确需兼容旧数据时，只保留实际读取或迁入所需代码，并用旧格式样本验证；不要继续维护已停用的旧写入提供方。删除前检查所有引用和已有数据的兼容性。

修改取消、生命周期或资源归属时同步更新行为测试。完成变更运行 `npm run check`。修改 NyaCore 后先停止 `nya:watch`，运行 `npm run nya:build` 成功后再验证本项目。
