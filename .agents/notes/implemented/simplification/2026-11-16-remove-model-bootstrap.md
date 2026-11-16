# Agent Note: 移除模型连接的兼容自动初始化

Status: implemented

## 问题

首次启用 Models 时，即使没有旧模型配置，也会自动创建“DeepSeek（迁入）”用户提供方、连接和默认模型。用户已将本机连接改为 models.dev 目录来源，并进一步要求删除该自动创建逻辑，后续从目录显式添加提供方。

## 决策

已删除 harness server 的旧环境变量模型引导、旧 Key 读取复制和自动连接/默认模型创建；新库启动只装配 Models、协议与目录。既有持久连接、配置、历史、Vault 引用，以及 JSON 对旧 SQLite 的实际数据读取兼容保留；不自动删除其他实例已有连接，不改目录和自定义提供方的正式管理 API。已清理旧引导选项、无人消费的安装返回值、桌面冗余回调、专属测试与当前文档，执行场景测试改为显式准备测试模型。

## 备选方案

未采用仅删除“迁入”名称或只对空环境跳过，因为仍会保留第二条自动创建路径。未采用清空既有模型数据，因为本轮目标是移除自动初始化，已有用户配置继续有效。

## 影响与代价

新实例无模型连接和默认执行模型，用户从 models.dev 目录添加提供方并保存 Key 后准备适用模型。旧 `ANYBOX_LLM_*` 不再被解析或导入。已有持久 `default` 模型与 Session 默认设置继续按原规则读取；退出与目录刷新仍由现有 Nya 组件持有，不新增组件。

## 验证

Linux、Node 24.16.0 下全仓 `npm run typecheck` 通过，包含全部工作区声明、应用与静态资源构建。受影响应用生命周期/独立服务/CLI/本机 Web 定向 28 项通过，HTTP 定向 40 项通过；配置与 Models 核心测试全部分支通过，覆盖空库、残留旧环境变量、旧 Key 不被触碰、目录显式添加/保存 Key/自动基础模型同步、最后连接删除后的空重启、SQLite → JSON 及完整稳定 default 读取、JSON 能力编辑历史，以及部分旧配置不补固定 default。通用基础模型同步仍按已有 Key/协议条件正常工作。

完整测试集中发现目录 Web 用例仍断言自动初始化一个模型，已改为验证连接及实际配置为空。最终执行 `node --test --test-concurrency=4 --test-timeout=180000 tests/*.test.mjs packages/*/tests/*.test.mjs`，共 2385 项，2363 通过、22 跳过、0 失败；跳过项不计入验收。`git diff --check` 通过，生产 TypeScript 中已无旧模型引导选项、环境解析或固定迁入身份的创建入口。

另完成受控产品浏览器 fixture 的启动/正常退出 smoke，未进行新一轮真实浏览器界面、真实模型网络、系统 Vault 或其他操作系统验证。当前用户实例没有重启；已保存的目录 DeepSeek 连接保持其持久数据，源码移除逻辑在后续执行端启动时使用。

## 关联

- [前项：本机连接切换至目录](../../implemented/process/2026-11-16-deepseek-catalog-connection.md)
- [模型装配](../../../../packages/app-harness/src/server-models.ts)
- [执行端配置](../../../../packages/app-harness/src/server-config.ts)
- [模型组件](../../../../docs/modules/models/models.md)
- [目录组件](../../../../docs/modules/models/catalog.md)
- [模型启动行为测试](../../../../tests/harness-server-models.test.mjs)
- [配置解析测试](../../../../tests/harness-server-config.test.mjs)
- [目录 Web 行为测试](../../../../tests/models-directory-web.test.mjs)
- [后续：清理旧定义并统一目录添加入口](2026-11-16-retire-imported-provider.md)
