# Anybox Harness Run 执行时序图

[返回执行模块](README.md) · [Run 准入与控制](run.md) · [RunRuntime](run-runtime.md)

一次新 Run 从幂等检查和准入准备开始，经原生协议的模型与工具循环，最后等待资源实际退出并提交终态。`startRun()` 返回、模型输出最终文本、Run 完成是三个不同的时刻；成功对话节点只在清理完成后，与 Run 终态一起提交。

下图覆盖新 Run 的主路径；取消和失败也汇入统一清理与结算。启动恢复的 owner 接管、原操作查询和未知副作用处理见 [RunRuntime 的进程重启接续](run-runtime.md#进程重启接续)。

```mermaid
sequenceDiagram
    actor U as 用户 / Web
    participant R as Run 准入
    participant S as Session 账本
    participant RT as RunRuntime
    participant P as 协议注册表 / Loop
    participant M as Models
    participant E as 工具环境
    participant W as Computer worker

    U->>R: startRun（输入、父节点、幂等键）
    R->>S: 查询已接受的幂等请求

    alt 已有相同请求
        S-->>R: 原 Run
        R-->>U: 返回原 Run
    else 首次请求
        R->>S: 读取 Session、父链历史与固定初始化
        R->>R: 校验项目、模型、协议、工具与附件
        R->>P: prepare
        P->>M: openNative（固定配置与历史）
        M-->>P: execution 与模型快照
        P-->>R: PreparedRunProgram

        R->>S: registerRun（事务固定上下文与资源引用）
        S-->>R: 新建 running Run
        R->>RT: start（同步转移 program 所有权）
        RT->>P: execute(host)

        loop 模型调用与工具往返，直到取得结论
            P->>RT: perform（模型操作）
            RT->>S: 持久化请求与操作意图
            RT->>M: 启动原生请求并持有调用句柄

            opt 第一次实际启动操作
                RT-->>R: started
                R-->>U: 返回已启动的 Run
            end

            M-->>RT: 业务结果 result 与实际退出 done
            RT->>S: 保存响应、观察结果与恢复游标
            RT-->>P: 返回原生响应

            alt 模型请求工具
                P->>P: 整批校验工具名、ID 与参数

                alt 校验通过
                    P->>RT: executeTools（串行）
                    loop 按模型给出的顺序执行每项工具
                        RT->>S: 持久化工具操作意图
                        RT->>E: 执行固定工具契约
                        opt Computer 工具
                            E->>W: 提交原操作 ID 与工作区绑定
                            W-->>E: 调用结果与退出回执
                        end
                        E-->>RT: result 与 done
                        RT->>S: 持久化真实工具结果
                    end
                    RT-->>P: 返回整批工具结果
                    P->>P: 编码为下一轮原生工具消息
                else 可修正的工具请求错误
                    P->>P: 整批不执行，生成纠错反馈
                end

            else 协议要求继续
                P->>P: 准备下一轮请求
            else 正常结束
                P-->>RT: 完成提案与最终文本
            end
        end

        Note over RT,E: 取消或异常会停止新操作、取消并排空在途调用，随后进入统一清理

        opt 已打开工具环境
            RT->>E: close 本 Run 的 scope
            opt 使用了 Computer
                E->>W: 清理 scope，等待所属资源实际退出
                W-->>E: 清理回执
            end
            E-->>RT: 清理结果与 done
        end

        RT->>P: close program
        P->>M: 关闭 execution 并等待实际退出
        M-->>P: 退出完成
        P-->>RT: 退出报告与 checkpoint

        RT->>S: 保存结算提案并事务提交
        alt 完成且清理成功，未被取消
            S->>S: 写 completed，原子创建对话节点与上下文
        else 取消或失败
            S->>S: 写 cancelled / failed，保留已发生事实
        end
        S-->>RT: 最终 Run
        RT->>P: release 协议绑定租约

        Note over U,S: Web 通过查询、事件流或 waitRun 观察终态
    end
```

## 时序与生命周期边界

- 图中将协议注册表、准备好的 program 与协议 Loop 归在同一泳道便于阅读：注册表负责准备和绑定，program 内的 Loop 解释原生响应并决定续轮；这不表示新增或合并 Nya 组件。Runtime 通过 program 提供的启动回调调用 Models，不解释原生停止原因。
- 已接受的同一幂等请求返回原 Run；同键但输入不同会冲突。接受前的校验或准备失败不创建 Run，接受后的交接失败仍须清理并结算。`startRun()` 也可能返回提前结算的 Run，完成判断使用 `waitRun()`。
- 每个模型或工具操作都先保存意图，再启动并持有句柄，等待 `result` 和 `done` 后保存观察。工具调用的 `done` 只证明该次调用退出；仍由 Run scope 持有的长进程在最终关闭 scope 时终止并等待。
- 工具环境按 Session 固定的快照路由。Computer 环境经 Computer Operations 派发给独立 worker，其他受信环境自行提供执行；关闭 Run 的 scope 不停止空闲 worker 服务。合法 ID 对应的未知工具名或参数错误可整批拒绝并反馈模型，累计最多三批；无法关联的 ID、损坏原生 JSON 或超过额度会终止执行。
- 取消和执行异常可发生在图中的任意运行阶段；存储可用时，取消后仍提交已经发生的真实观察，写入失败则关闭新操作准入并报告状态故障。清理失败不能被普通取消掩盖，也不能创建成功节点；结算写入未确认时保留恢复边界，不重放未知副作用。中止 `waitRun()` 的等待信号只结束该次等待，不取消 Run。

## 源码与行为验证入口

- [Run 准入、准备与所有权交接](../../../packages/app-harness/src/core/run/component.ts)
- [协议准备与绑定](../../../packages/app-harness/src/core/protocol-agents/registry.ts)及[模型与工具交换管道](../../../packages/app-harness/src/core/protocol-agents/shared.ts)
- [Runtime 操作屏障、工具串行执行与统一清理](../../../packages/app-harness/src/core/run/runtime-component.ts)
- [Session 接受与原子结算](../../../packages/app-harness/src/core/session/sqlite-records.ts)
- [核心行为测试](../../../tests/harness-server-core.test.mjs)、[工具循环测试](../../../tests/tool-loop.test.mjs)及[对话树与结算测试](../../../tests/conversation-tree.test.mjs)
