# Agent Note: 单机 Web 共用进程与 Nya 根

Status: implemented

## 问题

当前 `web:local` 由父启动器再创建客户端和执行端两个 Node.js 进程。用户已确认单机模式合并运行，同时保留 harness server 独立部署能力。

## 决策

单机入口使用一个 Node.js 进程、一个 Nya 根，保留客户端库、执行端业务库、Models 配置及两侧 Products 目标的独立归属。为共根时重名的服务在相邻 NyaCore 增加显式安装绑定，由框架继续负责依赖快照、撤销及退出；应用 Runtime 传递同一绑定，业务门面和 HTTP 读取当前确切服务。独立客户端、独立 harness server 与独立 Computer worker 入口保留；单机不增加业务 Context，不合并或搬迁业务数据。

## 备选方案

保留两个常驻服务进程：独立部署便利，但不能解决本轮单机进程开销。仅将两个现有入口放进一个进程：会创建两个根并发生资源及生命周期重叠，因此不采用。合并数据库或共享不同应用的 Models：改变数据归属与兼容，不采用。

## 影响与代价

单机 Web 入口不再有客户端/执行端角色子进程；保留两个 HTTP 监听及既有本机配对身份，移除旧 Web 父子配对中转。桌面现有分进程入口和 D1.4 正式包角色监督器未改为单进程；worker 和应用自己拥有的工具子进程保持独立。服务名绑定不是权限隔离。退出必须先关闭两侧准入，再由唯一根取消、等待全部资源退出；连接令牌和数据路径沿用既有格式。

## 验证

- Anybox `npm run check` 通过：类型检查、构建及 2316 项测试，2299 通过、17 项既有门控跳过，0 失败。
- 后续增强 HTTP 身份与客户端监听失败验证后，`node --test --test-timeout=120000 tests/local-web-host.test.mjs tests/web-local-pairing.test.mjs` 的 8 项全部通过。
- 相邻 NyaCore `npm run check` 全部通过（319 项测试），`npm run api:check` 与 `npm run docs:check` 通过；只更新 core 的公开 API 基线。
- 真实入口测试从监听器记录 PID，证明两个端口均由入口进程持有；共根、两库/目标/Models 独立、后端 HTTP 正确取服务、忙碌 guard、实际模型调用关闭后的 cancelled 终态、两侧监听初始化失败释放、启动期间关闭、本机配对与 Vault 写入等待均有行为验证。既有独立部署、远端连接及包生命周期回归由完整检查覆盖。
- 仅在本机 macOS Node 验证；未做 Electron 单机合并、Windows/Linux 实机、真实模型联网和内存性能基准。未重启用户已有服务，也未迁移或编辑工作区业务数据。

## 关联

- [运行角色与发行](../../../../docs/runtime-roles-and-distribution.md)
- [单机装配](../../../../packages/distribution/src/composition/local-web.ts)
- [行为验证](../../../../tests/local-web-host.test.mjs)
- [客户端入口](../../../../packages/distribution/src/entrypoints/client-main.ts)
- [独立执行端](../../../../packages/distribution/src/composition/harness-server.ts)
