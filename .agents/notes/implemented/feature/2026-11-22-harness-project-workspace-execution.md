# Agent Note: 同一 Harness Run 使用项目中的多个工作区

Status: implemented

## 问题

开发者需要在开发机改代码、测试并交付版本，同一 Agent 还需要在目标服务器部署和看日志。原项目只保存一个目录和 Computer，接入两台设备后仍需分开运行。

## 决策

Projects 保存主工作区和附加工作区。创建会话时选择本次需要的工作区，默认只选主工作区。每种工具的模型可见名称对应一个确定的工作区，执行时按该设备上的原工具复核授权。Computer 为同一 Run 的不同工作区分别管理进程、目录和操作回执。桌面项目侧栏提供工作区管理入口。制品交付复用项目的发布渠道。

## 备选方案

[前期设计](../architecture/2026-11-22-harness-project-multiple-computers.md)比较过全局切换设备和修改所有工具参数。用工作区限定工具名可以保留原始工具契约，执行时复核每台设备的权限，恢复时沿用原目标。

## 影响与代价

Anybox Harness 的项目库、会话和 worker 操作记录升级。历史项目以原有设备和目录为主工作区，普通旧会话维持原有工具名。参与一个 Run 的设备越多，模型收到的函数声明也越多。测试结果与部署之间的版本传递、发布请求去重和服务健康检查由项目的发布系统提供。

## 验证

在隔离的 macOS 工作副本执行 `npm run check`，类型检查和构建通过，2,504 项测试通过，18 项按运行条件跳过。

- 浏览器实际操作经过客户端网关和已配对的独立 worker，覆盖添加工作区、勾选服务器创建会话、取消、改名、移除与窄屏布局。
- macOS arm64 的 `ANYBOX_KEYRING_TESTS=1 npm run desktop:smoke` 通过，复用同一临时配置再次启动也通过。真实 Electron 运行了默认工具的写入和读回、本机 Run 退出及远端 Run 继续执行。验证中发现源码桌面首次启动独立 worker 时缺少 Node 路径，开发启动脚本现默认传入自身的 Node。冒烟测试在退出后重新获取数据库和检查点的排他锁。此次桌面验证使用源码入口，未更换已安装的应用。
- [路由联调](../../../../tests/computer-worker-router.test.mjs)在同一 Run 修改开发目录、运行测试、发布按 SHA-256 寻址的制品，并在另一个工作区获取同一版本、检查服务健康状态和读取发布日志。三台 Computer 的用例验证选择顺序与派发目标相互独立。
- 在同一发布流程注入两次故障。本地测试失败时，制品仓未收到发布请求，服务器未执行部署。制品仓返回错误内容时，服务器报告摘要不匹配，原部署文件、健康接口版本和发布日志均保持原值。
- [故障恢复](../../../../tests/computer-unit-faults.test.mjs)在已产生两端副作用时强制终止 harness server，恢复后两边操作各执行一次。[Computer Operations](../../../../tests/computer-operations.test.mjs)覆盖被确认入队和首次响应丢失两种查空情形，都保留原操作并避免重新提交。
- 执行库升级到布局 3 后，旧版 Harness 在取得写入权前收到不兼容错误。同宿主中的 Personal Agent 仍可按布局 2 工作。旧版 worker 在多工作区 Run 首次执行命令前给出升级提示。
- 四种协议和跨协议历史经过受控模型响应验证。独立 worker 运行在同一台 Mac 上，真实异地主机、线上模型与生产发布渠道未参与此次联调。

## 关联

[设计与验收](../../../../docs/harness-project-multiple-computers-design.md) · [项目组件](../../../../docs/modules/sessions/projects.md) · [会话组件](../../../../docs/modules/sessions/session.md) · [Computer Operations](../../../../docs/modules/computers/computer-operations.md)
