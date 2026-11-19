# Agent Note: Personal Agent 的身份与手工管理

Status: implemented

## 问题

Personal Agent 0.2 的 Agent 来自启动配置。用户需要创建和编辑具备稳定身份的 Agent，并在现有工作区选用它。

## 决策

在 Personal Agent 执行库保存 Agent 目录。名称、简介、行为指令与默认模型可编辑，已有 Agent 沿用稳定 ID。通过客户端所选设备管理目录，接入当前工作区的 Agent 选择和新会话执行。创建通过请求 ID 幂等，编辑通过修订号检查并发写入。消息入口及 Agent 间通信属于后续变更。

## 备选方案

继续使用启动配置可以保留现有执行方式，但修改必须改动部署配置并重启。持久目录使用户可在当前连接上直接管理，身份可以跨页面和进程重启继续使用。

## 影响与代价

目录归执行实例。Agent 的默认模型来自该实例已有 Models 配置。启动 Agent 首次入库时接续有效默认模型和已发布指令。Agent 表单保存自有指令文本，已发布 Prompt 仍可绑定到同一目录。已有项目会话继续使用已保存的协议和原生初始化，新的会话使用本次选择的 Agent 配置。新建 Agent 由受信装配提供空工具环境。

## 验证

Linux 上根 `npm run check` 通过，2390 项中 2368 通过、22 跳过、0 失败。Personal Agent 包 5 项定向测试通过，覆盖客户端网关、创建请求重试、修订冲突、执行端重启后查回，以及新旧会话实际发送给受控模型的不同配置。Linux Chromium 验证了新建、改名、刷新后保留同一 ID 与表单内容，以及从会话设置选择该 Agent 并实际创建项目会话。浏览器验收使用独立本机数据，模型请求验收使用受控模型。Electron 和真实付费模型未验收。

## 关联

- [Personal Agent 的 0.2 基线](../../implemented/architecture/2026-11-19-personal-agent-harness-baseline.md)
- [Agent 目录组件手册](../../../../docs/modules/personal-agent/agent-directory.md)
- [头像导航与工作目录](../simplification/2026-11-19-personal-agent-avatar-navigation.md) 接续目录的工作区选择入口。
