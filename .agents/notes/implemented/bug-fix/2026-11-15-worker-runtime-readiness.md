# Agent Note: 独立 Computer worker 构建身份与运行时就绪检查

Status: implemented

## 问题

2026-11-15 本机会话 `a933cc7d` 的 18 次工具调用中，两个 Glob 与一个 exec 在进程启动前失败。实际 worker 从前一天持续运行，仍缓存工具拆包前的模块路径；源码重建已删除旧辅助程序目录。客户端仅凭进程存活和 `/info` 成功复用，无法发现这个状态。另两次 Read 的 ENOENT 是模型读取不存在文件，与本次修复独立。

## 决策

为实际 worker 产物生成确定性构建身份并在模块加载时固定；由 worker 自己报告身份和当前辅助程序/搜索二进制可用性。客户端在启动和新工具提交前检查实际 worker 的报告，旧代、缺少报告或运行时不可用时明确要求受控重启。原操作查询、取消、scope 关闭及显式停止继续可用，不因检测失败自动停止 worker 或重放工作。

本机已通过受控 stop/start 恢复，并验证真实 Glob 与命令执行；原会话失败事实及兼容业务数据保留。

当前实现保留既有 operation 的服务端摘要/绑定幂等校验，以及旧 boot 的 `worker-instance-replaced` 优先级。Anybox Harness 应用版本提升至 0.1.5，同步应用清单、发行依赖与锁文件。

## 备选方案

- 只重启 Web：独立 worker 不随观察端退出，不能解决根因。
- 只检查新客户端旁的 helper：无法证明旧 worker 的路径或依赖仍有效。
- 检测旧代后自动强杀：会破坏独立 worker 的资源归属及在途工作，未采用。

## 影响与代价

本地旧 worker 可继续接受恢复及管理请求，但新工具需要显式受控重启。构建增加身份产物；状态与错误增加可操作的重启提示。健康报告描述当前文件与运行条件检查，不构成未来执行成功保证。远端 worker 不要求与本机客户端具有相同构建身份。

## 验证

- 定向 worker / startup / attachments / management / package lifecycle / runtime roles 检查：37 项，36 通过、1 项真实 keyring 门控跳过。新增隔离产物的运行时回归单跑 7/7 通过，覆盖构建回执替换、helper 丢失、新工具拒绝、原事实及重复请求冲突校验、旧 boot、实际 scope 关闭与停止。
- `tests/units-client.test.mjs`：9/9 通过，重启提示不禁用既有附着撤销，也不会触发自动启动或停止。
- 首轮根检查发现状态返回缺少既有 platform 字段，已恢复平台、架构及工具报告。最终 `npm run check` 退出码 0：类型与构建通过，2356 项测试中 2339 通过、17 项既有门控跳过、0 失败。
- 新 CLI 对实际旧 PID 9600 返回 `restart-required` / `worker-build-mismatch`，状态读取没有停止它。本机 36 个会话查询无 active Run 后，正常关闭 Web 并调用 worker stop。旧 worker 返回 `worker-cleanup-failed`；已确认旧进程实际退出、endpoint 移除，并保留相同 boot 的失败回执，没有宣称旧 scope 已全部证明清理。
- 新 worker 沿用原 workerId 和数据目录，以新 boot 启动；旧未知操作沿用恢复规则不重放。重启 Web 后，实际 API 返回 running、身份匹配和 runtime ready。真实 Glob 找到 90 个 README，Codex exec `pwd` 退出码 0；验证 scope 的实际清理为 completed。原会话的失败观察及 executeCount=1 可继续查回，没有改写或重放。
- 重复执行身份生成脚本得到相同 buildId，运行中 worker 仍为 ready。`git diff --check` 通过。
- 未执行 Windows/Linux/Electron 实机验证，也未调用真实模型 API。健康检查不承诺发现绕过应用构建而单独替换依赖字节的所有情况。

## 关联

- [独立 worker 管理](../../../../docs/computer-worker-management.md)
- [本机 worker 客户端](../../../../docs/modules/computers/local-worker-client.md)
- [worker 执行器](../../../../docs/modules/computers/worker-executor.md)
- [运行时回归](../../../../tests/computer-worker-runtime.test.mjs)
- [构建身份脚本](../../../../packages/app-harness/scripts/build-worker-identity.mjs)
- [工具包拆分](../architecture/2026-11-15-environment-owned-tool-packages.md)
