# 原生协议 Agent 框架设计与迁移验收

日期：2026-10-10（原生框架历史验收保留于文末；图片增量见[图片输入设计](./multimodal-image-input-design.md)，独立工具执行与活跃 Run 接续见[Computer 资源设计](computer-resource-design.md)）。正式组合根已切换原生框架；本文说明本次交付范围、固定契约和验收方式。最终检查结果见文末。先前草案中尚未采用的交互等待、文本导入和直接 exchange 接口不属于现行契约。

## 1. 范围与约束

四种协议为 Responses、Anthropic Messages、标准 Chat Completions 和 Gemini Interactions。DeepSeek 是使用标准 Chat Completions 的 Provider，不保留旧驱动或协议别名；旧协议历史仅供查看，不能续接执行。每种协议独立解释原生状态，共享 RunRuntime 的持久屏障、资源所有权、取消和退出保障。Session 沿指定成功父链保存完整原生恢复记录，可跨 Run、应用重启和分支继续；不能用文本投影替代恢复。

Models 升级为 0.2.0，移除统一 `models.open()`、`generate()`、ModelResult 与统一消息执行路径。保留配置、Vault、目录和驱动注册，提供 openNative、原生参数、版本化记录和恢复 codec。旧 dialogue-v1 Session 只读，不导入文本，不提供跨协议或跨账户转换。新 Session 使用 native-local-v1，在第一次接受事务中固定协议，失败和取消不解除绑定。

继续采用每个进程一个 Nya 根、Models 独立包、Session 独占业务持久化、受信静态工具目录与按 Session 固定的来源契约判别联合、实际退出后结算和 interrupted 不重放规则。四种协议均支持显式声明能力的静态本地图片输入。工具图片以文本工具结果之后的原生用户图片块支持。当前不包含模型图片输出、音频、PTY、独立远端后台任务、PDF/notebook、并行工具调度、动态插件注册、联网搜索工具或用户交互等待机制。

## 2. 已实现模块与职责

| 模块 | 入口 | 职责 |
| --- | --- | --- |
| Models 原生内核 | `packages/models/src/native-types.ts`、`execution.ts`、`component.ts` | 固定配置与凭据、驱动代租约、prepare/start、实际退出屏障、记录与恢复 |
| 协议驱动 | `packages/models/src/protocols/` | 原生参数、请求构建、JSON/SSE 消费、私有候选状态、restore/commit |
| 协议应用绑定 | `src/applications/harness/core/protocol-agents/registry.ts` | 固定驱动代、Loop、根输入/工具编码、历史策略与 program 闭包 |
| 四协议 Loop | `src/applications/harness/core/protocol-agents/{responses,anthropic,chat,gemini}.ts` | 原生停止原因、工具调用/回填、pause_turn、应用结束提案 |
| Run | `src/applications/harness/core/run/component.ts` | 幂等、选模、Prompt/历史检查、准备、接受事务与资源交接 |
| RunRuntime | `src/applications/harness/core/run/runtime-component.ts` | program、模型操作、工具观察、取消/清理协调、持久屏障与结算 |
| Computer / worker | `src/applications/harness/core/computer/`、`workspace/` | Authority 固定声明/绑定，独立 worker 持有工具及耐久执行账本 |
| 工具目录与执行器 | `src/applications/harness/core/tool/` | 静态来源契约、参数校验、Run 管道进程、文本读写及搜索；Nya 组件按资源拆分 |
| 图片资源 | `src/applications/harness/core/image/` | 原始字节、校验、目录排他、同事务保留、草稿续期与 GC |
| Session | `src/applications/harness/core/session/` | 会话、Run、节点、原生记录、账本、不可变恢复链和恢复规则 |
| 服务端展示 | `src/applications/harness/core/protocol-agents/projection.ts` | 白名单投影和原生流事件到有界展示状态 |
| 协议 Web | `src/applications/harness/web/protocols/` | 安全 decoder/reducer、输入编码和稳定 Turn 生命周期 |
| 共享 Web | `src/applications/harness/web/{session-client,session-view,workspace-client,run-change-client}.ts` | 分支、控制、订阅、重连、滚动与四面板 |

Models 不导入应用源码、Session、数据库业务表或工具实现。Session 只理解公共信封、归属与引用，不解释协议块。RunRuntime 不识别 finish_reason、stop_reason 或任何协议的停止条件。

## 3. 执行与退出契约

原生公共类型定义在 `packages/models/src/native-types.ts`。驱动登记的 `acquire()` 保留 I/R/E 类型参数；按动态 ID 查询驱动的受信入口使用 JSON 边界，再由对应协议校验形状。

| 契约 | 行为 |
| --- | --- |
| NativeParameters | `{ protocolId, formatVersion: 1, value }`，value 使用原生字段和嵌套结构 |
| NativeProtocolLease | 固定驱动 generationId/version，提供撤销 signal 和幂等 release；只能凭有效租约打开 execution |
| NativeExecution.prepareExchange(intent) | 无网络副作用地固定实际请求、上下文版本、增量记录和单次 start闭包 |
| PreparedNativeExchange | request配方引用 precedingRecordId 和本次 intent；start复核版本/代/单次消费 |
| OwnedOperation / ProtocolOperation | result 是结果，done 是实际工作和清理退出，cancel 仅请求取消 |
| NativeExecution.close() | 幂等结构化报告；保留本execution记录、未提交诊断、恢复元数据和cleanup状态；报告冻结后清除可变资源 |
| PreparedRunProgram | 闭包绑定 execution、Loop 与 codec；RunRuntime 调用 execute(host)/close，结算后 release租约 |
| RunHost.perform() | 持久意图→停止检查→同步启动登记→观察result/done→等待退出→提交观察→返回Loop |
| ProtocolConclusion | 仅为应用终态提案和结果记录引用，不统一每次API响应 |

Runtime 在首次异步读取前同步登记 program 所有权。同步拒绝表示未接管，Run 清理；接管后 Runtime 清理。请求准备后若持久意图失败，start 从未调用。观察提交失败立即停止后续操作。取消后仍提交已发生的工具结果和 Apply Patch 部分提交。

Models 只有在底层成功退出后才提交候选上下文；done 拒绝是失败退出，不无限等待悬空 result，迟到结果不能改变冻结报告。Runtime 还要关闭每 Run 进程 scope，经通用 tool-process-cleanup operation 保存最终退出观察，再等待 program.close 和所有工具退出；结果成功但 done/close 失败不能产生成功节点。cleanup 失败保留已知事实与固定错误，不能暴露原始提供方错误或凭据。

## 4. 协议支持矩阵

| 协议 | 请求/流 | 本地工具往返 | 原生记录与重启恢复 | 专属能力 | UI |
| --- | --- | --- | --- | --- | --- |
| Responses | JSON + SSE；store:false | function_call / function_call_output | 有序output、reasoning、encrypted_content、phase、item ID、call_id | web_search，URL citations | 文本/摘要/工具/搜索/正文引用 |
| Anthropic Messages | JSON + SSE；固定版本头，x-api-key | tool_use / tool_result | thinking/signature/redacted、有序content、原生ID | web_search_20250305；pause_turn自动续轮；服务端工具跨response关联 | 文本/摘要/工具/服务器搜索/引用 |
| Chat Completions | JSON + SSE | tool_calls / tool消息 | 原生messages、finish_reason、工具身份 | 互斥max_completion_tokens/max_tokens、reasoning_effort、显式thinking | 文本/工具/拒绝与异常状态 |
| Gemini Interactions | JSON + SSE；store:false | function_call / function_result | 有序steps、thought signature、函数身份 | generation_config；本地无状态历史 | 文本/摘要/工具 |

Responses 和 Gemini 不使用服务端会话、previous_response_id/previous_interaction_id 或后台任务。Anthropic 只执行客户端 tool_use，server_tool_use 不交给本地工具目录；暂停内容按顺序提交后，由Loop发起新的受管模型操作。拒绝、截断或不支持的完成状态保存原生事实，但本期不创建成功节点。

搜索默认关闭。必须保存模型 webSearch 支持声明并通过驱动验证，才能写入 Responses 的 `tools:[{type:'web_search'}]` 或 Anthropic 的 `tools:[{type:'web_search_20250305',name:'web_search'}]`。不由协议ID推断支持；不接入动态过滤或隐含代码执行的Anthropic版本。本地函数工具声明仍由应用固定，参数payload不能覆盖。

协议语义依据：[OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning)、[OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search)、[Anthropic server tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools)、[Anthropic web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)、[Gemini Interactions](https://ai.google.dev/gemini-api/docs/interactions-overview)。这些文档描述上游能力，本地验收结论仅覆盖上表范围。

## 5. 兼容、输入与 Prompt

幂等键查询先于当前配置、Prompt 与协议恢复。已接受键始终返回原 Run；同键改变原始输入、父引用或显式模型ID产生冲突。默认选模和显式选模均检查Session协议，接受事务再次核对所选父路径。

续接采用保守规则：同连接、固定远端模型与定义版本、相同语义参数和执行语义能力、相同工具契约，且记录/恢复格式可验证。streaming 只改变传输方式，允许开启或关闭后继续恢复完整原生上下文；内置驱动默认开启，只有显式 unsupported 才关闭。配置名称、展示信息或JSON对象属性顺序不属于语义变化。不同驱动代可在明确兼容记录格式与Loop版本时恢复，新Run始终固定新代，旧Run不被偷偷换实现。

非秘密 historyScopeEpoch 不使用Key哈希、Vault引用或凭据条目ID。成功更换/删除Key、改变地址/认证方式会更新；普通改名、超时调整、启停和目录刷新不更新；失败Key操作不更新。失去恢复兼容时明确拒绝，不能重建文本历史或隐式换账户。

Session 创建时复制 Agent 工具选择，首次接受 Run 固定 instruction、context 和实际工具声明；新初始化为 schemaVersion 2 / tool-library-v1，旧 v1 / known-tools-v1 原样兼容；所有根分支、首节点编辑/重新生成与首次失败后的新 Run 都复用同一初始化，各 Run 另固定执行配置；后代继承原始初始化。发布新初始指令不能改写旧会话链；使用新初始指令需新Session。每个新Run固定当前task-template，只处理本次原始输入一次。编辑与重新生成取原始输入和原节点父引用，`$&`、`{{input}}` 等字面内容不二次替换。

## 6. 持久化与迁移

Models独占配置库从v2升级v3；Session沿用run-state账本，v5 引入原生历史、v6 增加通用资源引用、v7 增加归档、v8 保存默认模型、v9 保存 Agent 工具配置及不可变 Session 工具选择，v10 保存独立活跃 Run 游标/owner、工具批次和清理/结算提案；图片组件用独立迁移域登记自身表。迁移阶段与行为测试仅使用临时库，未升级用户实际业务数据。三套库不建立跨库事务；任何组件迁移或初始化失败阻止Run准入并清理已安装资源。

### Models v3

当前配置在独占事务内进行纯函数转换，补齐连接epoch。保留ID、revision、versionId、baseline、启停、远端ID、定义版本和Key引用；不访问网络/Vault、不补运行时默认、不要求驱动已注册。历史版本JSON原样保存，通过读取兼容器识别。未知扩展或无法无损转换的数据保留formatVersion 0可读并要求迁移，禁止丢字段。

| 旧参数 | 原生转换 |
| --- | --- |
| Responses maxOutputTokens / 推理 | max_output_tokens / reasoning |
| Chat maxOutputTokens / 推理力度 | max_completion_tokens / reasoning_effort |
| Anthropic maxOutputTokens / thinking / effort | max_tokens / thinking / output_config |
| Gemini 输出上限和thinking | generation_config |

旧 DeepSeek 当前配置已通过停机时的一次性配置迁移改为标准 `chat-completions`，保留连接与配置 ID、凭据引用、epoch 和不可变历史。这不是运行期的通用转换规则；旧协议历史不能续接，新会话使用标准协议及显式保存的原生参数。

新基础配置、预设、设置表单和旧环境变量初始化都写原生参数。Anthropic新配置显式保存max_tokens:4096；旧配置保留旧值。迁移可重复进入，失败回滚整个本库事务。

### Session v5 至 v10

| 持久对象 | 内容 |
| --- | --- |
| Session | history_mode、首次protocol_id |
| Run | 原始/已渲染输入信封、绑定快照、schemaVersion 3模型快照、初始化ID、父恢复引用 |
| harness_native_initializations | 根指令、context与工具契约；不可变 |
| harness_native_records | 本Run增量request/response/diagnostic，原生ID与顺序；不可变 |
| harness_run_operations | 操作启动意图、观察及实际终态；不规定模型/工具转换顺序 |
| harness_native_contexts | 本Run最终链节、父链节、初始化引用、版本化checkpoint；不可变 |
| harness_native_results | 成功节点到最终结果记录的有序引用；不可变 |

请求记录只保存增量intent和版本；操作意图保存带前驱引用的重建配方。父恢复引用指向链节，不保存从根开始的ID数组；恢复时才在内存中展开对应路径。响应块只持久化一次，checkpoint只保存恢复元数据，不复制continuation。

成功终态在一个事务中提交最终记录、链节、Run状态、完整节点、结果引用和事件。失败、取消或cleanup失败只保存事实与诊断。Runtime 进程异常重启后，有效 response/cleanup/settling 游标可提升 owner 并接续原 worker 操作；无恢复凭证的旧 Run、响应未保存的 model-pending 仍 interrupted，保留事实并排空已有 scope，不重发模型或未知工具。四协议当前绑定 Loop 1.3.0，读取旧 Loop 1.0/1.1/1.2；驱动 2.1.0 和记录 v2 不变。旧节点、事件、schemaVersion 1/2及profile快照只读，不改写旧JSON。

## 7. Web、安全展示与资源限制

共享Thread外壳负责分支、Run控制、滚动和四面板；四个协议模块分别负责输入、原生嵌套参数表单、原生内容投影和内容组件。没有任意请求JSON编辑器。Turn以Run/节点身份稳定mount/update/dispose；对话区与轨迹明细共同挂载协议内容组件，轨迹列表保留派生摘要和搜索文本，每个模型调用只对应一个真实计时行。

`GET /api/runs/:id/view`：活动快照来自Runtime，历史快照从已提交记录投影。信封版本仍为1，viewSchemaVersion为2，包含Session/Run/protocol、exchange与内容ID、独立viewRevision及provisional/committed状态。内容type使用协议前缀判别，分别保留Responses message/output_text/refusal、reasoning、function_call、web_search_call，Anthropic text、thinking、redacted_thinking、tool_use、server_tool_use、web_search_tool_result，Chat content、reasoning_content、refusal、tool_calls，以及Gemini model_output/text、thought、function_call。阶段与原生停止状态附着在所属消息或exchange，不代替Run结算。当前帧是有界全量替换快照，便于断线校准；重复旧帧忽略，缺帧、重连、首次发现活动Run、终态触发重新查询，持久投影最终覆盖临时内容并保留稳定身份和组件实例。

SSE仍由最多四Session共用，同Run未发送快照可合并，保留256KiB队列预算与慢连接清理。服务端显示预算约48KiB，裁剪不修改原生记录，保留唯一截断提示并移除无效位置引用。工具最终结果由持久Run事件补全，通过Run、来源模型exchange、请求ID、名称及事件位置关联，不生成临时tools-N结果；待同步、读取失败和结果缺失单独表达。模型请求不表示实际执行成功，取消或清理失败仍显示已保存的真实工具结果和部分补丁事实。

浏览器仅接收白名单文本、摘要、工具状态、查询和安全http(s)引用；签名、redacted data、encrypted continuation、认证头及Vault引用不进入展示。Responses/Gemini使用“推理摘要”，Anthropic thinking使用“思考内容”，Chat reasoning_content使用“推理内容”，redacted_thinking独立显示隐藏占位；默认折叠，各面板的手动展开在流式、引用更新和终态替换中保留，刷新后恢复默认。位置有效的引用关联原始正文，无位置的安全引用显示块级来源；文本使用安全DOM写入。失败诊断只显示已保存的白名单部分内容和状态，不推断缺失信息或当作成功回复。

客户端、执行设备与Web资源同步升级展示v2，旧或未知展示版本明确不兼容，不维护展示v1兼容层。旧原生记录v1/v2在查询时重新投影，旧binding及历史JSON保留，展示版本不参与原生恢复兼容门槛；无需数据库迁移或驱动/Loop升级。旧dialogue-v1会话仍只读，并提供新建空会话入口；旧浏览器待提交键先查是否已接受，未接受内容只恢复草稿，不自动提交或转换。

## 8. 分阶段交付记录

| 阶段 | 当前交付 |
| --- | --- |
| P0 | 接受四协议/只读/保守历史范围；保留旧格式与原生响应fixture；临时库基线 |
| P1 | RunRuntime提取完成；所有操作经持久屏障，取消/退出/交接故障保留回归 |
| P2 | Models原生内核、类型化代租约、结构化close、参数v3、epoch与0.2.0 |
| P3 | Session v5、原子绑定/准入/成功引用、增量恢复链、interrupted不重放 |
| P4 | Responses完整工具→下次Run→重启闭环；安全视图HTTP与稳定Turn |
| P5 | Anthropic原生闭环及pause_turn；两种服务器搜索/引用能力 |
| P6 | Chat、Gemini原生Loop、codec、参数、恢复、展示与共享资源验收 |
| P7 | 正式组合根统一切换；旧执行器/统一API/旧写入删除；旧只读兼容与文档同步 |

过渡program没有留在正式源码；旧事件解析、快照读取与配置转换仅服务真实兼容需求。没有为未来功能预建组件。

## 9. 行为验收索引

开发前检查基线为435项，433通过、2项真实凭据门控跳过。迁移删去退役统一执行API专属测试，并用原生行为覆盖，不把测试数量作为语义完整性的替代。

| 约束 | 主要验证文件 |
| --- | --- |
| 资源退出、done失败、注册代、取消和晚到结果 | packages/models/tests/runtime.test.mjs、lifecycle-review.test.mjs、boundary.test.mjs |
| 四内置协议JSON/SSE与原生块 | packages/models/tests/protocols.test.mjs、anthropic-messages.test.mjs、gemini-interactions.test.mjs |
| v1/v2/v3迁移、历史JSON、epoch、配置能力 | packages/models/tests/storage-migration.test.mjs、storage.test.mjs、unified-models.test.mjs |
| 四协议工具→跨Run→重启→分支、记录增长、搜索暂停与私有投影 | tests/native-protocol-agents.test.mjs |
| 准入/交接取消、依赖撤销、waiter、清理失败 | tests/harness-server-core.test.mjs、models-harness-server-core.test.mjs、tool-loop.test.mjs、apply-patch-loop.test.mjs |
| 原子绑定、不可变引用、Prompt一次处理、旧只读 | tests/native-session.test.mjs、conversation-tree.test.mjs、conversation-migration.test.mjs |
| 长流裁剪、稳定块身份、原生记录不变与协议模块隔离 | tests/native-projection.test.mjs、protocol-web-modules.test.mjs |
| SSE、四面板、重连/迟到快照、DOM安全、参数/旧待提交 | tests/protocol-view-client.test.mjs、run-change-*.test.mjs、session-client.test.mjs、harness-server-http.test.mjs |
| 显式门控的真实API文本与重启续接冒烟 | tests/native-live-api.test.mjs |

全部自动验证使用临时SQLite、内存凭据及受控/模拟HTTP。真实浏览器验收使用同类本地宿主，覆盖刷新、工具往返、同父分叉、协议选择限制和旧会话只读。真实模型API和原生Vault跨平台验证独立门控；本地模拟不代表这些验收已完成。

## 10. 真实数据切换与回退

1. 通过应用宿主 `close()` 停止并等待全部execution、工具、凭据及写入退出。
2. 在无占用状态备份Models配置库、业务库与图片目录，保留目录缓存及凭据命名空间信息。
3. 启动新组合根，配置v3与业务v6分别事务迁移；任一失败则不接受Run，修复后可重复启动。
4. 核对新会话原生运行、旧会话只读、配置参数和Key状态，再开放正常使用。
5. 代码回退必须配合升级前数据库备份；禁止旧代码直接打开升级数据库，不回退Vault为明文。

此开发任务只实现及验证迁移，不操作真实业务库或发布部署。真实数据升级需遵循以上关闭、备份与恢复流程。

## 11. 独立联网验证入口

普通 `npm run check` 不调用真实模型。构建后，显式设置 `ANYBOX_NATIVE_API_TESTS=1` 和 `ANYBOX_NATIVE_API_PROTOCOLS`（逗号分隔的协议ID）才能运行选中协议的联网冒烟测试：

```sh
ANYBOX_NATIVE_API_TESTS=1 ANYBOX_NATIVE_API_PROTOCOLS=responses node --test tests/native-live-api.test.mjs
```

运行前另提供每个选中协议的 `ANYBOX_NATIVE_API_<ID>_ENDPOINT`、`_MODEL`、`_KEY` 和 `_PARAMETERS`；ID转大写并将连字符替换为下划线，例如 `ANTHROPIC_MESSAGES`。地址和模型ID由验证者明确指定；参数是原生JSON对象，必须显式包含正整数输出上限（Responses `max_output_tokens`、Chat `max_completion_tokens` 或 `max_tokens`、Anthropic `max_tokens`、Gemini `generation_config.max_output_tokens`）。不从现有配置或业务库推断任何值。

该入口使用临时SQLite、内存Vault与实际协议传输，验证首轮文本、关闭重开、指定成功父节点的文本续接及原记录不变。对显式选中的任一协议再设置 `ANYBOX_NATIVE_API_IMAGES=1`，会增加图片颜色识别及重启后沿图片父节点继续的验收；无需访问已保存 Key 或实际业务数据。它不构成工具、搜索、流式或跨平台凭据验收。系统凭据仍独立使用 `ANYBOX_KEYRING_TESTS=1` 门控。本次没有启用这两类真实验证。

## 12. 最终验收记录（2026-09-28）

- 根 `npm run check` 成功：TypeScript strict 检查与构建通过；473项测试，466通过、0失败、7项门控跳过。其中5项为真实模型API文本/重启冒烟，2项为系统凭据验证。
- Models 包独立验证180项全部通过；正式源码不再引用 `models.open()`、ModelResult、ModelMessage、旧AgentLoop或统一消息执行组装器。
- Chrome 使用临时SQLite、内存Vault与模拟HTTP验收文本发送、流式临时输出、运行中刷新校准、最终历史展示、Bash工具结果、同父分支、原文安全展示、搜索能力开关和旧会话只读。协议Web分派调整后另复验发送、流式及运行中刷新，控制台无error/warn；临时宿主与测试标签页已关闭。
- `git diff --check` 通过。未修改NyaCore，未升级实际业务数据库，未调用真实模型API，未执行真实系统凭据或跨平台验收。

### 项目文件输入扩展

应用输入现有 v1/v2 继续读取，v3 增加 files 快照引用；文件内容由 Run 准备后交给协议绑定，作为本轮用户文本保存进增量原生请求。原生驱动和记录格式不升级，Models 不解释项目路径，历史恢复不回源文件。详见[项目文件引用](project-file-references-design.md)。

### 工具库增量（2026-10-04）

三个 harness 来源的 20 个开发工具契约及两个既有 Anybox 工具进入统一静态目录，用户按 Agent 混选单个工具；配置更改只影响新 Session。run-state v9 原子复制会话选择并保留旧工具历史，新 NativeInitialization v2 携带版本化选择，新 Loop 1.2.0 继续读取旧 1.0.0/1.1.0；Models 驱动 2.1.0 与原生记录 v2 不变。

Codex exec/write 使用按 Run 的管道进程 scope；正常完成、取消和关闭均等待实际退出并保存通用清理观察。工具图片先随观察同事务保留，再附加用户图片块与资源引用；私有 resolver 只接纳已提交引用，base64 不写历史。验证入口为 tool-catalog、process-tools、file-tools 及 native-tool-library 测试，完整规则见[工具库设计](./tools-library-design.md)。
