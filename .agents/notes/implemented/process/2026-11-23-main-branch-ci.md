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

工作流通过 `actionlint` 1.7.12 检查。已核对固定的 NyaCore 提交可在 GitHub 上读取。云端类型检查、构建和测试的结果保存在 [CI 运行记录](https://github.com/fanfan-de/AnyboxV2/actions/workflows/ci.yml)，验证范围为 Ubuntu 24.04 的源码检查。

## 关联

- [CI 工作流](../../../../.github/workflows/ci.yml)
- [开发依赖与命令](../../../../README.md#本地验证)
- [平台支持范围](../../../../docs/native-platform-support.md)
