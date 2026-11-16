# Agent Note: 补齐资料库环境示例的静态文档

Status: implemented

## 问题

全仓检查中资料库环境示例的两个用例在读取 Markdown 时返回 ENOENT。`main` 的 Git 树只包含示例的 README、demo 与环境实现，缺少 `loadExampleNotes()` 固定读取的两个资料文件；根 `.gitignore` 的 `data/` 规则也会忽略示例资料目录。这是主线已有的样本交付缺失，与本轮 Nya 服务绑定和 CLI 改动无关。

## 决策

补齐两个最小静态 Markdown 样本，并只为这两个文件添加精确的 Git 忽略例外。保留示例从真实文件建立不可变内存快照的现有行为，运行资料与静态样本继续分开。

## 备选方案

未采用删除资料读取、把正文内嵌到 demo 或放宽全部 `data/` 忽略规则：前两者改变示例验证的接入路径，后者会把其他本机运行资料纳入可追踪范围。

## 影响与代价

只增加示例静态资料和版本控制例外；不改变业务代码、数据库、凭据、环境契约或资料资源归属。

## 验证

- 已核对 `git ls-tree -r --name-only main -- examples/tool-environments/notes` 与 `git show main:tests/tool-environment-example.test.mjs`，确认缺失与对应读取/断言都存在于主线；`data/` 通用忽略规则命中缺失路径。
- `node --test --test-timeout=20000 tests/tool-environment-example.test.mjs`：3 项通过，覆盖独立环境资料读取、快照/取消边界，以及插入环境后新会话的真实工具调用与旧会话契约保留。
- `node node_modules/typescript/bin/tsc --allowJs --checkJs --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --types node examples/tool-environments/notes/environment.mjs examples/tool-environments/notes/demo.mjs`：通过。
- `git status --short --untracked-files=all` 确认两个 Markdown 样本可追踪；`git check-ignore -v` 确认示例目录内其他 JSON、嵌套运行资料和根 `data/` 仍被忽略。`git diff --check -- .gitignore` 通过。
- 本小修复使用现有离线模型 fixture，没有执行真实模型调用或系统凭据验收。

## 关联

- [原示例方向](../feature/2026-11-15-notes-environment-example.md)
- [示例说明](../../../../examples/tool-environments/notes/README.md)
- [示例资料加载](../../../../examples/tool-environments/notes/demo.mjs)
- [行为测试](../../../../tests/tool-environment-example.test.mjs)
