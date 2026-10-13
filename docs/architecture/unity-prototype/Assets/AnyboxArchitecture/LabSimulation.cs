using System;
using System.Collections.Generic;

namespace Anybox.ArchitectureLab
{
    // A deterministic teaching model. It never connects to Anybox or executes tools.
    public enum Experiment { Success, CloseView, Cancel, RecoverWorker, LoseModel, CleanupFailure }
    public enum Mutation { None, Accept, Take, ModelStart, ModelSaved, Dispatch, Observe, ModelFinish, Cancel, Crash, Recover, CloseView, Exit, Success, Cancelled, Interrupted, CleanupFailed }

    [Serializable]
    public sealed class LabStep
    {
        public string Title, Detail, From, To, Fact;
        public Mutation Mutation;
        public LabStep(string title, string detail, string from, string to, string fact, Mutation mutation = Mutation.None)
        { Title = title; Detail = detail; From = from; To = to; Fact = fact; Mutation = mutation; }
    }

    [Serializable]
    public sealed class HistoryNode
    {
        public int Id, Parent, Run;
        public string Protocol;
    }

    public sealed class LabSimulation
    {
        public static readonly string[] Protocols = { "Responses", "Chat Completions", "Anthropic Messages", "Gemini Interactions" };
        public static readonly string[] ExperimentNames = { "完整工具往返", "关闭界面", "取消 Run", "Runtime 异常退出", "模型响应未保存", "清理失败" };
        public static readonly string[] ExperimentHints = { "观察一次成功结算", "观察停止，执行继续", "取消后仍要等待退出", "从原 worker 查回结果", "明确中断，不自动重发", "没有退出事实，就没有节点" };
        public readonly List<LabStep> Steps = new List<LabStep>();
        public readonly List<HistoryNode> Nodes = new List<HistoryNode>();
        public readonly List<string> Events = new List<string>();
        public Experiment Experiment;
        public int Index = -1, ProtocolIndex, SelectedParent, AcceptedParent, RunNumber, OwnerEpoch = 1, ExecuteCount;
        public bool UsesTools = true, CatalogOnline = true, ViewOpen = true, ProcessAlive = true;
        public bool Accepted, ModelActive, ToolActive, ScopeActive, ResponseSaved, Playing;
        public string Status = "ready";
        public LabStep Current => Index >= 0 && Index < Steps.Count ? Steps[Index] : null;
        public bool Running => Accepted && !Terminal;
        public bool Terminal => Status == "completed" || Status == "cancelled" || Status == "interrupted" || Status == "cleanup-failed";
        public bool CanAdvance => Index + 1 < Steps.Count && !Terminal;
        public bool CanCancel => Running && ProcessAlive && Status != "cancelling";
        public int LiveResources => (ModelActive ? 1 : 0) + (ToolActive ? 1 : 0) + (ScopeActive ? 1 : 0);

        public LabSimulation() { Reset(Experiment.Success); }

        public void Reset(Experiment experiment)
        {
            Experiment = experiment;
            if (experiment == Experiment.RecoverWorker || experiment == Experiment.CloseView || experiment == Experiment.CleanupFailure) UsesTools = true;
            Index = -1; RunNumber = 0; OwnerEpoch = 1; ExecuteCount = 0; SelectedParent = 0; AcceptedParent = 0;
            Accepted = ModelActive = ToolActive = ScopeActive = ResponseSaved = Playing = false;
            ProcessAlive = ViewOpen = true; Status = "ready";
            Nodes.Clear(); Events.Clear(); BuildSteps();
        }

        public bool SetProtocol(int index)
        {
            if (Running || index < 0 || index >= Protocols.Length) return false;
            ProtocolIndex = index; Reset(Experiment); return true;
        }

        public bool SelectParent(int nodeId)
        {
            if (Running || (nodeId != 0 && !Nodes.Exists(n => n.Id == nodeId))) return false;
            SelectedParent = nodeId; return true;
        }

        public bool StartNextRun()
        {
            if (Running || Status == "cleanup-failed" || Nodes.Count >= 4) return false;
            Index = -1; OwnerEpoch = 1; Accepted = ModelActive = ToolActive = ScopeActive = ResponseSaved = false;
            ProcessAlive = true; Status = "ready"; BuildSteps(); return true;
        }

        public bool Advance()
        {
            if (!CanAdvance) return false;
            Index++;
            var step = Steps[Index];
            switch (step.Mutation)
            {
                case Mutation.Accept: Accepted = true; AcceptedParent = SelectedParent; RunNumber++; Status = "running"; break;
                case Mutation.Take: Status = "running"; break;
                case Mutation.ModelStart: ModelActive = true; ResponseSaved = false; break;
                case Mutation.ModelSaved: ModelActive = false; ResponseSaved = true; break;
                case Mutation.Dispatch: ToolActive = ScopeActive = true; ExecuteCount++; break;
                case Mutation.Observe: ToolActive = false; break;
                case Mutation.ModelFinish: ModelActive = false; ResponseSaved = true; break;
                case Mutation.Cancel: Status = "cancelling"; break;
                case Mutation.Crash: ProcessAlive = false; ModelActive = false; Status = "disconnected"; break;
                case Mutation.Recover: ProcessAlive = true; OwnerEpoch++; Status = "running"; break;
                case Mutation.CloseView: ViewOpen = false; break;
                case Mutation.Exit: ToolActive = ScopeActive = ModelActive = false; break;
                case Mutation.Success:
                    if (LiveResources != 0) throw new InvalidOperationException("Cannot commit a node before actual exit.");
                    Status = "completed";
                    Nodes.Add(new HistoryNode { Id = Nodes.Count + 1, Parent = AcceptedParent, Run = RunNumber, Protocol = Protocols[ProtocolIndex] });
                    break;
                case Mutation.Cancelled: Status = "cancelled"; break;
                case Mutation.Interrupted: Status = "interrupted"; ProcessAlive = true; break;
                case Mutation.CleanupFailed: ModelActive = false; ToolActive = false; Status = "cleanup-failed"; break;
            }
            Events.Add((Index + 1).ToString("00") + "  " + step.Fact);
            if (Terminal) Playing = false;
            return true;
        }

        public bool RequestCancel()
        {
            if (!CanCancel) return false;
            Steps.RemoveRange(Index + 1, Steps.Count - Index - 1);
            AppendCancellation();
            return Advance();
        }

        void Add(string title, string detail, string from, string to, string fact, Mutation mutation = Mutation.None)
        { Steps.Add(new LabStep(title, detail, from, to, fact, mutation)); }

        void BuildSteps()
        {
            Steps.Clear();
            Add("从一个明确的父节点开始", "客户端固定连接版本与 instanceId。Run 先查已接受幂等键，再读取配置和 Prompt；parentNodeId 必须显式给出。", "gateway", "run", "固定设备 / 幂等检查 / 读取所选成功父链");
            Add("接受是一笔原子事务", "Session 固定首次协议、初始化、工具声明与本轮图片 / 文件引用。接纳 Run 还不意味着已经有成功节点。", "run", "session", "Run accepted · 协议及资源引用已固定", Mutation.Accept);
            Add("同步交给 RunRuntime", "RunRuntime 在第一次异步读取前接管 PreparedRunProgram。接管后由它协调取消、观察与清理。", "run", "runtime", "program 所有权已交接", Mutation.Take);
            Add("原生模型交换", "协议 Loop 解释原生语义，Models execution 私有持有上下文与凭据。公共 result 要等待实际退出及上下文提交。", "runtime", "models", Protocols[ProtocolIndex] + " · model-pending", Mutation.ModelStart);
            if (Experiment == Experiment.LoseModel)
            {
                Add("响应尚未保存，Runtime 退出", "这次模拟在 model-pending 窗口强制退出执行端进程。不能证明原模型请求的结果，不能假定重新发送是安全的。", "models", "runtime", "Runtime 离线 · 原响应未持久保存", Mutation.Crash);
                Add("恢复为 interrupted", "新根读取事实后标记 interrupted；不重发模型请求，也不创建成功节点。本实验尚未启动工具 scope。", "runtime", "session", "interrupted · 自动重发 0 次 / 新节点 0", Mutation.Interrupted);
                return;
            }
            Add("先保存完整的模型响应", "Session 保存原生记录与独立 resume cursor。可恢复记录属于 Session，可变原生上下文仍属于 execution。", "models", "session", "原生响应 + resume cursor 已提交", Mutation.ModelSaved);
            if (UsesTools)
            {
                Add("工具副作用之前，先登记意图", "完整工具批次先校验。Computer Operations 固定 workspace binding、operationId、owner 与实例代；项目只是数据边界。", "session", "operations", "工具声明已持久化 · operationId = op-01");
                Add("独立 worker 接纳并执行", "worker 持有自己的账本、工具调用和 Run 进程 scope。这里用一次模拟工具副作用表示执行计数。", "operations", "worker", "worker receipt 已保存 · 执行次数 +1", Mutation.Dispatch);
            }
            if (Experiment == Experiment.Cancel)
            { AppendCancellation(); return; }
            if (Experiment == Experiment.CloseView)
                Add("界面关闭，Run 继续", "这里只取消客户端的观察连接。独立执行端和 worker 仍工作，重新打开界面可查询 Session 中保存的结果。", "workspace", "gateway", "观察已关闭 · 没有发送 Run cancel", Mutation.CloseView);
            if (Experiment == Experiment.RecoverWorker)
            {
                Add("Runtime 突然离线", "模拟执行端 PID 异常退出。原 worker 存活，已接纳命令继续；这与显式组件卸载或正常关闭不同。", "runtime", "worker", "执行端离线 · worker / scope 仍存活", Mutation.Crash);
                Add("按原账本提升 owner", "重新装配一个 Nya 根。根据已保存响应与恢复游标 claim owner=2，安装新栅栏；旧 owner 不能再提交。", "session", "runtime", "owner epoch 1 → 2 · boot / operation 不变", Mutation.Recover);
                Add("查回原操作，而非重放", "向原 worker 查询同一个 receipt / result。消费和输出计数去重；这个实验的工具执行次数仍为 1。", "worker", "operations", "查询原 op-01 · 工具副作用没有增加", Mutation.Observe);
            }
            else if (UsesTools)
                Add("调用结束，scope 还没有退出", "工具 result 与调用资源已返回，但 Run 进程 scope 仍可能持有管道进程。Session 保存真实工具观察。", "worker", "runtime", "tool-observed · scope 仍占用", Mutation.Observe);
            if (UsesTools)
            {
                Add("只传新增工具结果", "对应协议 Loop 编码本次新增结果。execution 私有复用上下文；认证头、Key 和运行句柄不写入 Session。", "runtime", "models", "发送增量原生请求 · 不复制历史数组", Mutation.ModelStart);
                Add("模型完成也要实际退出", "模型返回最终内容，Models 等待请求和上下文提交完成。接下来仍然要关闭工具 scope 和 program。", "models", "runtime", "最终模型响应已保存", Mutation.ModelFinish);
            }
            Add("停止新操作，排空资源", "即使正常完成，也要关闭 Run 进程 scope，持久保存 tool-process-cleanup 观察，并关闭 program。", "runtime", UsesTools ? "worker" : "models", "停止操作准入 · 等待实际退出");
            if (Experiment == Experiment.CleanupFailure)
            {
                Add("清理失败，拒绝成功节点", "无法确认 scope 实际退出时，保留失败和未知事实；不能把 cancel 请求或断开的观察连接当作退出证明。", "worker", "session", "cleanup-failed · scope / pin 未获退出证明", Mutation.CleanupFailed);
                return;
            }
            Add("退出屏障已满足", "所有所属操作、模型 execution 和 scope 都已实际退出，清理观察已保存。现在才允许成功结算。", UsesTools ? "worker" : "models", "runtime", "result / done / scope 退出事实齐备", Mutation.Exit);
            Add("原子创建一个成功节点", "Session 在同一事务提交 Run、原生记录、上下文链节、完整节点、结果引用和终态事件。父节点保持不变。", "runtime", "session", "completed · 成功节点 +1", Mutation.Success);
        }

        void AppendCancellation()
        {
            Add("取消请求不是退出证明", "RunRuntime 关闭新操作准入并传播取消。已发生的工具副作用与部分补丁事实保留，不会因取消而回滚。", "run", "runtime", "cancelling · 仍在等待实际退出", Mutation.Cancel);
            Add("等待工具、scope 与 program", "取消的 Run 仍然记录真实观察；等待操作资源和进程组退出之后，才能写入终态。", "runtime", UsesTools ? "worker" : "models", "停止新操作 · 取消并排空");
            Add("资源已退出", "记录真实清理结果，释放可证明退出的资源。取消过程中已经发生的执行次数仍保留。", UsesTools ? "worker" : "models", "runtime", "实际退出已确认 · 可结算", Mutation.Exit);
            Add("保存取消结果，不创建节点", "Session 保留已接受 Run 的输入、资源引用、操作事实和事件。取消结果不是可继续的成功父节点。", "runtime", "session", "cancelled · 成功节点不变", Mutation.Cancelled);
        }
    }
}
