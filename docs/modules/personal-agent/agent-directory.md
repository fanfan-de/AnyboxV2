# Agent 目录

[返回 Personal Agent 模块](README.md)

在 Personal Agent 工作区打开「设置」中的 Agent 管理，选择执行设备后可创建和编辑 Agent，也可点击左栏顶部的加号直接进入新建表单。名称和简介用于识别 Agent，行为指令由执行端提供给模型。默认模型引用该设备的 Models 配置，可以在 Agent 表单中设置，或在「设置 → 常规」修改所选 Agent 的同一设置。

左栏以浅灰对话列表展示当前设备上的 Agent：顶部固定主 Agent 的大头像与名称，其他 Agent 显示头像、名称及摘要。摘要优先使用本次页面已加载对话的最近消息，否则显示简介；刷新后重新读取当前对话，不为列表预先打开其他 Agent 的工作目录。点击列表打开对应连续对话。顶部搜索可按名称或简介筛选，按 Escape 清空并收起搜索。底部「设置与连接」管理设备和应用配置。

对话区使用居中头像标题和底部常驻输入框。文件侧栏初始关闭，通过标题旁的文件面板按钮展开；已有显隐偏好继续保留。在宽度小于 760 像素的应用容器中，Agent 列表改为抽屉，选择 Agent 后关闭，支持 Escape 和键盘焦点约束。

## 组件与数据

`personal-agent-directory` 通过 `createAgentDirectoryComponent` 提供 `personal-agent.agents`，依赖应用自己的 SQLite、Prompt 库及 Models 配置服务。启动配置中的 Agent 首次进入目录时沿用已有 ID、实际生效的默认模型和已发布指令绑定。新 Agent 的 ID 由执行端生成。改名、编辑指令、调整模型和头像都在同一个 ID 下提交修订。目录的列表投影包含 ID、名称、简介和已设置的 `logoShader`，所有者可通过明细接口读取行为指令和默认模型。

创建请求使用 `requestId` 查回原记录，编辑提交读取时的 `expectedRevision`。版本冲突要求重新读取后提交。Agent 设置、已有 Prompt 指令绑定和每 Agent 模型设置使用同一目录作为生效来源。在 Agent 表单修改指令会保存该 Agent 的文本指令，选择已发布 Prompt 会切换到该版本。配置默认模型后，下一次 Run 使用该设置。切换模型或指令后，连续会话的新 Run 按当前 API 和配置组包完整的应用历史，并继续使用原会话。已有 Run 保留原快照。新建 Agent 的可用工具环境由应用装配决定。 [连续历史与选模规则](history.md#组件所有权与接口)

## 手动维护 Shader 头像

在「设置 → Agent 管理」创建或编辑 Agent 时，直接在「Shader 源码（GLSL）」中粘贴或编写定义头像的源码。「Shader 示例」中的按钮会用对应示例替换编辑器内的源码，可以继续修改配色、密度和种子。圆形预览根据编辑器中的源码渲染，并提供对话头像尺寸的定格图。点击「播放动效」可预览 5 秒动画。保存 Agent 后，左栏和对话标题显示已保存源码的定格图。清除源码后保存，头像使用名称首字。浏览器无法渲染 WebGL 2 或编译失败时也显示名称首字。

源码须提供 `vec3 paint(vec2 uv, float t, float edge)`。`uv` 是归一化画布坐标，`t` 是预览时间（秒），`edge` 在接近圆边时由 0 过渡到 1。返回的 RGB 值将在圆形画布内渲染。例如：

```glsl
vec3 paint(vec2 uv, float t, float edge) {
    vec3 color = mix(vec3(0.12, 0.25, 0.42), vec3(0.55, 0.8, 0.92), uv.y);
    return color * (1.0 - 0.2 * edge) + vec3(0.04 * sin(t));
}
```

执行设备在 Agent 目录中按 UTF-8 原样保存最多 32 KiB 的 Shader 文本。修改头像沿用 Agent 修订与原有 ID，用户可继续在同一条历史交互。渲染和预览发生在浏览器，源码属于展示资料。素材和渲染器见[预设源码](../../../packages/app-personal-agent/src/web/agent-logo-presets.ts)和[圆形头像渲染](../../../packages/app-personal-agent/src/web/agent-logo.ts)。

## API 与生命周期

通过现有执行端 `/api/v1/apps/personal-agent` 和所选连接的客户端网关访问。执行端使用现有设备所有者身份认证，客户端转发时校验连接修订和执行实例身份。

| 方法与相对路径 | 行为 |
| --- | --- |
| `GET /agents` | 查询 Agent 摘要 |
| `GET /agents/:id` | 查询 Agent 明细及当前修订 |
| `POST /agents` | 提交 `name`、`description`、`instructions`、`modelId` 和 `requestId`，可附 `logoShader` |
| `POST /agents/:id` | 提交同一组配置和 `expectedRevision`。省略 `logoShader` 保留已保存的源码，`null` 清除 |

配置写入由执行端持有，组件退出时停止准入并等待本代写入。客户端在设备切换或页面销毁时结束相应观察，已提交的创建请求可用原请求 ID 查回。

源码和验证入口见 [Agent 目录组件](../../../packages/app-personal-agent/src/core/agent/directory-component.ts) 与 [客户端和执行端集成测试](../../../packages/app-personal-agent/tests/http.test.mjs)。
