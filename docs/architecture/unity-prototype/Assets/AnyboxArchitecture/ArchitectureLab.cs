using System;
using System.Collections.Generic;
using System.Linq;
using TMPro;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.UI;

namespace Anybox.ArchitectureLab
{
    public sealed class ArchitectureLab : MonoBehaviour
    {
        public TMP_FontAsset Font;
        public LabSimulation Simulation { get; private set; }
        public static ArchitectureLab Active { get; private set; }
        readonly Color bg = Hex("10181E"), panel = Hex("182229"), tile = Hex("202D34"), line = Hex("33424A");
        readonly Color ink = Hex("EDF1EA"), muted = Hex("9BAEB4"), lime = Hex("D9ED9B"), cyan = Hex("83CDD4"), lavender = Hex("B7A8DD"), coral = Hex("E8A184");
        RectTransform root, packet;
        TMP_Text status, stepTitle, stepDetail, stepCounter, events, inspectorTitle, inspectorOwner, inspectorBody, inspectorResource, inspectorRule, inspectorSource;
        TMP_Text resourcesCount, nodeCount, executionCount, workerStatus, apiProtocol, sessionLabel, historyHint, catalogLabel, keyHint;
        UnityEngine.UI.Button playButton, nextButton, cancelButton, viewButton, toolsButton, followButton;
        readonly List<UnityEngine.UI.Button> experimentButtons = new List<UnityEngine.UI.Button>();
        readonly List<UnityEngine.UI.Button> protocolButtons = new List<UnityEngine.UI.Button>();
        readonly List<UnityEngine.UI.Button> lensButtons = new List<UnityEngine.UI.Button>();
        readonly List<UnityEngine.UI.Image> ticks = new List<UnityEngine.UI.Image>();
        readonly Dictionary<string, NodeVisual> nodes = new Dictionary<string, NodeVisual>();
        readonly List<UnityEngine.UI.Button> historyButtons = new List<UnityEngine.UI.Button>();
        readonly List<TMP_Text> historyCaptions = new List<TMP_Text>();
        readonly List<RectTransform> historyLines = new List<RectTransform>();
        readonly List<UnityEngine.UI.Image> route = new List<UnityEngine.UI.Image>();
        RectTransform routeLayer;
        string selected = "runtime";
        int lens;
        bool follow = true;
        float elapsed, animationTime, speed = 1;
        Vector2[] currentRoute = Array.Empty<Vector2>();
        static Color Hex(string value) { ColorUtility.TryParseHtmlString("#" + value, out var c); return c; }
        Color GroupColor(int group) => group == 0 ? cyan : group == 1 ? lime : group == 2 ? lavender : coral;

        sealed class NodeVisual
        {
            public RectTransform Rect;
            public UnityEngine.UI.Image Background, Accent;
            public UnityEngine.UI.Button Button;
            public TMP_Text Title, Subtitle, State;
        }

        void Awake()
        {
            Active = this; Application.targetFrameRate = 60; Application.runInBackground = true;
            Simulation = new LabSimulation();
            if (Font == null) { Debug.LogError("Architecture Lab requires its generated CJK font asset."); enabled = false; return; }
            Build(); Refresh();
        }

        void OnDestroy() { if (Active == this) Active = null; }

        void Update()
        {
            animationTime += Time.unscaledDeltaTime;
            if (Simulation.Playing)
            {
                elapsed += Time.unscaledDeltaTime * speed;
                if (elapsed >= 2.2f) { elapsed = 0; Advance(); }
            }
            var keyboard = Keyboard.current;
            if (keyboard != null)
            {
                if (keyboard.spaceKey.wasPressedThisFrame) TogglePlay();
                if (keyboard.rightArrowKey.wasPressedThisFrame) { Simulation.Playing = false; Advance(); }
                if (keyboard.rKey.wasPressedThisFrame) ResetExperiment();
                if (keyboard.escapeKey.wasPressedThisFrame) { Simulation.Playing = false; Refresh(); }
            }
            if (currentRoute.Length > 1 && Simulation.Index >= 0)
            {
                packet.gameObject.SetActive(true);
                var distances = new float[currentRoute.Length - 1]; float total = 0;
                for (int i = 0; i < distances.Length; i++) { distances[i] = Vector2.Distance(currentRoute[i], currentRoute[i+1]); total += distances[i]; }
                float along = (animationTime * 0.42f % 1f) * total;
                for (int i = 0; i < distances.Length; i++)
                {
                    if (along <= distances[i]) { var p = Vector2.Lerp(currentRoute[i], currentRoute[i+1], distances[i] < 0.1f ? 0 : along / distances[i]); packet.anchoredPosition = new Vector2(p.x, -p.y); break; }
                    along -= distances[i];
                }
            }
            else packet.gameObject.SetActive(false);
        }

        void Build()
        {
            var canvasGo = new GameObject("Architecture Canvas", typeof(RectTransform), typeof(Canvas), typeof(UnityEngine.UI.CanvasScaler), typeof(UnityEngine.UI.GraphicRaycaster));
            canvasGo.transform.SetParent(transform, false);
            var canvas = canvasGo.GetComponent<Canvas>(); canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            var scaler = canvasGo.GetComponent<UnityEngine.UI.CanvasScaler>();
            scaler.uiScaleMode = UnityEngine.UI.CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1600, 1000); scaler.screenMatchMode = UnityEngine.UI.CanvasScaler.ScreenMatchMode.Expand;
            var screen = canvasGo.GetComponent<RectTransform>();
            var background = Box(screen, "Backdrop", 0, 0, 1600, 1000, bg);
            background.rectTransform.anchorMin = Vector2.zero; background.rectTransform.anchorMax = Vector2.one; background.rectTransform.offsetMin = background.rectTransform.offsetMax = Vector2.zero;
            root = Rect(screen, "Design", 0, 0, 1600, 1000); root.anchorMin = root.anchorMax = new Vector2(0.5f, 0.5f); root.pivot = new Vector2(0.5f, 0.5f); root.anchoredPosition = Vector2.zero;
            if (FindAnyObjectByType<EventSystem>() == null)
            {
                var eventGo = new GameObject("EventSystem", typeof(EventSystem), typeof(InputSystemUIInputModule)); eventGo.transform.SetParent(transform, false);
                eventGo.GetComponent<InputSystemUIInputModule>().AssignDefaultActions();
            }
            Box(root, "TopRule", 24, 92, 1552, 1, line);
            var logo = Box(root, "Mark", 26, 28, 34, 34, lime);
            Text(logo.rectTransform, "A", 0, 0, 34, 34, 24, bg, true, TextAlignmentOptions.Center);
            Text(root, "Anybox", 73, 15, 175, 47, 30, ink, true);
            Text(root, "ARCHITECTURE LAB", 74, 59, 190, 16, 11, muted);
            Text(root, "让框架，运行给你看。", 270, 16, 620, 48, 29, ink, true);
            Text(root, "选择实验 → 逐步推进 → 改变条件 → 检查事实", 272, 63, 700, 19, 14, muted);
            Tag(root, "本地行为模拟", 1323, 27, 137, lime);
            Text(root, "EXPLORATION / 01", 1317, 64, 265, 18, 12, muted, false, TextAlignmentOptions.Right);
            BuildSidebar(); BuildMap(); BuildInspector(); BuildTimeline();
        }

        void BuildSidebar()
        {
            Box(root, "SidebarRule", 241, 112, 1, 863, line);
            Text(root, "01 / 选择一个实验", 25, 122, 210, 26, 17, ink, true);
            Text(root, "同一套组件，不同的结果。", 25, 157, 210, 22, 13, muted);
            var choices = Rect(root, "Experiments", 24, 202, 200, 420);
            var layout = choices.gameObject.AddComponent<UnityEngine.UI.VerticalLayoutGroup>();
            layout.spacing = 9; layout.childControlWidth = true; layout.childControlHeight = true; layout.childForceExpandHeight = false;
            for (int i = 0; i < LabSimulation.ExperimentNames.Length; i++)
            {
                int choice = i;
                var button = Button(choices, "Experiment" + i, 0, 0, 200, 61, "", () => ChooseExperiment(choice));
                var size = button.gameObject.AddComponent<UnityEngine.UI.LayoutElement>(); size.preferredHeight = 61;
                Text(button.transform, "0" + (i+1), 11, 11, 28, 20, 13, muted);
                Text(button.transform, LabSimulation.ExperimentNames[i], 40, 8, 155, 24, 16, ink, true);
                Text(button.transform, LabSimulation.ExperimentHints[i], 40, 36, 155, 18, 11, muted);
                experimentButtons.Add(button);
            }
            Text(root, "原生协议", 26, 643, 190, 22, 15, ink, true);
            for (int i = 0; i < 4; i++)
            {
                int p = i;
                var shortNames = new[] { "Responses", "Chat", "Anthropic", "Gemini" };
                protocolButtons.Add(Button(root, "Protocol"+i, 25+(i%2)*102, 677+(i/2)*39, 96, 32, shortNames[i], () => { if(Simulation.SetProtocol(p)) { elapsed=0; Refresh(); } }, 13));
            }
            toolsButton = Button(root, "ToolMode", 25, 767, 198, 35, "", ToggleTools, 13);
            Button(root, "Catalog", 25, 813, 198, 35, "切换目录连接", ToggleCatalog, 13);
            catalogLabel = Text(root, "", 27, 853, 200, 36, 12, muted);
            Text(root, "这是可操作的架构模型。\n不请求模型、不执行 Shell。", 25, 916, 198, 43, 13, muted);
        }

        void BuildMap()
        {
            Text(root, "02 / 系统现场", 266, 122, 245, 26, 17, ink, true);
            string[] lenses = { "执行路径", "资源归属", "恢复事实" };
            for (int i = 0; i < 3; i++) { int l = i; lensButtons.Add(Button(root, "Lens"+i, 934+i*110, 119, 101, 31, lenses[i], () => SetLens(l), 13)); }
            Text(root, "点击组件查看契约；亮线表示当前步骤，不是完整 inject 依赖图。", 266, 161, 990, 21, 13, muted);
            for (int x = 269; x < 1265; x+=24) for (int y = 195; y < 731; y+=24) Box(root, "Grid", x, y, 1, 1, Hex("304048"));
            Zone("Display", 265, 206, 192, 162, "展示端", "浏览器 / Renderer", cyan, false);
            Zone("ClientRoot", 265, 397, 192, 310, "客户端进程", "NYA ROOT / 01", cyan, true);
            Zone("ServerRoot", 480, 206, 526, 501, "执行端 · harness server", "NYA ROOT / 02 · Authority + Runtime", lime, true);
            Zone("WorkerRoot", 1030, 397, 236, 310, "独立 worker", "NYA ROOT / 03", lavender, true);
            Text(root, "外部模型服务", 1048, 209, 206, 23, 14, coral, true);
            routeLayer = Rect(root, "Routes", 0, 0, 1600, 1000);
            StaticLink(new Vector2(361, 349), new Vector2(361, 450), cyan);
            StaticLink(new Vector2(711, 301), new Vector2(754, 301), lime);
            StaticLink(new Vector2(604, 343), new Vector2(604, 410), lime);
            StaticLink(new Vector2(711, 458), new Vector2(754, 458), lime);
            StaticLink(new Vector2(604, 508), new Vector2(604, 565), lime);
            StaticLink(new Vector2(1147, 542), new Vector2(1147, 587), lavender);
            AddNode("workspace", 280, 266, 163, 83);
            AddNode("gateway", 280, 450, 163, 88);
            AddNode("connections", 280, 584, 163, 91);
            AddNode("run", 498, 263, 213, 80);
            AddNode("session", 754, 263, 234, 80);
            AddNode("runtime", 498, 410, 213, 98);
            AddNode("models", 754, 410, 234, 98);
            AddNode("operations", 498, 565, 213, 90);
            AddNode("resources", 754, 565, 234, 90);
            AddNode("api", 1047, 263, 204, 80);
            AddNode("worker", 1047, 450, 204, 92);
            AddNode("ledger", 1047, 587, 204, 88);
            Text(root, "同一根上的服务 · 无项目 / Session 子 Context", 499, 673, 487, 18, 12, muted);
            apiProtocol = Text(root, "", 1048, 354, 213, 33, 12, coral);
            workerStatus = Text(root, "", 1031, 718, 231, 29, 12, lavender);
            Text(root, "每个进程只有一个 Nya 根；框内卡片按职责分组。", 265, 718, 758, 23, 13, muted);
            packet = Box(root, "Signal", 0, 0, 8, 8, lime).rectTransform; packet.pivot = new Vector2(.5f, .5f);
            packet.gameObject.SetActive(false);
        }

        void BuildInspector()
        {
            Box(root, "InspectorRule", 1288, 113, 1, 633, line);
            Text(root, "03 / 组件契约", 1310, 122, 233, 25, 17, ink, true);
            followButton = Button(root, "Follow", 1479, 157, 95, 25, "跟随步骤", () => { follow=true; Refresh(); }, 11);
            inspectorOwner = Text(root, "", 1310, 192, 260, 34, 12, lime);
            inspectorTitle = Text(root, "", 1310, 231, 267, 55, 26, ink, true);
            inspectorTitle.enableAutoSizing=true; inspectorTitle.fontSizeMin=19; inspectorTitle.fontSizeMax=26; inspectorTitle.textWrappingMode=TextWrappingModes.NoWrap;
            inspectorBody = Text(root, "", 1310, 294, 266, 115, 15, muted);
            Text(root, "持有什么", 1310, 424, 265, 21, 13, ink, true);
            inspectorResource = Text(root, "", 1310, 453, 264, 77, 14, muted);
            Box(root, "InvariantLine", 1310, 543, 265, 1, line);
            inspectorRule = Text(root, "", 1310, 556, 265, 77, 15, lime);
            inspectorSource = Text(root, "", 1310, 642, 263, 87, 10, muted);
        }

        void BuildTimeline()
        {
            Box(root, "Bottom", 263, 760, 1314, 218, panel);
            Text(root, "运行控制", 281, 776, 125, 22, 14, muted);
            status = Text(root, "", 400, 776, 260, 23, 14, lime, true);
            stepCounter = Text(root, "", 1172, 776, 95, 22, 13, muted, false, TextAlignmentOptions.Right);
            playButton = Button(root, "Play", 281, 812, 155, 42, "开始实验", TogglePlay, 17, true);
            nextButton = Button(root, "Next", 447, 812, 84, 42, "单步 →", () => { Simulation.Playing=false; Advance(); }, 14);
            Button(root, "Reset", 543, 812, 65, 42, "重置", ResetExperiment, 14);
            cancelButton = Button(root, "Cancel", 620, 812, 94, 42, "取消 Run", Cancel, 14);
            viewButton = Button(root, "View", 726, 812, 102, 42, "关闭观察", ToggleView, 14);
            Button(root, "Speed", 840, 812, 69, 42, "速度 1×", () => { speed = speed == 1 ? 2 : 1; SetButtonLabel(root.Find("Speed").GetComponent<UnityEngine.UI.Button>(), "速度 "+speed+"×"); }, 12);
            keyHint = Text(root, "空格 播放/暂停  ·  → 单步  ·  R 重置", 923, 822, 344, 22, 12, muted, false, TextAlignmentOptions.Right);
            for (int i = 0; i < 18; i++) ticks.Add(Box(root, "Step"+i, 281+i*55, 870, 46, 3, line));
            stepTitle = Text(root, "", 281, 889, 487, 33, 23, ink, true);
            stepDetail = Text(root, "", 793, 891, 474, 65, 14, muted);
            events = Text(root, "", 281, 933, 481, 30, 11, muted);
            Box(root, "FactsRule", 1288, 778, 1, 183, line);
            Text(root, "RUN / 事实与占用", 1308, 778, 265, 20, 12, muted);
            nodeCount = Metric("节点", 1308, 810);
            executionCount = Metric("执行次数", 1398, 810);
            resourcesCount = Metric("占用", 1490, 810);
            sessionLabel = Text(root, "", 1308, 874, 258, 18, 11, muted);
            var pos = new[] { new Vector2(1313,920), new Vector2(1376,902), new Vector2(1376,943), new Vector2(1443,902), new Vector2(1510,943) };
            for (int i=1;i<5;i++) historyLines.Add(Box(root, "HistoryEdge"+i, 0, 0, 1, 1, line).rectTransform);
            for (int i=0;i<5;i++)
            {
                int id = i;
                var b = Button(root, "History"+i, pos[i].x, pos[i].y, 48, 25, i==0?"根":"N"+i, () => SelectParent(id), 11);
                historyButtons.Add(b);
                historyCaptions.Add(b.GetComponentInChildren<TMP_Text>());
            }
            historyHint = Text(root, "点节点选择下次 Run 的父节点", 1308, 980, 267, 15, 10, muted);
        }

        TMP_Text Metric(string title, float x, float y)
        {
            var value = Text(root, "0", x, y-3, 73, 41, 26, ink, true);
            Text(root, title, x, y+37, 76, 18, 11, muted); return value;
        }

        public void ChooseExperiment(int choice)
        {
            if (choice < 0 || choice >= 6) return;
            Simulation.Reset((Experiment)choice); elapsed=0; follow=true; Refresh();
        }
        public void SetLens(int value) { lens=value; Refresh(); }
        public void SelectNode(string id) { if(!nodes.ContainsKey(id))return; selected=id; follow=false; Refresh(); }
        public void SelectParent(int id) { Simulation.SelectParent(id); Refresh(); }
        public void ResetExperiment() { Simulation.Reset(Simulation.Experiment); elapsed=0; follow=true; Refresh(); }
        public void Advance() { if(Simulation.Advance()) { elapsed=0; animationTime=0; Refresh(); } }
        public void TogglePlay()
        {
            if(Simulation.Terminal) { if(Simulation.Status!="completed" || !Simulation.StartNextRun()) { ResetExperiment(); } }
            Simulation.Playing = !Simulation.Playing;
            if(Simulation.Playing && Simulation.Index < 0) Simulation.Advance();
            elapsed=0; Refresh();
        }
        public void Cancel() { Simulation.RequestCancel(); elapsed=0; Refresh(); }
        public void ToggleView() { Simulation.ViewOpen=!Simulation.ViewOpen; Refresh(); }
        public void ToggleCatalog() { Simulation.CatalogOnline=!Simulation.CatalogOnline; Refresh(); }
        public void ToggleTools()
        {
            if(Simulation.Running)return;
            Simulation.UsesTools=!Simulation.UsesTools; Simulation.Reset(Experiment.Success); Refresh();
        }

        void Refresh()
        {
            if(root==null)return;
            var s=Simulation;
            if(follow && s.Current!=null) selected=s.Current.To;
            if(!LabContent.Nodes.ContainsKey(selected))selected="runtime";
            for(int i=0;i<experimentButtons.Count;i++) TintButton(experimentButtons[i], (int)s.Experiment==i, lime);
            for(int i=0;i<protocolButtons.Count;i++) { TintButton(protocolButtons[i],s.ProtocolIndex==i,lime); protocolButtons[i].interactable=!s.Running; }
            for(int i=0;i<lensButtons.Count;i++) TintButton(lensButtons[i], lens==i,lime);
            foreach(var item in nodes)
            {
                var info=LabContent.Nodes[item.Key]; var v=item.Value;
                bool active = s.Current!=null && (s.Current.From==item.Key || s.Current.To==item.Key || item.Key=="api"&&s.ModelActive);
                v.Background.color = selected==item.Key ? Hex("33413E") : active ? Hex("2B383A") : tile;
                v.Accent.color = selected==item.Key || active || lens==1 ? GroupColor(info.Group) : line;
                v.Subtitle.text = lens==1 ? (info.Group==0?"客户端 / 展示端":info.Group==1?"执行端根 · 独占本代资源":info.Group==2?"worker 根 · 独占执行":"外部服务") : lens==2 ? PersistenceLabel(item.Key) : info.Subtitle;
                v.State.text = NodeState(item.Key); v.State.color = GroupColor(info.Group);
            }
            nodes["workspace"].Background.color = s.ViewOpen ? tile : Hex("293035");
            if(!s.ProcessAlive) nodes["runtime"].Background.color = Hex("523631");
            status.text = s.Status.ToUpperInvariant() + (s.Playing ? "  /  自动推进" : s.Terminal ? "  /  实验结束" : "  /  已暂停");
            status.color = s.Status=="completed"?lime:s.Terminal||s.Status=="cancelling"?coral:cyan;
            SetButtonLabel(playButton,s.Playing?"暂停":s.Terminal?(s.Status=="completed"?"再运行 / 分支":"重新实验"):s.Index<0?"开始实验":"继续播放");
            SetButtonLabel(viewButton,s.ViewOpen?"关闭观察":"恢复观察");
            SetButtonLabel(toolsButton,s.UsesTools?"● 工具往返  /  切换纯文本":"○ 纯文本  /  切换工具");
            toolsButton.interactable=!s.Running;
            nextButton.interactable=s.CanAdvance; cancelButton.interactable=s.CanCancel;
            stepCounter.text = Math.Max(0,s.Index+1).ToString("00")+" / "+s.Steps.Count.ToString("00");
            for(int i=0;i<ticks.Count;i++) { ticks[i].gameObject.SetActive(i<s.Steps.Count); ticks[i].color=i<s.Index?Hex("759065"):i==s.Index?lime:line; }
            stepTitle.text=s.Current?.Title??"先发起一次 Run，看看谁负责什么。";
            stepDetail.text=s.Current?.Detail??"先试完整工具往返，再选择关闭界面或取消 Run。也可以点击组件、切换观察视角。所有信号和状态均为演示。";
            events.text=s.Events.Count==0?"等待输入  ·  每一步都可暂停检查":"最新事实  /  "+s.Events[s.Events.Count-1];
            nodeCount.text=s.Nodes.Count.ToString("00"); executionCount.text=s.ExecuteCount.ToString("00"); resourcesCount.text=s.LiveResources.ToString("00");
            resourcesCount.color=s.LiveResources>0?coral:lime;
            catalogLabel.text=s.CatalogOnline?"目录在线 · 执行读取本地配置":"目录离线 · 已保存配置仍可执行";
            catalogLabel.color=s.CatalogOnline?muted:coral;
            apiProtocol.text=LabSimulation.Protocols[s.ProtocolIndex]+"\n仅模拟原生交换";
            workerStatus.text=s.ScopeActive?"scope 已占用 · owner "+s.OwnerEpoch:s.ExecuteCount>0?"idle worker 保持设备服务":"按需激活 · 当前未建立 scope";
            sessionLabel.text="下一次 parent = "+(s.SelectedParent==0?"null":"N"+s.SelectedParent)+"  ·  epoch "+s.OwnerEpoch;
            UpdateInspector(); UpdateHistory(); UpdateRoute();
        }

        string NodeState(string id)
        {
            var s=Simulation;
            switch(id)
            {
                case "workspace":return s.ViewOpen?"观察已连接":"观察已关闭 / Run 独立";
                case "run":return s.Accepted?"RUN "+s.RunNumber.ToString("00")+" / "+s.Status:"等待准入";
                case "session":return s.Nodes.Count+" 个成功节点 · "+(s.ResponseSaved?"响应已保存":"等待记录");
                case "runtime":return s.ProcessAlive?"owner "+s.OwnerEpoch+"  /  "+s.LiveResources+" 项占用":"进程离线 · 等待新 owner";
                case "models":return s.ModelActive?"原生请求进行中":s.CatalogOnline?"本地配置就绪":"目录离线 / 配置可用";
                case "worker":return s.ExecuteCount==0?"未激活 / 等待工具需求":"执行 "+s.ExecuteCount+" 次  /  "+(s.ToolActive?"running":s.ScopeActive?"scope 待清理":"idle");
                case "ledger":return s.ExecuteCount>0?"op-01 / receipt 已保存":"独立持久账本";
                case "operations":return s.ScopeActive?"binding + pin 已固定":"工具需求到来时准备";
                case "connections":return "v1 / instance 已固定";
                case "api":return s.ModelActive?"request → response":"进程外边界";
                case "resources":return "接受事务固定引用";
                default:return "JSON / SSE · 白名单代理";
            }
        }

        string PersistenceLabel(string id)
        {
            if(id=="session")return "持久：记录 / cursor / 成功节点";
            if(id=="ledger")return "持久：receipt / 结果 / 实际退出";
            if(id=="models")return "私有：上下文 / 凭据 / 句柄";
            if(id=="runtime")return "本代：program / 观察 / 清理";
            if(id=="workspace" || id=="gateway")return "临时：展示投影 / 观察连接";
            if(id=="resources")return "持久：输入快照 / 不可变原字节";
            return LabContent.Nodes[id].Subtitle;
        }

        void UpdateInspector()
        {
            var n=LabContent.Nodes[selected];
            inspectorTitle.text=n.Title; inspectorOwner.text=n.Owner; inspectorOwner.color=GroupColor(n.Group);
            inspectorBody.text=n.Body; inspectorResource.text=n.Resources; inspectorRule.text=n.Rule; inspectorRule.color=GroupColor(n.Group);
            inspectorSource.text="源码依据\n"+n.Source;
            TintButton(followButton,follow,lime);
        }

        void UpdateHistory()
        {
            var s=Simulation;
            for(int i=0;i<historyButtons.Count;i++)
            {
                var b=historyButtons[i]; bool exists=i==0||s.Nodes.Exists(n=>n.Id==i);
                b.gameObject.SetActive(exists); b.interactable=!s.Running;
                TintButton(b,s.SelectedParent==i,lime);
                if(i==0)continue;
                var edge=historyLines[i-1]; edge.gameObject.SetActive(exists);
                if(!exists)continue;
                var node=s.Nodes.First(n=>n.Id==i);
                var from=historyButtons[node.Parent].GetComponent<RectTransform>().anchoredPosition;
                var to=b.GetComponent<RectTransform>().anchoredPosition;
                SetLine(edge,new Vector2(from.x+48,-from.y+12),new Vector2(to.x,-to.y+12),1);
            }
            historyHint.text=s.Running?"当前 Run 的父节点已经固定":s.Nodes.Count>=4?"已展示 4 个成功节点，重置可再探索":"点节点选择下次 Run 的父节点";
        }

        void UpdateRoute()
        {
            foreach(var segment in route) segment.gameObject.SetActive(false);
            var step=Simulation.Current;
            if(step==null) { currentRoute=Array.Empty<Vector2>();return; }
            var a=Center(step.From); var b=Center(step.To);
            if(step.Mutation==Mutation.ModelStart)
                currentRoute=new[]{a,b,new Vector2(1018,b.y),new Vector2(1018,Center("api").y),Center("api")};
            else if(step.From=="operations" && step.To=="worker" || step.From=="worker" && step.To=="operations")
                currentRoute=new[]{a,new Vector2(a.x,689),new Vector2(b.x,689),b};
            else if((step.From=="models" && step.To=="session") || (step.From=="session" && step.To=="models"))
                currentRoute=new[]{a,b};
            else if(step.From=="gateway" && step.To=="run")
                currentRoute=new[]{a,new Vector2(469,a.y),new Vector2(469,b.y),b};
            else if(Mathf.Abs(a.x-b.x)<10||Mathf.Abs(a.y-b.y)<10)currentRoute=new[]{a,b};
            else currentRoute=new[]{a,new Vector2(a.x,(a.y+b.y)/2),new Vector2(b.x,(a.y+b.y)/2),b};
            for(int i=0;i<currentRoute.Length-1;i++)
            {
                if(route.Count<=i)route.Add(Box(routeLayer,"ActiveRoute",0,0,1,1,lime));
                route[i].gameObject.SetActive(true); route[i].color=Simulation.Status=="cancelling"||Simulation.Status=="cleanup-failed"?coral:lime;
                SetLine(route[i].rectTransform,currentRoute[i],currentRoute[i+1],2);
            }
            packet.GetComponent<UnityEngine.UI.Image>().color=Simulation.Status=="cancelling"?coral:lime;
        }

        Vector2 Center(string id)
        {
            var r=nodes[id].Rect; return new Vector2(r.anchoredPosition.x+r.sizeDelta.x*.5f,-r.anchoredPosition.y+r.sizeDelta.y*.5f);
        }

        void AddNode(string id,float x,float y,float w,float h)
        {
            var n=LabContent.Nodes[id]; var b=Button(root,id,x,y,w,h,"",()=>SelectNode(id));
            var rt=b.GetComponent<RectTransform>();
            var v=new NodeVisual { Rect=rt, Button=b, Background=b.GetComponent<UnityEngine.UI.Image>() };
            v.Accent=Box(rt,"Accent",0,0,3,h,GroupColor(n.Group));
            v.Title=Text(rt,n.Title,12,8,w-24,27,w<180?19:21,ink,true);
            v.Title.enableAutoSizing=true;v.Title.fontSizeMin=16;v.Title.fontSizeMax=w<180?19:21;
            v.Subtitle=Text(rt,n.Subtitle,12,38,w-24,21,11,muted);
            v.State=Text(rt,"",12,h-23,w-24,20,10,GroupColor(n.Group));
            if(h<=83) { v.Subtitle.rectTransform.anchoredPosition=new Vector2(12,-36);v.State.rectTransform.anchoredPosition=new Vector2(12,-59); }
            nodes.Add(id,v);
        }

        void Zone(string name,float x,float y,float w,float h,string title,string subtitle,Color color,bool rootZone)
        {
            var z=Box(root,name,x,y,w,h,Hex("172127")).rectTransform;
            Box(z,"Border",0,0,w,1,Color.Lerp(line,color,.35f)); Box(z,"Left",0,0,1,h,line);Box(z,"Right",w-1,0,1,h,line);Box(z,"Bottom",0,h-1,w,1,line);
            Text(z,title,14,12,w-26,25,17,ink,true);
            Text(z,subtitle,14,38,w-26,17,10,color);
        }

        void StaticLink(Vector2 a,Vector2 b,Color color)
        { var r=Box(routeLayer,"Link",0,0,1,1,Color.Lerp(line,color,.12f)).rectTransform;SetLine(r,a,b,1); }

        static void SetLine(RectTransform r,Vector2 a,Vector2 b,float thickness)
        {
            r.pivot=new Vector2(0,.5f);r.anchoredPosition=new Vector2(a.x,-a.y);r.sizeDelta=new Vector2(Vector2.Distance(a,b),thickness);
            var delta=new Vector2(b.x-a.x,-b.y+a.y);r.localRotation=Quaternion.Euler(0,0,Mathf.Atan2(delta.y,delta.x)*Mathf.Rad2Deg);
        }

        RectTransform Rect(Transform parent,string name,float x,float y,float w,float h)
        {
            var go=new GameObject(name,typeof(RectTransform));go.transform.SetParent(parent,false);
            var rt=go.GetComponent<RectTransform>();rt.anchorMin=rt.anchorMax=new Vector2(0,1);rt.pivot=new Vector2(0,1);rt.anchoredPosition=new Vector2(x,-y);rt.sizeDelta=new Vector2(w,h);return rt;
        }

        UnityEngine.UI.Image Box(Transform parent,string name,float x,float y,float w,float h,Color color)
        {
            var r=Rect(parent,name,x,y,w,h);var im=r.gameObject.AddComponent<UnityEngine.UI.Image>();im.color=color;im.raycastTarget=false;return im;
        }

        TMP_Text Text(Transform parent,string value,float x,float y,float w,float h,float size,Color color,bool bold=false,TextAlignmentOptions alignment=TextAlignmentOptions.TopLeft)
        {
            var r=Rect(parent,"Text",x,y,w,h);var t=r.gameObject.AddComponent<TextMeshProUGUI>();
            t.font=Font;t.text=value;t.fontSize=size;t.color=color;t.fontStyle=bold?FontStyles.Bold:FontStyles.Normal;
            t.alignment=alignment;t.raycastTarget=false;t.textWrappingMode=TextWrappingModes.Normal;t.overflowMode=TextOverflowModes.Ellipsis;
            t.margin=Vector4.zero;return t;
        }

        UnityEngine.UI.Button Button(Transform parent,string name,float x,float y,float w,float h,string label,Action action,int fontSize=14,bool primary=false)
        {
            var box=Box(parent,name,x,y,w,h,primary?lime:tile);box.raycastTarget=true;
            var b=box.gameObject.AddComponent<UnityEngine.UI.Button>();b.targetGraphic=box;
            var colors=b.colors;colors.normalColor=Color.white;colors.highlightedColor=new Color(1.18f,1.18f,1.18f,1);colors.pressedColor=new Color(.75f,.8f,.7f,1);colors.selectedColor=Color.white;colors.disabledColor=new Color(.48f,.5f,.5f,.6f);b.colors=colors;
            b.navigation=new UnityEngine.UI.Navigation { mode=UnityEngine.UI.Navigation.Mode.None };
            if(!string.IsNullOrEmpty(label))Text(box.transform,label,7,0,w-14,h,fontSize,primary?bg:ink,primary,TextAlignmentOptions.Center);
            b.onClick.AddListener(()=>action());return b;
        }

        void Tag(Transform parent,string label,float x,float y,float w,Color color)
        { var r=Box(parent,"Tag",x,y,w,28,Color.Lerp(bg,color,.12f)).rectTransform;Text(r,label,0,0,w,28,13,color,false,TextAlignmentOptions.Center); }

        void TintButton(UnityEngine.UI.Button b,bool active,Color color)
        { b.GetComponent<UnityEngine.UI.Image>().color=active?Color.Lerp(tile,color,.20f):tile; }
        void SetButtonLabel(UnityEngine.UI.Button b,string value)
        {
            var text=b.GetComponentInChildren<TMP_Text>();
            if(text!=null)text.text=value;
            else Text(b.transform,value,7,0,b.GetComponent<RectTransform>().sizeDelta.x-14,b.GetComponent<RectTransform>().sizeDelta.y,13,ink,false,TextAlignmentOptions.Center);
        }
        public object Snapshot() => new { Simulation.Status, Simulation.Index, Simulation.OwnerEpoch, Simulation.ExecuteCount, Simulation.LiveResources, Simulation.ResponseSaved, Simulation.ViewOpen, Simulation.ProcessAlive, Nodes=Simulation.Nodes.Count, Parent=Simulation.SelectedParent, Current=Simulation.Current?.Title };
    }
}
