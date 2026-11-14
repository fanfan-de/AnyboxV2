# Agent Note: Computer 公布受支持工具清单

Status: implemented

## 问题

Computer 已拥有文件、进程和工作区资源，但环境列表只公布身份、平台和连接状态，worker 没有精确的工具契约报告。用户要求把工具与环境作为一套设计，先补支持清单，暂不改变模型声明或执行流程。

## 决策

从 worker 实际静态分派绑定导出有版本、定义摘要、执行器和约束的只读清单；本机 info 和远端拨出报告相同清单。宿主只认可内置受信契约的精确匹配，不导入远端 schema 或代码。环境列表投影已收到的内存报告，缺失、旧 worker 或不兼容清单报告未知，列表不探测或启动 worker。

远端采用可选 `x-anybox-unit-capabilities` 请求头携带 8 KiB 以内的通用能力 JSON，保持旧 host 的查询参数不变；独立保存最新轮询报告，旧轮询收尾不能恢复旧 boot 的清单。本机观察客户端只复制有界不透明 JSON，并按请求顺序、端点身份和关闭状态维护缓存，不导入执行端目录；受信定义校验由 harness server 投影完成。公开 `toolSupport` 区分 unknown 与携带 workerId/bootId 的 reported，默认清单为当前 19 项。

支持清单与授权、系统依赖就绪和模型能力分开；本轮不据此过滤工具、修改 Session 快照或切换执行路径。其他环境只梳理 Browser、服务连接、Database 的候选边界，不预建实现或组件。

## 备选方案

- 直接公布宿主全局目录：不能证明目标 worker 的契约或版本，未采用。
- 读取列表时启动或远程查询 worker：扩大只读列表的生命周期与副作用，未采用。
- 同时改模型声明和会话格式：超出用户确认的第一步，后续独立推进。

## 影响与代价

增加可选、只读的协议元数据和公开环境投影，保留旧 worker 兼容。报告是指定 worker/boot 的支持事实，不构成当前可执行、授权或退出证明；不增加数据库、Nya 组件、Context 或独立资源所有者。

## 验证

- 七个相关测试文件共 48 项：47 通过、1 项真实系统凭据门控跳过。覆盖清单与实际分派、受信定义/摘要/约束校验、旧协议未知、本机惰性、双远端报告、HTTP 公开投影、报告乱序/换代/清空和关闭后的观察退出。清单及请求头包裹共 3259 字节，低于 8 KiB 上限。
- 根 `npm run check` 类型检查与构建通过；测试为 2277 项、2252 通过、8 失败、17 跳过。五项客户端/桌面/CLI 失败揭示本机观察客户端误导入执行端清单；已移除该运行时导入，改为有界不透明观察，随后根 `npm run build` 通过，独立角色、桌面启动、本机管理、缓存、环境与清单六文件的 24 项回归全部通过。未通过放宽角色导入检查来掩盖问题。
- 其余三项为 worker restart 与两个原生进程退出/清理用例。使用修复后的当前构建串行隔离，两个进程用例通过，worker restart 仍超时 180 秒并报告 worker/Bash 清理失败；该用例在前项全量检查中已失败，本轮未修改其执行/清理实现。超时后测试进程保留句柄，仅终止本次测试子进程以取得完整结果。该问题不能描述为只在并发下失败，仍未定位；修复角色边界后未再次重跑全量，不能宣称完整检查全绿。
- `git diff --check` 及本轮文档相对链接检查通过。测试使用临时目录、受控模型和内存凭据，未修改运行中的用户实例；未验收真实跨机器部署、系统凭据或 Windows/Linux 平台效果。

## 关联

- 前项：[退役计划与待办工具](../simplification/2026-11-14-retire-planning-tools.md)。
- 当前契约：[Computer 环境](../../../../docs/modules/computers/environments.md)、[worker 执行器](../../../../docs/modules/computers/worker-executor.md)、[工具库](../../../../docs/tools-library-design.md)。
- 实现与验证：[支持清单](../../../../packages/app-harness/src/core/computer/tool-support.ts)、[清单行为](../../../../tests/computer-tool-support.test.mjs)、[本机观察](../../../../tests/computer-worker.test.mjs)、[单元传输](../../../../tests/unit-transport.test.mjs)。
