# Agent Note: 精简 Harness 执行环境与工具授权的展示

Status: implemented

## 问题

执行环境详情将设备身份、权限和状态串在一起。工具来源展开后重复显示工具 ID，查看单项授权需要对照两份长列表。

## 决策

Anybox Harness 的项目电脑卡片优先展示系统和运行状态，详情按字段列出附着权限与 worker 工具报告。工具来源卡片汇总工具数和已获授权的 Agent 数，展开后每项工具占一行，同行列出获得授权的 Agent。技术标识单独收起，用户刷新时保留同一台电脑和同一工具来源的外层展开状态。

## 备选方案

仅截断工具 ID 或限制原段落的高度，仍需要对照两份列表。同行展示工具及授权关系可以保留完整契约 ID，并让读者直接查到一项工具的授权情况。

## 影响与代价

Anybox Harness 应用包更新至 0.1.12。设备状态来自所选执行端的原有投影；worker 尚未提交报告与已报告零项分别展示。每个目标的 Agent 授权来自授权目录。完整 ID 需要展开「技术标识」才能看到。变更范围为 Harness 设置界面，Personal Agent 沿用自己的页面。

## 验证

Harness 工作区构建、浏览器资源闭包检查与 32 项定向测试通过。覆盖已知与未知工具报告、按工具区分多个 Agent 授权、刷新保留展开状态、附着码清除和已提交操作的退出等待。

macOS Chrome 通过临时 harness server 及实际客户端网关，在 1380 × 900 与 390 × 844 检查本机卡片、19 项工具的授权表及技术标识。窄屏展开后无横向溢出。切换测试执行设备后可生成附着码并看到待附着电脑，收起表单时码已清空。跨物理设备连接和其他平台的桌面客户端未实测。

## 关联

[此前的执行环境设置整理](2026-11-22-clarify-execution-environment-settings.md) · [执行环境设置](../../../../docs/modules/tools/execution-environments.md) · [界面投影](../../../../packages/app-harness/src/web/environment-inventory-view.ts) · [回归测试](../../../../tests/units-client.test.mjs)
