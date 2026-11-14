# Agent Note: 独立资料库环境接入示例

Status: implemented

## 问题

环境工具契约已经接入，需要用实际可运行示例验证：新增环境只增加提供方和装配配置，现有 Agent、协议 Loop 与 RunRuntime 无须修改，环境提供的工具能进入新会话并真实执行。

## 决策

新增示例资料库环境，提供 `notes_search` 与 `notes_read`，仅依赖 tool-api；资料由装配读取真实 Markdown 文件为不可变快照，环境不持有后台资源。示例程序使用既有 Models 原生驱动、Harness 与耐久会话，用离线模拟模型驱动真实工具往返；分别观察未插入、插入后新会话与原会话的工具清单。

## 备选方案

- 只提供聊天伪代码：无法验证实际注册、模型声明与调用路径。
- 访问真实模型或外部资料服务：本轮验证接入边界，不需要 API Key、外部账号或付费调用，采用离线模型明确区分验证范围。
- 再修改 Agent 内核支持此环境：已有通用契约足够，示例以不修改现有 Harness 源码为验收条件。

## 影响与代价

仅新增示例、测试和文档；示例程序使用临时目录与数据库，不读取用户的业务库、Vault 或模型配置。资料为启动时固定快照；环境配置仅影响新会话。未实现原操作耐久查询时不声明恢复能力，继续使用默认拒绝未知调用重放的规则。

资料字节只在本次提供方实例内固定；Session 保存环境身份、版本和工具契约，不承诺跨重新装配保留旧资料。离线 fixture 只替代上游模型传输，不替代协议 Loop 或 Agent。

## 验证

- `node examples/tool-environments/notes/demo.mjs`：实际搜索并读取 Markdown；模型请求与事件中出现 `notes_search`、`notes_read`；插入前及插入后的旧 Session 仍为空工具集；Computer 操作数为零。
- `node --test tests/tool-environment-example.test.mjs`：3/3 通过，包含独立提供方、快照隔离、取消/关闭、未知恢复拒绝及实际原生 Agent 集成。
- 对两个示例 `.mjs` 执行 `tsc --allowJs --checkJs --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --types node`：通过。
- 与本轮开始保存的 SHA-256 映射比较，`packages/app-harness/src` 全部 167 个文件无修改、增删；`git diff --check` 与文档本地链接检查通过。
- 根 `npm run check`：类型检查、构建与全量测试通过，2312 项 / 2295 通过 / 17 跳过 / 0 失败。验证平台为 macOS arm64 / Node 24.16；模型传输是离线 fixture，未验证真实模型决策、远端资料服务或其他平台。

## 关联

- [环境提供工具](../../../../docs/tool-environments.md)
- [可运行示例](../../../../examples/tool-environments/notes/README.md)
- [独立环境实现](../../../../examples/tool-environments/notes/environment.mjs)
- [行为验证](../../../../tests/tool-environment-example.test.mjs)
- [环境工具拆包方向](../architecture/2026-11-15-environment-owned-tool-packages.md)
