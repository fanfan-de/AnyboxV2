# Agent Note: 理清执行环境设置的主线

Status: implemented

## 问题

客户端电脑的 worker 和对外连接表单占据执行环境页面的首屏。用户难以找到当前执行设备可用的环境，也容易把执行设备的本机与客户端所在电脑混为一谈。

## 决策

两款应用以“执行环境决定 Agent 的工具在哪里运行”为页面主线。先展示所选执行设备可用的电脑和状态，再展示工具来源。设备身份与权限放在环境详情中。接入另一台电脑、管理客户端 worker、将其连接到其他执行设备分别按需展开。设置关闭或表单收起时清除附着码。

## 备选方案

只压缩表单仍会让两种设备使用同一叙述顺序。将 worker 移回连接管理则会分开跨设备接入的两端。保留同一入口并按用户任务安排顺序。

## 影响与代价

Computer 接入和客户端 worker 管理各增加一次有明确含义的展开操作。两种 API 仍以各自设备为目标，已提交的写入沿用原有退出等待。

## 验证

两款应用工作区构建、浏览器资源检查和 `git diff --check` 通过。`units-client`、`settings-client` 和 `desktop-local-pairing-ui` 共 29 项测试通过，覆盖无执行连接时的 worker 管理、默认折叠、权限操作、结束时清码和已提交请求退出等待。macOS 桌面开发版重启后检查了 Anybox Harness 的无连接与已连接首屏，两种表单的展开与收起，以及 worker 运行状态。Personal Agent 布局由测试覆盖。未在真实设备之间创建附着。

## 关联

[此前的 worker 管理入口](../feature/2026-11-22-computer-worker-environment-settings.md) · [Computer worker 独立管理](../../../../docs/computer-worker-management.md) · [执行环境设置测试](../../../../tests/units-client.test.mjs)
