# Agent Note: Personal Agent 头像以 Shader 源码为编辑入口

Status: implemented

## 问题

示例卡片按源码匹配显示选中状态，源码编辑器折叠在下方，容易让用户误以为头像由示例选项决定。每个 Agent 的头像由该 Agent 保存的 GLSL 源码定义，用户需要直接粘贴自己的源码。

## 决策

在头像区顶部直接展示可粘贴的 Shader 编辑器，校验状态紧邻输入框。头像预览依据当前源码渲染。预览下方的四个示例按钮将源码载入编辑器，载入后的文本可继续编辑。清除操作直接清空源码。

## 备选方案

仅更改卡片标签会保留选中状态和折叠的源码入口，仍容易让用户把示例当作头像身份。

## 影响与代价

编辑和保存沿用 Agent 目录的 `logoShader` 字段、修订检查及 GLSL 校验。已有源码打开时直接可见，保存空源码会恢复名称首字头像。

## 验证

- `npm test --workspace @anybox/app-personal-agent` 构建成功，8 项测试通过，包括客户端网关的源码存取、保留、清除与连续历史集成测试。
- 头像编辑器通过独立 TypeScript 严格类型检查。并行头像导航变更补齐相关签名和导出后，`npm run typecheck --workspace @anybox/app-personal-agent`、头像网关专项复测及包内 8 项测试均通过。`git diff --check` 通过。
- Chromium 使用当前模板、样式和编辑器及临时 Agent API，实际通过剪贴板快捷键粘贴了自定义 GLSL，验证 WebGL 2 预览、源码原样提交和重新读取、四个示例载入、清除后提交 `null` 及名称首字回退。检查了桌面和 400 px 视口的布局。并行导航变更后的完整宿主浏览器流程未复测。

## 关联

- [头像功能接入记录](../feature/2026-11-19-personal-agent-shader-logos.md)
- [Agent 目录和头像说明](../../../../docs/modules/personal-agent/agent-directory.md)
