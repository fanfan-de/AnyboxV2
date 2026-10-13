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
    // A spatial explanation of ownership, not a second implementation of Anybox.
    // The same deterministic simulation powers the 2D and 3D presentations.
    public sealed class ArchitectureSpace : MonoBehaviour
    {
        public TMP_FontAsset Font;
        public Camera WorldCamera;
        public Material SurfaceTemplate, SignalTemplate, GroundTemplate;
        public static ArchitectureSpace Active { get; private set; }
        public LabSimulation Simulation { get; private set; }
        public string Selected => selected;
        public bool Expanded => expanded;
        public float OrbitYaw => yaw;
        public float OrbitDistance => distance;
        public int NodeVisualCount => nodes.Count;
        public Vector3 NodePosition(string id) => nodes[id].Root.position;

        static Color C(string value) { ColorUtility.TryParseHtmlString("#" + value, out var c); return c; }
        readonly Color bg = C("0C151D"), panel = C("15222C"), edge = C("2B3D48"), ink = C("EEF4EF"), muted = C("9DAFB8");
        readonly Color cyan = C("78CEDB"), lime = C("D4EB9C"), purple = C("B5A0E6"), amber = C("EEB283"), red = C("F28882");
        readonly Dictionary<string, SpatialNode> nodes = new Dictionary<string, SpatialNode>();
        readonly List<Material> materials = new List<Material>();
        readonly List<(LineRenderer line, string from, string to)> links = new List<(LineRenderer, string, string)>();
        readonly List<(LineRenderer line, Vector3 basePoint)> posts = new List<(LineRenderer, Vector3)>();
        readonly List<(LineRenderer line, Vector3 from, Vector3 to)> roof = new List<(LineRenderer, Vector3, Vector3)>();
        readonly List<UnityEngine.UI.Button> scenarios = new List<UnityEngine.UI.Button>();
        readonly List<UnityEngine.UI.Button> historyButtons = new List<UnityEngine.UI.Button>();
        readonly List<GameObject> historyObjects = new List<GameObject>();
        readonly List<LineRenderer> historyLines = new List<LineRenderer>();
        readonly List<RectTransform> stepTicks = new List<RectTransform>();
        Transform world, packet, apiPacket, scopeRing, selectionRing;
        LineRenderer activePath, apiPath;
        RectTransform ui, viewport, labelLayer;
        TMP_Text title, owner, body, resource, rule, source, status, stepTitle, stepDetail, stepNumber, counters, historyCaption, modeHint, guideText, protocolText;
        UnityEngine.UI.Button play, next, cancel, explode, followButton, toolsButton, catalogButton, observationButton, protocolButton;
        RectTransform inspector;
        string selected = "runtime";
        bool expanded, cameraFollow, pointerDragging;
        float elapsed, phase, split, yaw = -12, pitch = 50, distance = 28;
        float desiredYaw = -12, desiredPitch = 50, desiredDistance = 28;
        Vector3 focus = new Vector3(0, 1.3f, .5f), desiredFocus = new Vector3(0, 1.3f, .5f);
        Vector2 downAt;
        int seenNodes = -1;

        sealed class SpatialNode
        {
            public Transform Root;
            public Vector3 BasePosition;
            public bool Persistent;
            public Material Surface, Accent;
            public LineRenderer Stem;
            public LineRenderer Orbit;
            public RectTransform Label;
            public RectTransform Leader;
            public TMP_Text Caption, State;
            public UnityEngine.UI.Image LabelAccent;
            public Color Color;
        }

        void Awake()
        {
            Active = this;
            Application.targetFrameRate = 60; Application.runInBackground = true;
            Simulation = new LabSimulation();
            if (Font == null || WorldCamera == null) { Debug.LogError("Architecture Space needs a camera and the baked CJK font."); enabled = false; return; }
            BuildWorld(); BuildUI(); Refresh();
        }

        void OnDestroy()
        {
            if (Active == this) Active = null;
            foreach (var material in materials) if (material != null) Destroy(material);
        }

        Material Mat(Color color, bool luminous = false)
        {
            var template=luminous?SignalTemplate:SurfaceTemplate;
            var material=template!=null?new Material(template):new Material(Shader.Find(luminous ? "Universal Render Pipeline/Unlit" : "Universal Render Pipeline/Lit"));
            material.SetColor("_BaseColor", luminous?color:WorldColor(color));
            if (!luminous) { material.SetFloat("_Smoothness", .38f); material.SetFloat("_Metallic", .12f); }
            materials.Add(material); return material;
        }

        static Color WorldColor(Color color) => QualitySettings.activeColorSpace==ColorSpace.Linear?color.linear:color;

        Transform Solid(string name, PrimitiveType type, Transform parent, Vector3 position, Vector3 scale, Material material)
        {
            var go = GameObject.CreatePrimitive(type); go.name = name; go.transform.SetParent(parent, false);
            go.transform.localPosition = position; go.transform.localScale = scale;
            go.GetComponent<Renderer>().sharedMaterial = material;
            var collider = go.GetComponent<Collider>(); if (collider != null) Destroy(collider);
            return go.transform;
        }

        LineRenderer Line(string name, Transform parent, Color color, float width, params Vector3[] points)
        {
            var go = new GameObject(name, typeof(LineRenderer)); go.transform.SetParent(parent, false);
            var line = go.GetComponent<LineRenderer>(); line.useWorldSpace = true;
            line.sharedMaterial = Mat(color, true); line.startWidth = line.endWidth = width;
            line.shadowCastingMode=UnityEngine.Rendering.ShadowCastingMode.Off;line.receiveShadows=false;
            line.numCapVertices = 4; line.numCornerVertices = 3; line.positionCount = points.Length; line.SetPositions(points);
            return line;
        }

        void Ring(LineRenderer ring, Vector3 center, float radius)
        {
            ring.positionCount = 65;
            for (int i = 0; i <= 64; i++) { float a = i * Mathf.PI / 32; ring.SetPosition(i, center + new Vector3(Mathf.Cos(a) * radius, 0, Mathf.Sin(a) * radius)); }
        }

        void BuildWorld()
        {
            world = new GameObject("Spatial Architecture").transform; world.SetParent(transform, false);
            var floorMaterial=GroundTemplate!=null?new Material(GroundTemplate):Mat(C("12212C"));if(GroundTemplate!=null)materials.Add(floorMaterial);
            floorMaterial.SetColor("_BaseColor",WorldColor(C("12212C")));floorMaterial.SetFloat("_Metallic",0);floorMaterial.SetFloat("_Smoothness",0);floorMaterial.SetFloat("_EnvironmentReflections",0);floorMaterial.EnableKeyword("_ENVIRONMENTREFLECTIONS_OFF");
            Solid("Ground", PrimitiveType.Cube, world, new Vector3(0, -.55f, 1), new Vector3(75, .25f, 55), floorMaterial);
            for (int x = -26; x <= 26; x += 2) Line("Grid X", world, C("1B303D"), .013f, new Vector3(x, -.41f, -17), new Vector3(x, -.41f, 19));
            for (int z = -16; z <= 18; z += 2) Line("Grid Z", world, C("1B303D"), .013f, new Vector3(-26, -.41f, z), new Vector3(26, -.41f, z));
            Platform("01 Client process", new Vector3(-13, 0, 0), new Vector2(8, 10), cyan);
            Platform("02 Execution process", Vector3.zero, new Vector2(15, 11), lime);
            Platform("03 Worker process", new Vector3(13, 0, 0), new Vector2(8, 10), purple);

            AddNode("workspace", new Vector3(-14, 2.3f, -8.8f), false, "Anybox 工作区", "浏览器 / 展示端");
            AddNode("gateway", new Vector3(-13, 2.8f, 1.6f), false, "Client Gateway", "观察与代理");
            AddNode("connections", new Vector3(-13, .9f, -2.7f), true, "Connections", "客户端库 · Vault");
            AddNode("run", new Vector3(-4.8f, 2.7f, -1.7f), false, "Run", "准入 · 准备");
            AddNode("runtime", new Vector3(0, 4, 1.0f), false, "RunRuntime", "本代运行所有权");
            AddNode("models", new Vector3(4.6f, 2.8f, 3.5f), false, "Models", "私有 execution");
            AddNode("session", new Vector3(0, .95f, -3.5f), true, "Session", "可恢复的事实");
            AddNode("operations", new Vector3(4.8f, 2.6f, -1.7f), false, "Computer Operations", "声明 · 绑定 · 观察");
            AddNode("resources", new Vector3(-4.8f, .9f, 3.5f), true, "输入与持久资源", "多个组件的职责分组");
            AddNode("worker", new Vector3(13, 3, 1.5f), false, "Computer Worker", "独立工具进程");
            AddNode("ledger", new Vector3(13, .9f, -2.8f), true, "Worker Ledger", "独立账本");
            AddNode("api", new Vector3(5.6f, 4.2f, 10.8f), false, "Model API", "进程外端点");

            foreach (var pair in new[] {"workspace|gateway", "connections|gateway", "gateway|run", "run|session", "run|runtime", "resources|run", "session|runtime", "runtime|models", "models|api", "session|operations", "operations|worker", "worker|ledger"})
            {
                var ids = pair.Split('|'); links.Add((Line(pair, world, C("344B57"), .025f), ids[0], ids[1]));
            }
            activePath = Line("Current behavior", world, lime, .095f);
            apiPath = Line("Native exchange", world, amber, .075f);
            packet = Solid("Traveling intent", PrimitiveType.Sphere, world, Vector3.zero, Vector3.one * .38f, Mat(ink, true));
            apiPacket = Solid("Native response", PrimitiveType.Sphere, world, Vector3.zero, Vector3.one * .3f, Mat(amber, true));
            scopeRing = Line("Run process scope", world, purple, .10f).transform;
            selectionRing = Line("Selected module", world, ink, .045f).transform;
        }

        void Platform(string name, Vector3 position, Vector2 size, Color color)
        {
            var root = new GameObject(name).transform; root.SetParent(world, false);
            Solid("Process foundation", PrimitiveType.Cube, root, position, new Vector3(size.x, .4f, size.y), Mat(Color.Lerp(C("23323C"), color, .09f)));
            var corners = new[] {position + new Vector3(-size.x/2,.25f,-size.y/2), position + new Vector3(size.x/2,.25f,-size.y/2),position + new Vector3(size.x/2,.25f,size.y/2),position + new Vector3(-size.x/2,.25f,size.y/2)};
            Line("One Nya root boundary", root, color * .65f, .055f, corners[0], corners[1], corners[2], corners[3], corners[0]);
            foreach (var p in corners)
            {
                posts.Add((Line("Process corner", root, Color.Lerp(bg, color, .35f), .027f, p, p + Vector3.up * 6.6f),p));
                Solid("Boundary pin", PrimitiveType.Cylinder, root, p + Vector3.up * .16f, new Vector3(.13f,.16f,.13f), Mat(color,true));
            }
            // Dotted top boundary keeps the volume legible without opaque walls.
            for (int side = 0; side < 4; side++)
            {
                var a = corners[side]; var b = corners[(side+1)%4];
                for (int i = 0; i < 10; i++) roof.Add((Line("Process volume",root,Color.Lerp(bg,color,.24f),.024f),Vector3.Lerp(a,b,i/10f),Vector3.Lerp(a,b,(i+.45f)/10f)));
            }
        }

        void AddNode(string id, Vector3 position, bool persistent, string label, string state)
        {
            var info = LabContent.Nodes[id]; var color = info.Group == 0 ? cyan : info.Group == 1 ? lime : info.Group == 2 ? purple : amber;
            var node = new SpatialNode { Root = new GameObject(info.Title).transform, BasePosition = position, Persistent = persistent, Color = color };
            node.Root.SetParent(world,false); node.Root.position = position;
            node.Surface = Mat(Color.Lerp(C("263C4B"), color, .18f)); node.Accent = Mat(color, true);
            var dim = Mat(Color.Lerp(C("152530"), color, .09f));
            if (persistent)
            {
                for (int i = 0; i < 3; i++)
                {
                    Solid("Durable layer", PrimitiveType.Cube,node.Root,new Vector3(0,-.25f+i*.25f,0),new Vector3(3.1f,.16f,2.05f),node.Surface);
                    Solid("Record stripe", PrimitiveType.Cube,node.Root,new Vector3(0,-.22f+i*.25f,-1.035f),new Vector3(2.6f,.035f,.03f),node.Accent);
                }
            }
            else if (id == "runtime")
            {
                Solid("Program core",PrimitiveType.Sphere,node.Root,Vector3.zero,Vector3.one*1.9f,node.Surface);
                var orbit = Line("Execution ring",node.Root,color,.065f);node.Orbit=orbit;orbit.useWorldSpace=false; orbit.positionCount=65;
                for(int i=0;i<=64;i++){float a=i*Mathf.PI/32;orbit.SetPosition(i,new Vector3(Mathf.Cos(a)*1.65f,.1f,Mathf.Sin(a)*1.65f));}
                Solid("Ownership beacon",PrimitiveType.Sphere,node.Root,new Vector3(0,1.05f,0),Vector3.one*.25f,node.Accent);
            }
            else if (id == "models")
            {
                Solid("Native execution",PrimitiveType.Cube,node.Root,Vector3.zero,new Vector3(1.2f,1.45f,1.2f),node.Surface);
                for(int i=0;i<4;i++) {float a=i*Mathf.PI/2;Solid("Protocol driver",PrimitiveType.Cylinder,node.Root,new Vector3(Mathf.Cos(a)*1.1f,-.1f,Mathf.Sin(a)*1.1f),new Vector3(.6f,.55f,.6f),node.Accent);}
            }
            else if (id == "workspace")
            {
                Solid("Observation screen",PrimitiveType.Cube,node.Root,Vector3.zero,new Vector3(3.5f,1.9f,.22f),node.Surface);
                Solid("Screen glow",PrimitiveType.Cube,node.Root,new Vector3(0,0,-.13f),new Vector3(3.1f,1.55f,.035f),dim);
                for(int i=0;i<3;i++)Solid("Display row",PrimitiveType.Cube,node.Root,new Vector3(-.1f,.4f-i*.4f,-.16f),new Vector3(2.35f,.05f,.025f),node.Accent);
                Solid("Display foot",PrimitiveType.Cylinder,node.Root,new Vector3(0,-1.1f,0),new Vector3(1.25f,.07f,.8f),node.Surface);
            }
            else if(id=="api")
            {
                var crystal=Solid("External model",PrimitiveType.Cube,node.Root,Vector3.zero,Vector3.one*1.75f,node.Surface);crystal.localRotation=Quaternion.Euler(25,30,25);
                Solid("Endpoint",PrimitiveType.Sphere,node.Root,new Vector3(0,1.35f,0),Vector3.one*.3f,node.Accent);
            }
            else
            {
                Solid("Service body",PrimitiveType.Cube,node.Root,Vector3.zero,new Vector3(2.9f,1.25f,1.9f),node.Surface);
                Solid("Service rim",PrimitiveType.Cube,node.Root,new Vector3(0,.66f,0),new Vector3(3,.085f,2),node.Accent);
                for(int i=0;i<3;i++)Solid("Service indicator",PrimitiveType.Sphere,node.Root,new Vector3(-.8f+i*.48f,-.05f,-.98f),Vector3.one*.12f,node.Accent);
            }
            var collider=node.Root.gameObject.AddComponent<BoxCollider>();collider.size=new Vector3(3.3f,persistent?.9f:2.3f,2.3f);
            node.Root.gameObject.AddComponent<SpacePickTarget>().Id=id;
            node.Stem=Line("Resource ownership tether",world,Color.Lerp(bg,color,.27f),.025f);
            nodes.Add(id,node);
        }

        void BuildUI()
        {
            var canvasGo=new GameObject("Spatial HUD",typeof(RectTransform),typeof(Canvas),typeof(UnityEngine.UI.CanvasScaler),typeof(UnityEngine.UI.GraphicRaycaster));canvasGo.transform.SetParent(transform,false);
            canvasGo.GetComponent<Canvas>().renderMode=RenderMode.ScreenSpaceOverlay;
            var scaler=canvasGo.GetComponent<UnityEngine.UI.CanvasScaler>();scaler.uiScaleMode=UnityEngine.UI.CanvasScaler.ScaleMode.ScaleWithScreenSize;scaler.referenceResolution=new Vector2(1600,1000);scaler.screenMatchMode=UnityEngine.UI.CanvasScaler.ScreenMatchMode.Expand;
            ui=Rect(canvasGo.transform,"Design",0,0,1600,1000);ui.anchorMin=ui.anchorMax=ui.pivot=new Vector2(.5f,.5f);ui.anchoredPosition=Vector2.zero;
            viewport=Rect(ui,"3D viewport",24,224,1208,548);
            labelLayer=Rect(viewport,"Projected labels",0,0,1208,548);labelLayer.gameObject.AddComponent<UnityEngine.UI.RectMask2D>();
            if(FindAnyObjectByType<EventSystem>()==null)
            {
                var e=new GameObject("EventSystem",typeof(EventSystem),typeof(InputSystemUIInputModule));e.transform.SetParent(transform,false);e.GetComponent<InputSystemUIInputModule>().AssignDefaultActions();
            }
            Box(ui,"Header",20,20,1560,139,bg,false);
            Text(ui,"A /",32,26,62,50,33,lime,true);
            Text(ui,"Anybox 架构空间",101,24,580,52,32,ink,true);
            Text(ui,"SPATIAL FRAMEWORK  /  02",104,77,610,22,12,muted);
            Text(ui,"走进边界，看见一次 Run。",900,31,664,41,23,ink,false,TextAlignmentOptions.Right);
            Text(ui,"本地教学模拟 · 真实 3D 视角 · 不连接模型或工具",870,78,692,22,13,muted,false,TextAlignmentOptions.Right);
            for(int i=0;i<6;i++)
            {
                int choice=i;scenarios.Add(Button(ui,"Scenario"+i,32+i*258,115,247,40,LabSimulation.ExperimentNames[i],()=>ChooseExperiment(choice),14));
            }
            Box(ui,"Top divider",32,170,1536,1,edge,false);
            Button(ui,"Overview",32,187,88,34,"全景  1",()=>SetView(0),13);
            Button(ui,"Execution view",127,187,105,34,"执行端  2",()=>SetView(1),13);
            Button(ui,"Worker view",239,187,100,34,"Worker  3",()=>SetView(2),13);
            explode=Button(ui,"Explode layers",346,187,105,34,"分层展开",ToggleLayers,13);
            followButton=Button(ui,"Follow camera",458,187,105,34,"镜头跟随",()=>{cameraFollow=!cameraFollow;Refresh();},13);
            Text(ui,"左拖旋转  ·  右拖平移  ·  滚轮缩放  ·  双击聚焦",585,190,646,27,13,muted,false,TextAlignmentOptions.Right);

            foreach(var pair in nodes)
            {
                string id=pair.Key;var n=pair.Value;
                n.Leader=Box(labelLayer,"Leader "+id,0,0,1,1,Color.Lerp(edge,n.Color,.45f),false).rectTransform;n.Leader.anchorMin=n.Leader.anchorMax=n.Leader.pivot=new Vector2(.5f,.5f);
                var label=Rect(labelLayer,"Label "+id,0,0,146,45);label.anchorMin=label.anchorMax=new Vector2(.5f,.5f);label.pivot=new Vector2(.5f,1);
                var click=label.gameObject.AddComponent<UnityEngine.UI.Image>();click.color=new Color(bg.r,bg.g,bg.b,.91f);
                var button=label.gameObject.AddComponent<UnityEngine.UI.Button>();button.targetGraphic=click;button.onClick.AddListener(()=>SelectNode(id));
                label.gameObject.AddComponent<SpaceLabelPointer>().Id=id;
                n.Label=label;n.LabelAccent=Box(label,"Accent",0,0,3,45,n.Color,false);
                string caption=id=="resources"?"输入与持久资源":id=="workspace"?"Anybox 工作区":id=="operations"?"Computer Ops":LabContent.Nodes[id].Title;
                n.Caption=Text(label,caption,9,1,132,25,13,ink,true);
                n.State=Text(label,"",9,26,132,17,10,n.Color);
            }
            // Process captions sit outside the orbiting labels and remain easy to compare.
            ProcessLegend(32,778,"01  客户端进程",cyan,"一个 Nya 根");
            ProcessLegend(416,778,"02  harness server",lime,"Authority + Runtime · 一个根");
            ProcessLegend(880,778,"03  独立 worker",purple,"一个 Nya 根");
            inspector=Rect(ui,"Inspector",1253,185,315,783);
            Box(inspector,"Panel",0,0,315,783,panel,true);
            Text(inspector,"组件观察",20,13,270,25,12,muted);
            title=Text(inspector,"",20,45,274,69,25,ink,true);
            owner=Text(inspector,"",20,119,274,43,12,lime);
            body=Text(inspector,"",20,174,274,148,14,ink);
            Text(inspector,"独占资源 / 保存什么",20,337,274,24,11,muted);
            resource=Text(inspector,"",20,369,274,94,13,ink);
            Box(inspector,"Rule separator",20,479,275,1,edge,false);
            rule=Text(inspector,"",20,496,274,123,14,lime);
            source=Text(inspector,"",20,631,274,61,10,muted);
            Button(inspector,"Focus selection",20,706,130,43,"聚焦此模块",()=>FocusNode(selected),13);
            Button(inspector,"Back to overview",161,706,134,43,"返回全景",()=>SetView(0),13);

            Box(ui,"Console",32,832,1195,137,panel,true);
            status=Text(ui,"",49,844,137,25,13,lime,true);
            stepTitle=Text(ui,"",207,840,855,34,20,ink,true);
            stepNumber=Text(ui,"",1108,846,100,23,12,muted,false,TextAlignmentOptions.Right);
            stepDetail=Text(ui,"",207,882,983,52,13,muted);
            play=Button(ui,"Play",49,884,68,39,"播放",TogglePlay,13);
            next=Button(ui,"Next",123,884,68,39,"单步",()=>{Simulation.Playing=false;Advance();},13);
            Button(ui,"Reset",49,930,68,27,"重置",ResetExperiment,11);
            cancel=Button(ui,"Cancel",123,930,68,27,"取消",()=>{Simulation.RequestCancel();Refresh();},11);
            for(int i=0;i<20;i++)stepTicks.Add(Box(ui,"Step "+i,207+i*49,949,43,3,edge,false).rectTransform);

            // Options are in a compact pull-out panel shown by the lower left button.
            var options=Rect(ui,"Experiment options",32,549,304,215);options.gameObject.SetActive(false);
            Box(options,"Options backdrop",0,0,304,215,panel,true);
            protocolButton=Button(options,"Protocol",12,12,280,35,"",()=>{Simulation.SetProtocol((Simulation.ProtocolIndex+1)%4);seenNodes=-1;Refresh();},12);
            protocolText=protocolButton.GetComponentInChildren<TMP_Text>();
            toolsButton=Button(options,"Tools",12,55,135,34,"",()=>{Simulation.UsesTools=!Simulation.UsesTools;ResetExperiment();},12);
            catalogButton=Button(options,"Catalog",155,55,137,34,"",()=>{Simulation.CatalogOnline=!Simulation.CatalogOnline;Refresh();},12);
            observationButton=Button(options,"Observation",12,97,280,34,"",()=>{Simulation.ViewOpen=!Simulation.ViewOpen;Refresh();},12);
            Text(options,"协议切换会新建模拟会话。\n目录离线不阻止已保存配置执行。",14,145,275,55,12,muted);
            Button(ui,"Options toggle",32,239,102,32,"实验条件",()=>options.gameObject.SetActive(!options.gameObject.activeSelf),12);
            modeHint=Text(ui,"",148,244,760,27,12,muted);
            counters=Text(ui,"",34,807,1194,22,12,muted);
            historyCaption=Text(ui,"",742,280,476,25,12,muted,false,TextAlignmentOptions.Right);
            for(int i=0;i<5;i++)
            {
                int parent=i;var b=Button(ui,"Parent "+i,904+i*63,310,57,30,i==0?"根":"N"+i,()=>{Simulation.SelectParent(parent);Refresh();},11);historyButtons.Add(b);
            }
            guideText=Text(ui,"选择实验，再按播放。点击模块查看职责。",32,981,1170,19,11,muted);
        }

        void ProcessLegend(float x,float y,string name,Color color,string subtitle)
        {
            Box(ui,"Process dot",x,y+8,7,7,color,false);Text(ui,name+" / 1 根",x+17,y,335,24,13,color,true);
        }

        void Update()
        {
            float dt=Time.unscaledDeltaTime;phase+=dt;
            if(Simulation.Playing){elapsed+=dt;if(elapsed>=2.65f){elapsed=0;Advance();}}
            var k=Keyboard.current;
            if(k!=null)
            {
                if(k.spaceKey.wasPressedThisFrame)TogglePlay();
                if(k.rightArrowKey.wasPressedThisFrame){Simulation.Playing=false;Advance();}
                if(k.rKey.wasPressedThisFrame)ResetExperiment();
                if(k.eKey.wasPressedThisFrame)ToggleLayers();
                if(k.digit1Key.wasPressedThisFrame)SetView(0);
                if(k.digit2Key.wasPressedThisFrame)SetView(1);
                if(k.digit3Key.wasPressedThisFrame)SetView(2);
                if(k.escapeKey.wasPressedThisFrame){Simulation.Playing=false;Refresh();}
            }
            HandleMouse();
            float smooth=1-Mathf.Exp(-dt*8);
            split=Mathf.Lerp(split,expanded?1:0,smooth);
            foreach(var post in posts){post.line.SetPosition(0,post.basePoint);post.line.SetPosition(1,post.basePoint+Vector3.up*(6.6f+split*2.8f));}
            foreach(var top in roof){top.line.positionCount=2;top.line.SetPosition(0,top.from+Vector3.up*(6.6f+split*2.8f));top.line.SetPosition(1,top.to+Vector3.up*(6.6f+split*2.8f));}
            foreach(var n in nodes.Values)
            {
                float rise=n.Persistent?0:split*2.8f;
                n.Root.position=n.BasePosition+Vector3.up*rise;
                var bottom=n.BasePosition;bottom.y=.3f;
                n.Stem.positionCount=2;n.Stem.SetPosition(0,bottom);n.Stem.SetPosition(1,n.Root.position);
            }
            focus=Vector3.Lerp(focus,desiredFocus,smooth);yaw=Mathf.Lerp(yaw,desiredYaw,smooth);pitch=Mathf.Lerp(pitch,desiredPitch,smooth);distance=Mathf.Lerp(distance,desiredDistance,smooth);
            WorldCamera.transform.position=focus+Quaternion.Euler(pitch,yaw,0)*Vector3.back*distance;
            WorldCamera.transform.LookAt(focus);
            foreach(var link in links)Curve(link.line,nodes[link.from].Root.position,nodes[link.to].Root.position,.7f);
            var current=Simulation.Current;
            bool active=current!=null&&nodes.ContainsKey(current.From)&&nodes.ContainsKey(current.To);
            activePath.gameObject.SetActive(active);packet.gameObject.SetActive(active&&Simulation.ProcessAlive);
            activePath.sharedMaterial.SetColor("_BaseColor",Simulation.ProcessAlive?lime:muted*.55f);
            if(active)
            {
                var a=nodes[current.From].Root.position+Vector3.up*.45f;var b=nodes[current.To].Root.position+Vector3.up*.45f;
                Curve(activePath,a,b,2);packet.position=Arc(a,b,Mathf.Repeat(phase*.45f,1),2);
            }
            apiPath.gameObject.SetActive(Simulation.ModelActive);apiPacket.gameObject.SetActive(Simulation.ModelActive);
            if(Simulation.ModelActive)
            {
                var a=nodes["models"].Root.position;var b=nodes["api"].Root.position;
                Curve(apiPath,a,b,1.7f);apiPacket.position=Arc(a,b,Mathf.Repeat(phase*.6f,1),1.7f);
            }
            scopeRing.gameObject.SetActive(Simulation.ScopeActive);
            if(Simulation.ScopeActive)Ring(scopeRing.GetComponent<LineRenderer>(),nodes["worker"].Root.position+Vector3.down*.85f,2.15f+Mathf.Sin(phase*3)*.06f);
            Ring(selectionRing.GetComponent<LineRenderer>(),nodes[selected].Root.position+Vector3.down*.75f,1.95f);
            for(int i=0;i<historyObjects.Count;i++)historyObjects[i].transform.Rotate(0,dt*22,0,Space.World);
        }

        void LateUpdate()
        {
            var corners=new Vector3[4];viewport.GetWorldCorners(corners);
            WorldCamera.rect=new Rect(corners[0].x/Screen.width,corners[0].y/Screen.height,(corners[2].x-corners[0].x)/Screen.width,(corners[2].y-corners[0].y)/Screen.height);
            var projected=new List<(SpatialNode node,Vector2 anchor,float depth)>();
            foreach(var n in nodes.Values)
            {
                var p=WorldCamera.WorldToScreenPoint(n.Root.position+Vector3.down*.85f);
                RectTransformUtility.ScreenPointToLocalPointInRectangle(labelLayer,p,null,out var local);
                projected.Add((n,local-labelLayer.rect.center,p.z));
            }
            var placed=new List<Rect>();
            foreach(var item in projected.OrderByDescending(p=>p.anchor.y))
            {
                var n=item.node;var desired=item.anchor+new Vector2(0,-5);var at=desired;
                var rect=new Rect(at.x-73,at.y-45,146,45);
                for(int attempt=0;attempt<12;attempt++)
                {
                    bool moved=false;
                    foreach(var previous in placed)
                    {
                        var padded=new Rect(previous.x-4,previous.y-4,previous.width+8,previous.height+8);
                        if(!rect.Overlaps(padded))continue;
                        at.y=padded.yMin-4;rect.y=at.y-45;moved=true;
                    }
                    if(!moved)break;
                }
                placed.Add(rect);n.Label.anchoredPosition=at;n.Label.gameObject.SetActive(item.depth>0);
                var delta=at-item.anchor;n.Leader.gameObject.SetActive(item.depth>0&&delta.magnitude>12);
                n.Leader.anchoredPosition=(at+item.anchor)*.5f;n.Leader.sizeDelta=new Vector2(delta.magnitude,1);n.Leader.localRotation=Quaternion.Euler(0,0,Mathf.Atan2(delta.y,delta.x)*Mathf.Rad2Deg);
            }
        }

        void HandleMouse()
        {
            var m=Mouse.current;if(m==null)return;
            var position=m.position.ReadValue();bool inside=WorldCamera.pixelRect.Contains(position);
            bool overUI=EventSystem.current!=null&&EventSystem.current.IsPointerOverGameObject();
            if(m.leftButton.wasPressedThisFrame&&inside&&!overUI){pointerDragging=true;downAt=position;}
            if(m.leftButton.isPressed&&pointerDragging)
            {
                var d=m.delta.ReadValue();desiredYaw+=d.x*.24f;desiredPitch=Mathf.Clamp(desiredPitch-d.y*.18f,15,82);
            }
            if(m.leftButton.wasReleasedThisFrame&&pointerDragging)
            {
                pointerDragging=false;
                if(Vector2.Distance(downAt,position)<6&&Physics.Raycast(WorldCamera.ScreenPointToRay(position),out var hit,180))
                {
                    var pick=hit.collider.GetComponent<SpacePickTarget>();if(pick!=null){SelectNode(pick.Id);if(m.clickCount.ReadValue()>=2)FocusNode(pick.Id);}
                }
            }
            if(!inside||overUI)return;
            if(m.rightButton.isPressed||m.middleButton.isPressed)
            {
                var d=m.delta.ReadValue();var right=WorldCamera.transform.right;var up=WorldCamera.transform.up;
                desiredFocus-=(right*d.x+up*d.y)*desiredDistance*.0011f;
            }
            float scroll=m.scroll.ReadValue().y;if(Mathf.Abs(scroll)>.01f)desiredDistance=Mathf.Clamp(desiredDistance*Mathf.Exp(-scroll*.001f),9,75);
        }

        static Vector3 Arc(Vector3 a,Vector3 b,float t,float height)=>Vector3.Lerp(a,b,t)+Vector3.up*(Mathf.Sin(t*Mathf.PI)*height);
        static void Curve(LineRenderer line,Vector3 a,Vector3 b,float height)
        {
            line.positionCount=33;for(int i=0;i<33;i++)line.SetPosition(i,Arc(a,b,i/32f,height));
        }

        public void SetView(int view)
        {
            desiredYaw=-12;desiredPitch=50;
            desiredFocus=view==1?new Vector3(0,2.2f,0):view==2?new Vector3(12.5f,2,0):new Vector3(0,1.3f,.5f);
            desiredDistance=view==0?28:19;
            if(expanded){desiredFocus+=Vector3.up*1.3f;desiredDistance+=3;}
        }
        public void FocusNode(string id)
        {
            SelectNode(id);desiredFocus=nodes[id].Root.position;desiredDistance=13;desiredPitch=nodes[id].Persistent?62:35;
        }
        public void ToggleLayers(){expanded=!expanded;SetView(0);Refresh();}
        public void SelectNode(string id){if(!nodes.ContainsKey(id))return;selected=id;RefreshInspector();}
        public void ChooseExperiment(int choice){Simulation.Reset((Experiment)choice);elapsed=0;seenNodes=-1;Refresh();}
        public void ResetExperiment(){Simulation.Reset(Simulation.Experiment);elapsed=0;seenNodes=-1;Refresh();}
        public void TogglePlay()
        {
            if(Simulation.Terminal){if(!Simulation.StartNextRun())return;seenNodes=-1;}
            Simulation.Playing=!Simulation.Playing;if(Simulation.Playing&&Simulation.Index<0)Advance();Refresh();
        }
        public void Advance()
        {
            if(Simulation.Terminal){if(!Simulation.StartNextRun())return;seenNodes=-1;}
            Simulation.Advance();elapsed=0;
            if(Simulation.Current!=null&&nodes.ContainsKey(Simulation.Current.To))
            {
                selected=Simulation.Current.To;if(cameraFollow)FocusNode(selected);
            }
            Refresh();
        }

        void RefreshInspector()
        {
            if(title==null)return;var n=LabContent.Nodes[selected];
            title.text=n.Title;title.enableAutoSizing=true;title.fontSizeMin=20;title.fontSizeMax=25;
            owner.text=n.Owner;body.text=n.Body;resource.text=n.Resources;rule.text=n.Rule;source.text=n.Source;
            owner.color=rule.color=nodes[selected].Color;
        }

        public void Refresh()
        {
            RefreshInspector();
            for(int i=0;i<scenarios.Count;i++)SetButton(scenarios[i],i==(int)Simulation.Experiment?lime:panel,i==(int)Simulation.Experiment?bg:ink);
            status.text=Simulation.Status.ToUpperInvariant();status.color=Simulation.Status=="cleanup-failed"||Simulation.Status=="interrupted"?red:lime;
            var current=Simulation.Current;
            stepTitle.text=current?.Title??"三座平台，三个进程。每个进程只有一个 Nya 根。";
            stepDetail.text=current?.Detail??"上层表达运行活动，下层表达持久事实。空间位置用于解释资源所有权，不新增 Context 或组件。";
            stepNumber.text=(Simulation.Index+1).ToString("00")+" / "+Simulation.Steps.Count.ToString("00");
            SetCaption(play,Simulation.Playing?"暂停":Simulation.Terminal?"再运行":"播放");
            play.interactable=Simulation.Status!="cleanup-failed"&&(!Simulation.Terminal||Simulation.Nodes.Count<4);
            next.interactable=play.interactable;cancel.interactable=Simulation.CanCancel;
            SetButton(explode,expanded?lime:panel,expanded?bg:ink);SetButton(followButton,cameraFollow?lime:panel,cameraFollow?bg:ink);
            modeHint.text=expanded?"分层视角  /  上：运行资源  ·  下：持久事实":"连线展示行为路径  /  边界柱框出进程，不表示子 Context";
            counters.text=$"模型占用 {(Simulation.ModelActive?1:0)}    ·    工具占用 {(Simulation.ToolActive?1:0)}    ·    scope {(Simulation.ScopeActive?1:0)}    |    工具实际执行 {Simulation.ExecuteCount} 次    |    成功节点 {Simulation.Nodes.Count}    |    owner epoch {Simulation.OwnerEpoch}    |    {(Simulation.ProcessAlive?"执行端在线":"执行端异常退出，worker 独立存活")}";
            historyCaption.text=$"Session 对话树  /  下一轮父节点：{(Simulation.SelectedParent==0?"根 null":"N"+Simulation.SelectedParent)}";
            for(int i=0;i<historyButtons.Count;i++)
            {
                var b=historyButtons[i];b.gameObject.SetActive(i==0||Simulation.Nodes.Any(n=>n.Id==i));b.interactable=!Simulation.Running;
                SetButton(b,Simulation.SelectedParent==i?lime:panel,Simulation.SelectedParent==i?bg:ink);
                if(i>0){var h=Simulation.Nodes.FirstOrDefault(n=>n.Id==i);SetCaption(b,h==null?"N"+i:"N"+i+" ← "+(h.Parent==0?"根":h.Parent.ToString()));}
            }
            protocolText.text=LabSimulation.Protocols[Simulation.ProtocolIndex];protocolButton.interactable=!Simulation.Running;
            toolsButton.interactable=!Simulation.Running;SetCaption(toolsButton,Simulation.UsesTools?"工具：开启":"纯文本路径");
            SetCaption(catalogButton,Simulation.CatalogOnline?"目录：在线":"目录：离线");SetCaption(observationButton,Simulation.ViewOpen?"关闭界面观察":"恢复界面观察");
            for(int i=0;i<stepTicks.Count;i++)
            {
                stepTicks[i].gameObject.SetActive(i<Simulation.Steps.Count);stepTicks[i].GetComponent<UnityEngine.UI.Image>().color=i<=Simulation.Index?lime:edge;
                stepTicks[i].sizeDelta=new Vector2(975f/Simulation.Steps.Count-6,3);stepTicks[i].anchoredPosition=new Vector2(207+i*975f/Simulation.Steps.Count,-949);
            }
            foreach(var pair in nodes)
            {
                var n=pair.Value;var id=pair.Key;
                bool offline=(!Simulation.ProcessAlive&&LabContent.Nodes[id].Group==1&&!n.Persistent)||(id=="workspace"&&!Simulation.ViewOpen);
                bool busy=id=="models"&&Simulation.ModelActive||id=="worker"&&Simulation.ScopeActive||id=="runtime"&&Simulation.Running&&Simulation.ProcessAlive;
                n.Surface.SetColor("_BaseColor",WorldColor(offline?C("202B34"):Color.Lerp(C("263C4B"),n.Color,busy?.40f:.18f)));
                n.Accent.SetColor("_BaseColor",offline?C("40505C"):n.Color);
                if(n.Orbit!=null)n.Orbit.sharedMaterial.SetColor("_BaseColor",offline?C("40505C"):n.Color);
                n.LabelAccent.color=offline?muted:n.Color;
                n.State.text=id=="runtime"?(Simulation.ProcessAlive?"owner epoch "+Simulation.OwnerEpoch:"进程已退出"):
                    id=="session"?"成功节点 "+Simulation.Nodes.Count+" · 持久记录":
                    id=="worker"?(Simulation.ScopeActive?"scope 存活 · 等待退出":"服务就绪 · 无 Run 占用"):
                    id=="ledger"?"实际执行 "+Simulation.ExecuteCount+" 次":
                    id=="models"?(Simulation.ModelActive?"原生交换中":LabSimulation.Protocols[Simulation.ProtocolIndex]):
                    id=="workspace"?(Simulation.ViewOpen?"观察连接中":"观察已关闭"):
                    id=="api"?"外部服务 · 无本地根":n.Persistent?"持久事实 / 资源":offline?"进程已退出":"根上组件 / 服务";
            }
            guideText.text=Simulation.Terminal?(Simulation.Status=="completed"?"资源已退出，Session 才创建成功节点。选择父节点，再运行可探索分支。":"没有新成功节点。可重置实验，比较资源是否真正退出。"):"空格 播放 / 暂停    → 单步    E 分层    R 重置    1 / 2 / 3 切换镜头";
            if(seenNodes!=Simulation.Nodes.Count)RebuildHistory();
        }

        void RebuildHistory()
        {
            seenNodes=Simulation.Nodes.Count;
            foreach(var go in historyObjects)Destroy(go);historyObjects.Clear();
            foreach(var line in historyLines)Destroy(line.gameObject);historyLines.Clear();
            var positions=new Dictionary<int,Vector3>{{0,new Vector3(0,.6f,-5.1f)}};
            foreach(var node in Simulation.Nodes)
            {
                var position=new Vector3(-2.5f+(node.Id-1)*1.65f,.65f,-6.9f);positions[node.Id]=position;
                var crystal=Solid("Successful node N"+node.Id,PrimitiveType.Cube,world,position,Vector3.one*.43f,nodes["session"].Accent);
                crystal.rotation=Quaternion.Euler(35,30,25);historyObjects.Add(crystal.gameObject);
                historyLines.Add(Line("Immutable parent N"+node.Id,world,lime,.036f,positions[node.Parent],position));
            }
        }

        RectTransform Rect(Transform parent,string name,float x,float y,float w,float h)
        {
            var r=new GameObject(name,typeof(RectTransform)).GetComponent<RectTransform>();r.SetParent(parent,false);r.anchorMin=r.anchorMax=r.pivot=new Vector2(0,1);r.anchoredPosition=new Vector2(x,-y);r.sizeDelta=new Vector2(w,h);return r;
        }
        UnityEngine.UI.Image Box(Transform parent,string name,float x,float y,float w,float h,Color color,bool raycast)
        {
            var r=Rect(parent,name,x,y,w,h);var image=r.gameObject.AddComponent<UnityEngine.UI.Image>();image.color=color;image.raycastTarget=raycast;return image;
        }
        TMP_Text Text(Transform parent,string content,float x,float y,float w,float h,float size,Color color,bool bold=false,TextAlignmentOptions align=TextAlignmentOptions.TopLeft)
        {
            var r=Rect(parent,"Text",x,y,w,h);var text=r.gameObject.AddComponent<TextMeshProUGUI>();text.font=Font;text.text=content;text.fontSize=size;text.color=color;text.fontStyle=bold?FontStyles.Bold:FontStyles.Normal;text.alignment=align;text.textWrappingMode=TextWrappingModes.Normal;text.overflowMode=TextOverflowModes.Ellipsis;text.raycastTarget=false;return text;
        }
        UnityEngine.UI.Button Button(Transform parent,string name,float x,float y,float w,float h,string caption,Action action,float size)
        {
            var image=Box(parent,name,x,y,w,h,panel,true);var button=image.gameObject.AddComponent<UnityEngine.UI.Button>();button.targetGraphic=image;
            var colors=button.colors;colors.normalColor=Color.white;colors.highlightedColor=new Color(1.2f,1.2f,1.2f);colors.pressedColor=new Color(.7f,.8f,.8f);colors.disabledColor=new Color(.5f,.5f,.5f,.55f);button.colors=colors;
            Text(image.transform,caption,4,0,w-8,h,size,ink,false,TextAlignmentOptions.Center);button.onClick.AddListener(()=>action());return button;
        }
        void SetButton(UnityEngine.UI.Button button,Color fill,Color color){button.GetComponent<UnityEngine.UI.Image>().color=fill;button.GetComponentInChildren<TMP_Text>().color=color;}
        void SetCaption(UnityEngine.UI.Button button,string value){button.GetComponentInChildren<TMP_Text>().text=value;}
    }

    public sealed class SpacePickTarget : MonoBehaviour { public string Id; }
    public sealed class SpaceLabelPointer : MonoBehaviour,IPointerClickHandler
    {
        public string Id;
        public void OnPointerClick(PointerEventData eventData){if(eventData.clickCount>1&&ArchitectureSpace.Active!=null)ArchitectureSpace.Active.FocusNode(Id);}
    }
}
