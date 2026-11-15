# Agent Note: 刷新 Chrome 使用的 Harness 开发实例

Status: implemented

## 问题

用户要求将 Composer 单击选模、双击设默认的改动应用到 Chrome 使用的当前本机 Anybox Harness。旧开发进程未注册新 `model-picker.js`，该路径返回 404，只有刷新页面不足以生效。

## 决策

沿用原开发入口、工作目录、数据路径及端口，先通过现有 Products guard 安全停止已打开的应用，确认真实清理完成后正常退出旧开发父进程及两个角色，再用此前全仓检查通过的最新构建启动，并恢复原有应用目标，在 Chrome 核对真实页面。当前工作区的 serve 入口按现行组合使用一个进程和一个 Nya 根。当前运行的是工作区静态开发组合，不覆盖或安装不可变应用包。

## 备选方案

仅刷新 Chrome 无法重建旧进程内存中的资源目录。直接终止进程不能代替应用退出保护，因此先走受控 stop；若 busy 或退出未知，保留原状态并等待，不强杀或默认取消业务。

## 影响与代价

重启期间本机 Web 短暂不可用；临时停止后恢复原有客户端和执行端应用目标，沿用数据、连接、凭据及独立 Computer worker。退出前可控浏览器没有已挂载的 Anybox 页面；打开后确认目标地址及新资源加载，不修改模型默认值。

## 验证

确认旧客户端监听 127.0.0.1:3000、本机执行端监听 127.0.0.1:3001，父进程从本仓库启动且没有 ANYBOX_* 环境覆盖，使用 data/ 默认路径。执行端的 Harness/Claude Agent 与客户端的 Harness/Personal Agent 均通过 guard 返回 disabled 后，向原父进程提交 SIGTERM，确认父进程及两个角色实际退出，没有使用强杀。

新 serve 进程在原端口就绪，固定 instanceId 及原连接 ID/revision 均保持一致。只观察原 open 请求直至成功，最终核对客户端 Harness、Personal Agent 为 running、Claude Agent 为 disabled，执行端 Harness、Claude Agent 为 running，与原目标一致；独立 worker 原进程保持运行。新 model-picker.js 路径由 404 变为 200，内容包含双击事件处理。复用此前功能改动的全仓验证结果，本轮没有改动实现代码；`git diff --check` 与记录链接检查通过。

Chrome 实际打开原空会话，显示“准备就绪”，Composer 使用新模型列表，已观察到“单击选择，双击设为默认”提示及原默认标记，保留页面供用户试用。仅展开列表读取状态，没有切换模型、保存默认或发送 Run。首次自动导航被现有 Origin 保护拒绝，改为 Chrome 地址栏正常访问后成功，没有修改安全设置。未进行真实模型调用或其他平台验证。

## 关联

- [Composer 默认模型改动](../../implemented/feature/2026-11-15-composer-default-model.md)
- [运行角色与发行](../../../../docs/runtime-roles-and-distribution.md)
- [产品生命周期](../../../../packages/host/src/applications/component.ts)
