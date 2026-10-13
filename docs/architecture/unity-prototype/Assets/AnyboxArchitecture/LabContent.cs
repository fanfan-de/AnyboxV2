using System.Collections.Generic;

namespace Anybox.ArchitectureLab
{
    public sealed class NodeInfo
    {
        public string Id, Title, Subtitle, Owner, Body, Resources, Rule, Source;
        public int Group;
        public NodeInfo(string id, string title, string subtitle, int group, string owner, string body, string resources, string rule, string source)
        { Id=id; Title=title; Subtitle=subtitle; Group=group; Owner=owner; Body=body; Resources=resources; Rule=rule; Source=source; }
    }

    public static class LabContent
    {
        public static readonly Dictionary<string, NodeInfo> Nodes = new Dictionary<string, NodeInfo>
        {
            ["workspace"] = new NodeInfo("workspace", "Anybox", "Anybox Harness 工作区", 0, "展示端 · 浏览器 / Renderer",
                "宿主外壳负责应用入口和挂载。Anybox Harness 自己管理项目、会话和分屏；界面位置不是服务端全局 head。",
                "局部界面状态\nSSE 临时展示投影\n最多四个分屏",
                "关闭界面只停止观察。取消 Run 是独立的显式动作。",
                "src/host/web/\nsrc/applications/harness/web/"),
            ["gateway"] = new NodeInfo("gateway", "Client Gateway", "固定连接 · 同源代理", 0, "客户端进程 · Nya 根 01",
                "client.gateway 向选定执行设备代理白名单请求。每次请求固定连接版本与 instanceId，不跨实例重试。",
                "本代 HTTP / SSE 观察\n客户端连接版本",
                "取消等待者或关闭客户端，不等于取消执行中的 Run。",
                "src/applications/harness/client/gateway.ts"),
            ["connections"] = new NodeInfo("connections", "Connections", "client.sqlite + 系统 Vault", 0, "客户端进程 · Nya 根 01",
                "client.connections 保存执行设备连接。客户端有自己的业务数据库和 Vault 命名空间，与执行端资源分开。",
                "客户端独占 SQLite\n私有凭据引用与写入意图",
                "连接身份不是 hostname，也不由浏览器临时位置决定。",
                "src/applications/harness/client/"),
            ["run"] = new NodeInfo("run", "Run", "准入 · 准备 · 幂等", 1, "执行端进程 · Nya 根 02",
                "先检查已接受幂等键，再解析当前配置、Prompt 与显式父节点；准备 execution 和 PreparedRunProgram。",
                "准入与交接前资源\n驱动代租约 / 准备中的 program",
                "同步交接失败由 Run 清理；Runtime 接管后，清理所有权随之移交。",
                "src/applications/harness/core/run/component.ts"),
            ["session"] = new NodeInfo("session", "Session", "记录 · 对话树 · 原子结算", 1, "执行端进程 · Nya 根 02",
                "harness.sessions 提供查询，harness.session-runs 提供执行记录操作。Session 持有会话、节点、Run、事件与恢复事实。",
                "原生记录 / resume cursor\n不可变上下文链节\n图片和文件快照引用",
                "成功结算且资源退出后才创建节点。失败、取消、interrupted 没有可继续节点。",
                "src/applications/harness/core/session/"),
            ["runtime"] = new NodeInfo("runtime", "RunRuntime", "接管 · 操作 · 退出屏障", 1, "执行端进程 · Nya 根 02",
                "只注入 Session 执行记录与 Computer Operations。通过 RunHost 管理意图、启动登记、result / done、观察提交和取消。",
                "本代 PreparedRunProgram\n私有模型 execution\n观察、取消与清理协调",
                "协议 Loop 解释原生停止语义；Runtime 不解释。Loop 是内部函数，不是子 Context。",
                "src/applications/harness/core/run/runtime-component.ts"),
            ["models"] = new NodeInfo("models", "Models", "原生 execution · 四种协议", 1, "执行端进程 · Nya 根 02",
                "独立可复用的 packages/models 提供配置、原生 execution 和驱动。支持 Responses、Chat Completions、Anthropic、Gemini。",
                "非秘密 JSON 配置\n系统 Vault 中的 Key\n私有上下文与认证头",
                "目录刷新不在执行关键路径。运行使用已保存配置；凭据不进入持久历史。",
                "packages/models/src/\nsrc/applications/harness/core/protocol-agents/"),
            ["operations"] = new NodeInfo("operations", "Computer Operations", "声明 · binding · receipt", 1, "执行端进程 · Nya 根 02",
                "与 Computers / Workspaces 协作，按需固定项目绑定、执行实例与 owner，再向独立 worker 派发操作。",
                "工具声明与耐久取消\nworkspace binding / pin\nworker 观察客户端",
                "纯文本模型 Run 不启动工具 worker。固定项目路径是基准，不是文件系统沙箱。",
                "src/applications/harness/core/computer/\nsrc/applications/harness/core/workspace/"),
            ["resources"] = new NodeInfo("resources", "输入与持久资源", "职责分组 · 各自独占", 1, "执行端根上的多个真实组件",
                "Projects 持有目录身份；Prompt 解析不可变模板；Image Assets 持有原字节；Project Files 保存发送时捕获的文本快照。",
                "业务 SQLite 单实例连接\n图片原字节目录\n文件快照 / 资源引用",
                "此卡是职责分组。项目、Session、Agent 定义都不建立独立 Nya Context。",
                "docs/modules/sessions/\ndocs/modules/images/\ndocs/modules/prompts/"),
            ["worker"] = new NodeInfo("worker", "Computer Worker", "Bash / Patch / Processes / Files", 2, "独立 worker 进程 · Nya 根 03",
                "worker 独占工具和 Run 进程 scope，可凭已保存游标查回原操作。真实故障恢复已验收 Linux；Windows 真实 worker 尚未支持。",
                "固定项目绑定\n实际工具与进程组\n稳定 workerId / 每次启动 bootId",
                "正常 Run 结束也要清理 scope。idle worker 继续运行，停止 worker 服务才关闭其根。",
                "src/applications/harness/core/computer/\ndocs/modules/computers/worker-executor.md"),
            ["ledger"] = new NodeInfo("ledger", "Worker Ledger", "独立账本 · 实际退出事实", 2, "worker 根 · 独占存储",
                "worker 在自己的连接中保存 receipt、操作结果、输出与清理事实，不能共用 Authority 业务库。",
                "computer-worker v1\noperationId 去重\nscope / 输出计数",
                "工具执行事实未知时不重放；退出未知时不释放 pin。",
                "docs/modules/computers/\ndocs/computer-resource-design.md"),
            ["api"] = new NodeInfo("api", "Model API", "进程外的原生协议端点", 3, "外部服务 · 无本地 Nya 根",
                "模型连接持有固定协议与地址。四种原生协议各自编码消息、工具结果与恢复记录，使用本地受管的 execution。",
                "原生请求 / 流式响应\n外部模型计算",
                "Models 的 SDK 标签只是来源数据，不动态导入执行实现。",
                "packages/models/src/protocols/"),
        };
    }
}
