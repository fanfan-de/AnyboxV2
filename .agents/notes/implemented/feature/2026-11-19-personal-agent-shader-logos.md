# Agent Note: Personal Agent 手动维护 Shader 头像

Status: implemented

## 问题

用户希望将既有圆形 Shader 头像原型接入 Personal Agent，并由人手动维护各 Agent 的 Logo 源码。

## 决策

沿用原型的黑洞、一朵花、可爱的猫和工作狂材质及 `paint` 接口，将原配色、密度和种子作为各素材源码的一部分。Agent 管理支持选素材、手动编辑、查看 24 px 定格缩略图、播放 5 秒动效和清除。Agent 选择器与当前对话标题显示同一份定格头像。

Agent 目录 SQLite v2 增加可空 `logo_shader`。现有权限、修订和创建幂等继续负责保存，源码按 UTF-8 原文大小限制 32 KiB。省略字段沿用原头像，显式 `null` 清除。浏览器只在修改头像时提交该字段。

## 备选方案

引用讨论曾提出 Agent 代生成、参数编辑器和图像上传。本轮选择以现有 GLSL 素材作为起点，由用户选择、修改和保存源码。

## 影响与代价

Shader 随 Agent 的展示资料存储，可沿同一 Agent ID 继续历史。浏览器共享 WebGL 2 渲染表面，实时绘制仅用于显式动效预览，现有页面退出机制清理观察和渲染。已有 Agent、清除头像或渲染不可用时使用名称首字。

## 验证

- Linux Node 24 的全仓 `npm run check` 通过，2,393 项中 2,371 项通过、22 项按既有条件跳过。兼容性收尾后重新构建 Personal Agent 并执行包内 8 项测试，全部通过。
- 临时执行库和真实客户端网关验证目录 v1 升级、旧请求 ID 重试、源码原样存取、修订冲突、大小上限、保留与清除，以及切换头像后沿用同一条连续历史。受控模型请求中未出现 Shader 源码。
- 通过源码比较确认四个原始 GLSL 主体均已迁入。Chrome 用 WebGL 2 验证四款素材的定格和实际动画帧变化、手写编辑、编译提示、保存及刷新、普通设置更新保留头像、清除和无 WebGL 2 的首字回退。视觉检查覆盖头像编辑区。`git diff --check` 通过。
- Electron 和其他平台的 WebGL 表现未专项验证。

## 关联

- [Agent 目录和头像说明](../../../../docs/modules/personal-agent/agent-directory.md)
- [Agent 目录实现记录](2026-11-19-personal-agent-directory.md)
- [头像以 Shader 源码为编辑入口](../bug-fix/2026-11-19-personal-agent-avatar-shader-source.md)将素材交互改为载入示例源码，移除了卡片选中状态。
