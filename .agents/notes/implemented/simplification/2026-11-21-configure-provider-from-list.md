# Agent Note: 从 Provider 列表直接配置

Status: implemented

## 问题

完整 Provider 目录已经在左栏展示。独立的添加入口让用户在另一个界面再次选择同一提供方。用户明确要求未配置项直接进入配置，已配置项直接进入模型。

## 决策

左栏 Provider 列表是统一入口。未保存或待补 Key 的项直接在右栏打开 API 表单，左栏保留提供方列表。保存并满足认证要求后将该项移入已配置组，滑动显示模型。已配置项点击后直接滑动到模型列表。

表单使用所选 Provider 的目录方案预填协议与地址，有多个方案时可切换。返回或取消恢复 Provider 列表焦点与滚动位置，保留按提供方和方案隔离的非秘密草稿，清空未提交的 Key。

## 备选方案

未配置项先展示公开模型再提供“配置 API”，仍需要第二次点击。保留独立添加目录也会重复提供方选择。

## 影响与代价

两款应用复用现有持久配置、Key 写入和请求流程。移除独立添加页面、专属预览状态和相关测试。左栏提供目录刷新，已有设置的版本查看与移除可在适用的 API 表单使用。

## 验证

- 两款应用通过 TypeScript 编译及浏览器静态资源检查。`node --test --test-concurrency=2 tests/models-client.test.mjs tests/models-directory-web.test.mjs` 23 项全部通过。
- macOS Chrome 使用临时 Web 宿主实测两款应用。未配置与待补 Key 时显示右侧表单，选中前后没有触发该提供方的模型清单请求。验证方案预填、独立草稿与 Key 清理、取消的焦点和滚动恢复、保存后置顶与滑动、已有设置入口，以及 320px 和 400px 的布局。
- 目录刷新提交一次请求并保留当前表单与草稿。待补 Key 的提供方仍可打开移除确认，取消后没有提交删除请求。

## 关联

- [在 Provider 栏内滑动切换模型列表](2026-11-21-slide-model-list-in-provider-column.md)
- [模型管理直接展示完整 Provider 目录](2026-11-21-show-provider-directory-in-model-management.md)
- [Web 客户端设计](../../../../docs/web-client-design.md)
