# Agent Note: Personal Agent 的对话列表布局

Status: implemented

## 问题

用户提供 Grok Bot 截图作为界面参考。当前 72 像素头像栏隐藏 Agent 名称，界面更接近工具工作区，缺少可直接浏览的对话列表。

## 决策

采用约 300 像素浅灰侧栏：顶部搜索与新建入口、主 Agent 大头像、其他 Agent 的头像和名称摘要列表，底部保留设置与连接。右侧使用简洁的居中标题、浅灰消息气泡和常驻底部的圆角输入框。搜索只过滤当前设备目录；新建复用既有 Agent 管理表单。文件面板初始关闭，可显式展开；窄屏继续使用有焦点约束的抽屉。

## 备选方案

只调整配色与圆角无法解决头像栏缺少名称的问题，因此同时调整列表结构与宽度。没有复制参考图中的语音、分享和应用连接按钮，这些功能当前没有对应实现。

## 影响与代价

仅调整 Personal Agent 的浏览器界面，沿用设备和 Agent 身份、连续历史、草稿及退出保护。列表摘要使用已加载对话的最近消息，未加载时显示 Agent 简介；不为列表打开未访问 Agent 的工作目录或运行模型。已有侧栏显隐偏好继续生效。

## 验证

- `npm run build --workspace packages/app-personal-agent` 通过，包含 TypeScript 编译、Worker 身份与浏览器依赖构建。
- `node --test packages/app-personal-agent/tests/*.test.mjs` 共 11 项通过，覆盖原请求观察、旧目录草稿恢复、连续历史、HTTP 接口及独立浏览器资源闭包。`node scripts/verify-web-assets.mjs` 和 `git diff --check` 通过。
- macOS 浏览器在约 391、620、940、1440 与 1707 CSS 像素宽度检查布局，无页面横向溢出。窄屏列表为抽屉，选择后关闭；文件面板可在桌面停靠、窄屏以抽屉展开。两个 Agent 的独立草稿切换后恢复，刷新保留所选身份。验证了按简介筛选、无结果提示、Escape 清空，以及从已有编辑状态通过加号进入空白新建表单。
- 使用独立临时数据、内存凭据和受控模型的本机实例检查多 Agent 列表及真实完成 Run 的列表、引用和代码块显示。没有在用户数据中创建测试 Agent、提交消息或调用付费模型。Electron 和真实模型执行未单独验收；没有运行全仓测试。

## 关联

- [头像导航与工作目录](../../implemented/simplification/2026-11-19-personal-agent-avatar-navigation.md)
- [Agent 目录手册](../../../../docs/modules/personal-agent/agent-directory.md)
