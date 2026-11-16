# Agent Note: 通用 CLI 注册与兼容入口

Status: proposed

实现已在工作区完成；完整检查和规定归档/提交被环境阻塞。本轮环境将 `.agents/` 挂载为只读，向 `.agents/notes/proposed/architecture/2026-11-15-cli-framework.md` 写入返回 `Read-only file system`。本文暂存同格式记录，待可写环境归档，不代表已经满足规定路径。`.git/` 也只读，`git commit --dry-run` 无法创建 `.git/index.lock`，本轮没有新 commit。

## 问题

统一 anybox 入口只有角色启动命令，应用缺少不触碰业务资源的 CLI 注册、参数和输出契约。本轮仅在 feat/cli-framework-predev 实施预开发。

## 方向

application-api 的 `/cli` 定义并实现静态命令树、冻结注册目录、严格解析、执行上下文、版本化 NDJSON、结构化错误与固定退出码，`/cli-node` 负责标准输入输出、隐藏输入和取消信号。distribution 显式组合 Harness 元数据，只有执行叶命令才加载其模块；旧角色仍原样分派。help、版本和静态补全不加载业务实现。standalone 可把同一应用注册挂在根上并保持规范执行路径。通用框架不导入应用、数据库或 Nya 运行时。

## 备选方案

未采用在 host 中注册 Harness 业务命令，避免扩大宿主职责。未采用从磁盘任意扫描执行已安装包代码；与耐久安装身份、使用锚和卸载 guard 的衔接仍待单独实现，本轮支持受信组合目录。

## 影响与代价

新增 CLI 导出和 distribution npm bin，版本/输出约定只覆盖新 CLI；原 client/harness-server/computer-worker 的参数、help 和生命周期继续保留。应用负责取消与实际退出。静态组合 CLI 不等于已完成已安装应用发现。受限环境未完成全仓构建，因此不能标作已通过交付门禁。

## 验证

本机 shell PATH 没有 node/npm，实际命令均先使用 `export PATH=/home/fanfande/.local/share/gea-dev/node-v24.16.0-linux-x64/bin:$PATH`，Node 为 v24.16.0。

- 定向 strict TypeScript 编译 `packages/application-api/src/cli.ts`、`cli-node.ts` 及 Harness CLI 模块成功；使用 `node node_modules/typescript/bin/tsc --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --declaration --outDir …`，Harness 另指定 `--rootDir packages/app-harness/src`。最终编译没有使用 skipLibCheck。distribution 新入口额外用 esbuild transform 生成本地验证产物；这不是完整 distribution 类型检查。
- `node --test --test-isolation=none --test-timeout=20000 packages/application-api/tests/cli.test.mjs packages/app-harness/tests/cli.test.mjs`：24 项通过、0 失败，另 1 项 Windows 专用存储拒绝用例在 Linux 跳过。框架 7 项覆盖注册冲突/冻结、懒加载、参数、help/version/completion、JSON/退出码、错误脱敏、取消和 standalone 同实现。
- `node --test --test-isolation=none --test-timeout=20000 packages/distribution/tests/cli.test.mjs packages/distribution/tests/cli-framework.test.mjs`：4 项失败（原有 2 项和新增 2 项），子进程输出捕获为空。独立复现 `execFile(process.execPath, ['-e', 'console.log("CHILD_PROBE")'], callback)` 同样返回空 stdout/stderr 且 error 为 null；spawnSync 探针则报告 EPERM。这些子进程断言不能记作通过。
- 直接从 shell 使用 `node --import /tmp/anybox-cli-import-guard.mjs …` 验证统一/独立入口 help、版本、completion 和三个旧角色 help，拦截 Nya、Models、SQL、host、keyring 和 CLI 配置/执行模块导入，全部成功；统一/独立 start 元数据一致。直接验证了未知 token 参数退出 2、JSON stderr 和不回显原参数。
- 通过 `/tmp/anybox-cli-role-stub.mjs` 把三个旧角色入口替换为受控模块，直接核对 client 空参数、harness-server init 名称以及 computer-worker permissions 目录/id 的原样透传；未启动真实角色。
- `npm run check` 实际执行失败：typecheck 的 application-api 构建在原有 `src/nya.ts:97` 报 TS2353，当前相邻 NyaCore 的 `ComponentInstallOptions` 不含既有调用使用的 `bindings`；未进入 npm test。本轮未修改该 Nya 适配或相邻仓库。
- `git diff --check` 通过。全程未切换分支、merge/rebase、push、改远端或删除分支。

真实终端 raw mode/信号、完整发行安装和 macOS/Windows 未实测。完整门禁、子进程测试、正式 notes 归档及两个独立目标的 commit 仍需在具备相应权限和匹配 NyaCore 的环境完成。

## 关联

- [CLI 当前契约与用法](../cli.md)
- [Harness 方向与集成验证](2026-11-15-harness-cli.md)
- [变更记录规范](../../.agents/notes/README.md)
- [统一入口](../../packages/distribution/src/entrypoints/anybox-main.ts)
- [框架源码](../../packages/application-api/src/cli.ts)
