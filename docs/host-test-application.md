# Anybox Test

Anybox Test 是用于手动验证 Anybox 宿主与应用契约的最小纯界面应用，稳定 ID 为 `host-test`。源码和可直接安装的目录都是 [`tests/fixtures/host-test-app/`](../tests/fixtures/host-test-app/)，不加入正式 distribution 目录。它仅包含原生 JavaScript、CSS、应用清单和资源索引，不依赖后台、HTTP、SQL、模型、凭据或 Nya 组件。

## 安装到当前宿主

在仓库根目录运行以下命令；宿主需已在指定的回环地址运行。该示例清单目标为 macOS arm64，其他设备先将 `manifest.json` 的 `target` 改为实际平台与架构。

```sh
node packages/host/dist/main.js install ./tests/fixtures/host-test-app \
  --endpoint http://127.0.0.1:3000 --trust-local --request-id host-test-install-0.1.0
node packages/host/dist/main.js apply --endpoint http://127.0.0.1:3000 \
  --request-id host-test-apply-0.1.0 --app host-test
```

首次使用源码 CLI 前运行 `npm run build`。界面安装也可在“我的应用 → 选择文件夹”中选择 `tests/fixtures/host-test-app`，明确授信本地目录后安装，再应用更改。生效完成后手动打开 **Anybox Test**。

安装复制不可变快照，后续修改源码不会改变已安装版本。迭代时提升清单版本，更新界面版本及 `payload/assets.json` 的版本 URL，并使用新的请求 ID；同一版本的不同内容不能覆盖原安装。若原请求结果未知，查询原操作，不重复提交副作用。生效被其他应用的工作或页面草稿阻止时，先正常完成工作或保存草稿，再核对原操作：只有 `recovery-required` 批次使用显式恢复；尚未创建或已取消的批次使用新请求 ID 重新发起，不能跳过宿主保护。完整流程见[本地安装](modules/package-management/installation.md)及[版本生效](modules/package-management/activation.md)。

## 手动测试

| 操作 | 预期结果 |
| --- | --- |
| 在“交互测试”中加一，切到其他应用后再回来 | 计数与输入保持；不重复挂载 |
| 编辑测试草稿，尝试左侧“关闭界面” | 宿主阻止关闭，提示未保存；保存或放弃修改后允许关闭 |
| 保存草稿，关闭界面后重新打开 | 草稿从当前浏览器载入；计数归零，挂载实例变化 |
| 启动 5 秒任务，尝试关闭界面 | 运行中阻止关闭；任务完成或显式取消后允许关闭 |
| 使用“交互测试 / 生命周期”页签及键盘左右键、Home/End | 仅更新本应用局部路由，宿主 URL 保留应用 ID |
| 查看生命周期，再切到其他应用后返回 | 显示激活原因与停用/激活事件；活动计时在隐藏期间暂停 |
| 干净关闭后重开，或从管理界面卸载 | 原挂载的计时器、任务、路由订阅和 DOM 监听器已清理；重装默认关闭 |

“可以关闭”只表示此页面的同步 `canClose()` 允许退出；其他应用、其他页面及宿主角色仍可阻止整个宿主生效或退出。模拟任务只在浏览器执行，不产生真实 Run、进程或外部副作用。主动 `dispose()` 或宿主取消挂载会终止并等待其计时资源清理。

草稿保存于当前 origin 的浏览器 `localStorage` 键 `anybox.host-test.draft.v1`，不会发送到宿主服务或其他应用。存储不可用时保留未保存状态并显示失败；放弃修改恢复到本挂载最后保存的内容。卸载保留浏览器数据。计数、任务、活动计时和最近 16 条生命周期事件只属于当前挂载，事件不记录草稿内容。

## 自动验证

```sh
npm run build
node --test tests/host-test-app.test.mjs
npm run check
```

行为测试通过正式目录读取、校验与纯界面准备链，检查资源闭包、草稿保护与保存失败、任务取消及完成、路由切换，以及幂等清理后不再响应事件。页面实现只消费公共 `mount / setActive / canClose / dispose` 契约，无需新增宿主特例。
