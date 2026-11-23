# Agent Note: main 分支基础持续集成

Status: implemented

## 问题

默认分支 `main` 缺少工作流，提交和 PR 无法在 GitHub 上自动运行仓库的基础检查。

## 决策

在 Ubuntu 24.04 runner 上对发往 `main` 的 PR、推送和手动触发运行 `npm run check`。使用 Node.js 24 和 runner 自带的 Rust 工具链，按本地文件依赖的布局将 Anybox 和固定修订的 NyaCore 检出到相邻目录，先安装并构建 NyaCore，再安装和检查 Anybox。

## 备选方案

旧分支的原生验收工作流混合了三平台源码验证和桌面成品打包。当前桌面打包限定 macOS arm64，本次采用单一 Linux 检查入口。

## 影响与代价

PR 与提交可查看检查结果和步骤日志。NyaCore 修订需要在 Anybox 更新依赖时同步调整。工作流使用只读仓库权限。

## 验证

工作流通过 `actionlint` 1.7.12 检查，固定的 NyaCore 提交可在 GitHub 上读取。

在本机 Ubuntu 26.04、Node.js 24.16.0 上，从全新的相邻检出执行两个仓库的 `npm ci`、NyaCore 的 `npm run build` 和 Anybox 的 `npm run check`。类型检查和构建通过，2,509 项测试通过，22 项按条件跳过，0 项失败。

GitHub 收到 `main` 的推送并创建了首次运行。平台在分配 runner 前因账户限制阻止任务启动，云端的安装、构建和测试步骤均未执行。[首次运行记录](https://github.com/fanfan-de/AnyboxV2/actions/runs/45148793040)

## 关联

- [CI 工作流](../../../../.github/workflows/ci.yml)
- [开发依赖与命令](../../../../README.md#本地验证)
- [平台支持范围](../../../../docs/native-platform-support.md)
