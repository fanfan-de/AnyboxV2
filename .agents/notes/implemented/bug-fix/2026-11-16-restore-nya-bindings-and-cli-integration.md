# Agent Note: 补齐 Nya 服务绑定并验证 CLI 真实集成

Status: implemented

## 问题

修复前 CLI 分支全量构建在 `packages/application-api/src/nya.ts:97` 失败：相邻 NyaCore 的 `ComponentInstallOptions` 不接受 `bindings`。Anybox 主线 `0ffb8e8` 已在单机共根装配中依赖此选项及 `Context.resolveServiceName()`，而当时相邻 NyaCore `13431c5` 的源码、声明及本地完整提交历史均没有对应实现。既有单机方向记录曾说明跨仓实现并验证，当时检出的依赖却未包含它；现有证据支持跨仓改动未随该依赖交付或固定，不能据此推断原轮次从未实现。

## 决策

相邻 NyaCore 已补齐 `ComponentInstallOptions.bindings` 与 `Context.resolveServiceName()`，安装时校验并冻结绑定，子安装继承且可覆盖，名称只解析一次；依赖快照仍按逻辑名保留原代，提供、订阅、撤销及诊断使用实际服务槽。Anybox 保留一个进程一个根及两侧资源独立的既定方向。

CLI 集成新增受控 Run：先确认从真实回环 SSE 连接读取到字节，再中断观察并等待流退出，查询证明 Run 仍在运行，最后继续观察到完成。旧角色测试的未知命令断言同步到 CLI v1 的 usage 退出码 2，并继续验证无业务导入或文件创建。CLI 手册链接本轮证据；原临时预开发记录已补录到正式方向记录，区分原环境限制与后续验证结果。

## 备选方案

仅补类型或强制断言会让运行时继续忽略映射，不能解决数据库与 Models 重名；删除绑定会改变资源归属；在 Anybox 猴补框架或另建业务 Context 会绕过既有框架及单根约束，均不采用。修复前 NyaCore 本地无已包含此能力的提交可直接切换。

## 影响与代价

本目标需要同时交付相邻 NyaCore 与本仓改动。NyaCore 配套修复已提交到其本地 `main`，确切提交为 `11f959d577aecbd18b9ef14be4bee6e11f9a9a42`（`fix(core): preserve explicit service bindings across lifecycle coordination`）；当前 `file:../NyaCore/packages/core` 依赖需配套该提交，不能只交付 Anybox 分支。框架公开 API 基线、README 与 CHANGELOG 同步维护。验证实例使用独立 `/tmp/anybox-cli-framework-Irrg8g` 数据目录及回环端口 3100/3101，不复用其他服务的库或端口。CLI 目标使用该测试实例单独发行的令牌，不在输出或文档保存令牌。

## 验证

- 已复现 Node v24.16.0 下 `npm run build` 在上述 `bindings` 类型检查处失败；核对双方源码及提交历史，确认当前 CLI 分支相对主线没有修改 `nya.ts`。
- NyaCore `npm run check`：322 项通过；随后新增仅测试的同槽别名回归，Core strict typecheck 与完整 Core 133 项通过，其中服务绑定专项 7 项。`api:check` 的 5 个包、`docs:check` 的 9 个 Markdown 与 `git diff --check` 均通过。覆盖双实例、快照冻结、父子继承/覆盖、单次映射、实际槽诊断、撤销等待、特殊服务名及多逻辑名共享同槽。
- 2026-11-16 提交前再次通过 NyaCore `docs:check`、`api:check`、Core strict typecheck 与 Core 全部 133 项测试（含绑定专项 7 项）；未修改既有实现，未重复运行框架全仓检查。
- Anybox 环境补齐现有 Node/Rust 的 PATH，并通过 `npm install --ignore-scripts --offline` 恢复缺失的 `tool-api`、`computer-tools` workspace 链接；没有改变 lockfile 或依赖版本。全量 `npm run build` 通过。
- `node --test --test-concurrency=4 --test-timeout=60000` 对 CLI 框架、Harness CLI、真实 HTTP/SSE、distribution 入口及 `local-web-host` / `web-local-pairing` 共 7 个测试文件运行：40 项，39 通过、1 项 Windows 专用用例在 Linux 跳过；真实 HTTP/SSE 3 项全部通过。使用临时数据库、内存凭据及受控模型，没有真实付费模型调用。
- 首轮 Anybox 全仓检查：2386 项，2361 通过、3 失败、22 跳过。一个失败为旧角色测试仍期望未知命令退出 1，修正后 `runtime-roles.test.mjs` 3 项通过；另两个为主线已缺失的示例资料，独立补录见[示例修复](2026-11-16-restore-notes-example-data.md)。最终 `npm run check` 完整通过：类型检查、全量构建及 2386 项测试，2364 通过、22 项门控跳过、0 失败。
- 实际启动 distribution 的单机 `serve.js`，监听 3100/3101；客户端首页与应用管理 HTTP 200，CLI `target check`、`agents list`、`models list`、`projects list` 均成功。浏览器打开并重新加载 Harness 工作区，本机目标可见，控制台无 error；测试实例尚未配置真实模型 Key。
- 仅验证本机 Linux Node；Windows/macOS、Electron、真实模型及真实终端隐藏输入/信号未由本轮验收。

## 关联

- [单机共根原方向](../architecture/2026-11-15-single-process-local-web.md)
- [CLI 当前契约](../../../../docs/cli.md)
- [框架方向记录](../architecture/2026-11-16-cli-framework.md)
- [Harness CLI 方向记录](../feature/2026-11-16-harness-cli.md)
- [真实 HTTP/SSE 集成测试](../../../../packages/app-harness/tests/cli-server.test.mjs)
