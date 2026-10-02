# Prompt 组件

[返回 Prompt 模块](./README.md)

## 职责与组件契约

Prompt 管理用户拥有的提示词文档、可编辑草稿和不可变发布版本；它提供受权限检查的管理接口，并为受信组件提供发布版本读取。它不选择 Agent 绑定，也不执行模型调用。

| 项目 | 定义 |
| --- | --- |
| 工厂 | `createPromptComponent(inputs, legacyJsonPath?)` |
| Nya 组件名 | `harness-prompts` |
| 提供服务 | `harness.prompts`，接口 `PromptPort` |
| 注入依赖 | `local-storage` |
| 入口 | [component.ts](../../../src/applications/harness/core/prompt/component.ts) |
| 领域与存储 | [domain.ts](../../../src/applications/harness/core/prompt/domain.ts)、[sqlite-storage.ts](../../../src/applications/harness/core/prompt/sqlite-storage.ts) |

`inputs.now()` 和 `inputs.newId()` 由宿主注入，分别产生审计时间和文档/版本 ID，便于测试固定输入。可选 `legacyJsonPath` 仅用于一次性读取旧 Prompt JSON；正常写入全部进入业务 SQLite。

## 数据与校验

`PromptDocument` 包含 ID、ownerId、名称、描述、当前 draft、已发布草稿修订号及有序 versionIds。草稿保存 revision、kind、role、content、updatedAt 和 updatedBy。`PromptVersion` 独立保存发布时的用途、角色、正文、所属文档与用户、创建审计字段，之后不可修改。

| 用途 `kind` | 允许的角色 | 约束与用途 |
| --- | --- | --- |
| `agent-instruction` | `system`、`developer` | Agent 的初始行为指令 |
| `context` | `developer`、`user` | 初始背景上下文 |
| `task-template` | `user` | 正文必须恰好包含一次 `{{input}}` |

名称去除首尾空白后必须非空，最多 200 字符；描述最多 2,000 字符，缺省为空字符串；正文必须非空且最多 100,000 字符，原正文保留。正文的角色组合由领域函数校验，具体协议是否接受该角色由协议应用层另行检查。

## 服务接口

| 方法 | 行为 |
| --- | --- |
| `createPrompt(actorId, input)` | 创建归该 actor 所有的文档，草稿 revision 从 1 开始 |
| `editPrompt(actorId, id, expectedRevision, patch)` | 修改名称、描述、用途、角色或正文；校验修订号并递增 revision |
| `publishPrompt(actorId, id)` | 将当前草稿发布为新版本，事务内追加历史并更新发布标记 |
| `getPrompt(actorId, id)` | 读取本人的文档；不存在返回 `undefined`，越权报错 |
| `listPrompts(actorId)` | 只列出该 actor 拥有的文档 |
| `getPromptVersions(actorId, id)` | 按发布顺序返回指定文档的版本；不存在或越权报错 |
| `getPublishedVersion(id)` | 供受信消费者读取版本；不接收 actor，也不执行用户授权 |

`actorId` 由宿主确认，不能使用客户端自报身份充当权限依据。`getPublishedVersion` 不从 Harness 管理门面暴露；Nya 服务名称本身也不是访问控制。

## 编辑、发布与并发

领域函数先生成新值，内部存储将写入串行排队，再在事务提交后更新内存读取投影。编辑在入队执行时复核 revision，数据库 UPDATE 同时检查旧 revision，避免两个编辑覆盖彼此。发布会检查是否已有相同草稿版本；没有新草稿变更时拒绝重复发布。

发布版本与发布标记同事务提交。并发发布和编辑时，存储以已提交版本历史为准，保留先前 versionIds 和 publishedDraftRevision，避免后到的草稿覆盖已发布记录。写入失败不会把候选数据暴露为已提交投影。

发布不更新任何 Agent 绑定。需要调用 [Agent Prompt](./agent-prompts.md) 的 `bindPrompt()`，且版本选择只影响之后按 Session 规则解析的新请求。

## 持久化与旧数据导入

组件初始化登记 `prompt` 领域迁移，拥有 `prompt_documents`、`prompt_versions`、`prompt_json_import`。SQLite 连接、文件锁和事务队列归 [业务存储组件](../infrastructure/local-sqlite.md)，Prompt 仅拥有领域状态与已接受写入。

旧 JSON 导入要求 Prompt 数据为空，在事务内写入文档、版本及导入路径标记，保留原文件。同一路径重启不重复导入；换用其他路径或在已有文档后首次导入会失败。初始化从数据库重建投影并校验版本归属、顺序及发布状态；无效存储内容使初始化失败。兼容读取实现见 [legacy-json-import.ts](../../../src/applications/harness/core/prompt/legacy-json-import.ts)。

## 生命周期、错误与边界

`apply` 完成迁移、可选导入及投影加载后发布服务，通过 Effect 登记关闭。关闭停止新的写入准入，等待队列中已接受的写入完成。Prompt 不拥有模型或工具句柄；依赖它的 Agent Prompt、Run 等由 Nya 按依赖关系先清理。不要在卸载后继续使用缓存的旧服务引用。

错误包括输入非法、`prompt access denied`、未知文档、`prompt draft revision conflict`、草稿没有未发布变更及存储关闭/写入失败。当前没有删除文档、删除版本、共享文档或批量授权接口。纯状态转换可直接测试；替换存储服务必须保留版本不可变、提交后可见和关闭等待语义。

## 验证入口

- [prompt-management.test.mjs](../../../tests/prompt-management.test.mjs)：用途与角色、权限、发布与编辑并发、重启恢复、旧 JSON 导入及依赖卸载。
- [prompt-sqlite-storage.test.mjs](../../../tests/prompt-sqlite-storage.test.mjs)：卸载等待已接受写入、关闭后拒绝新写入及重新安装读取。
- [native-session.test.mjs](../../../tests/native-session.test.mjs)：Session 固定初始提示词与原始输入续接行为。

从仓库根运行 `npm run check`。更多业务背景见 [Prompt 管理设计](../../prompt-management-design.md)。
