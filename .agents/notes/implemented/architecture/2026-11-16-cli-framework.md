# Agent Note: 通用 CLI 注册与兼容入口

Status: implemented

本篇于 2026-11-16 补录原预开发方向。原临时记录以 `2026-11-15` 命名，提交 `d481449` 于 2026-11-16 收录实现和记录；文件名不足以确定实际开发时间。正式记录替代原 `docs/cli-predev-notes/2026-11-15-cli-framework.md`，原受限环境的验证结果与后续交付验证在下文分开说明。

## 问题

统一 `anybox` 入口原先只有角色启动命令，应用缺少不触碰业务资源的 CLI 注册、参数和输出契约。

## 决策

在 application-api 的 `/cli` 提供静态命令树、冻结注册目录、严格参数解析、执行上下文、版本化 NDJSON、结构化错误与固定退出码，`/cli-node` 适配标准输入输出、隐藏输入和取消信号。distribution 显式组合应用元数据，执行叶命令时才加载实现；help、版本和静态补全不加载业务实现。独立入口复用同一注册与规范命令路径，原角色启动命令继续原样分派。

通用框架不导入具体应用、数据库或 Nya 运行时；应用自己负责操作取消和实际退出。

## 备选方案

未采用在 host 中注册 Harness 业务命令，避免扩大宿主职责。未采用任意扫描并执行磁盘上的已安装应用代码；当前使用受信组合目录，已安装应用 CLI 的耐久包身份、使用锚和卸载 guard 衔接留待独立实现。

## 影响与代价

新增 CLI 公共导出与 distribution npm bin，版本化输出和退出码契约覆盖新 CLI；未知命令采用 usage 退出码 2。原 `client`、`harness-server`、`computer-worker` 的参数透传和生命周期保留。没有新增 Nya 组件或应用包归档入口字段；静态 CLI 注册不代表已完成已安装应用发现。

## 验证

- 原预开发轮次完成 strict TypeScript 定向编译、框架与 Harness 共 24 项通过的单元测试，以及 guarded help/版本/补全与角色参数透传验证。该轮子进程测试受输出捕获/EPERM 限制，完整构建又被相邻 NyaCore 缺失 `bindings` 阻塞；这些历史结果没有计为完整通过。
- 后续补齐框架依赖后，在 Linux Node v24.16.0 运行 CLI、distribution 及单机共根相关 7 个文件：40 项，39 通过、1 项 Windows 专用用例跳过。旧角色测试已适配未知命令退出码 2，3 项通过。
- 最终根 `npm run check` 完整通过：类型检查、全量构建和 2386 项测试，2364 通过、22 项门控跳过、0 失败。修复及完整验证证据见[后续修复记录](../bug-fix/2026-11-16-restore-nya-bindings-and-cli-integration.md)。
- 真实终端隐藏输入/信号、macOS/Windows、Electron 与完整发行安装未由本轮验收。

## 关联

- [CLI 当前契约与用法](../../../../docs/cli.md)
- [Harness CLI 方向](../feature/2026-11-16-harness-cli.md)
- [统一入口](../../../../packages/distribution/src/entrypoints/anybox-main.ts)
- [框架源码](../../../../packages/application-api/src/cli.ts)
- [框架测试](../../../../packages/application-api/tests/cli.test.mjs)
- [distribution 入口测试](../../../../packages/distribution/tests/cli-framework.test.mjs)
