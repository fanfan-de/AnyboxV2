# Agent Note: Composer 上下文用量环

Status: implemented

## 问题

用户希望在 Anybox Harness 的 Composer 中通过类似参考截图的小环监控上下文用量。当前原生响应保留 token 统计，但浏览器安全投影不包含用量，执行配置摘要也未提供固定模型定义的上下文上限。

## 决策

在模型选择旁增加可悬停、键盘聚焦及点击查看详情的上下文用量环。依据当前分支最新请求返回的输入与输出统计估算占用，展示数字、比例与统计范围；未报告的用量和上下文上限保持未知。达到 75% / 90% 分别使用琥珀色 / 红色。运行中优先跟随或关注本面板位置的运行；未明确选择的同父并发、切换模型及最新请求无统计时不复用其他运行或旧请求的数字。

四协议投影提取白名单安全非负整数，Anthropic 输入合计缓存读取和创建，其他协议不重复加缓存子集；既有实时流和终态记录均携带可选 usage。模型摘要和新执行快照携带配置固定定义版本的限制，旧快照仅借用准确同版本的公开限制。不增加轮询、业务组件或独立持久状态。弹层进入原生 top layer，按面板及视口限宽和定位；隐藏应用、切换轨迹和销毁时关闭并撤销监听。

## 备选方案

不使用会话累计计费 tokens 作为上下文占用，因为多次请求会重复计算已有历史。未采用按字符数猜测 tokenizer 或硬编码模型窗口；这些做法无法可靠覆盖原生推理、缓存、图片和工具协议。

## 影响与代价

新增只读展示与可选投影元数据；不改变发送、模型参数、压缩、Run 执行、取消或数据归属。旧记录没有用量或限制时保持可读。已有工作区中 RunRuntime 等未提交变更属于其他目标，本轮不修改。

## 验证

- `npm run build --workspace packages/models`、`npm run build --workspace packages/app-harness` 和 `npm run build --workspace packages/distribution` 通过；`node scripts/verify-web-assets.mjs` 与 `git diff --check` 通过。
- Models 全部 389 项测试通过，含新增固定定义版本、来源刷新、历史缺失和旧 schema 3 恢复兼容测试。
- `node --test tests/context-usage.test.mjs tests/context-usage-projection.test.mjs tests/session-view.test.mjs tests/native-projection.test.mjs tests/protocol-view-client.test.mjs tests/model-selection-client.test.mjs tests/session-client.test.mjs`：167 项全部通过，无失败或跳过。覆盖四协议、缓存、实时累积计数、缺省/非法输入、旧视图兼容、分支/并发/切模、弹层 hover/聚焦/点击/Escape/清理以及原有提交行为。
- Chrome 使用 `/tmp` 内存样本加载真实编译模块及原样 CSS，验证常规宽度、320px 与四分屏。窄屏弹层宽 270px，位于对应面板横向边界内，实际 `:popover-open` 为 true；四面板独立显示各分支统计。
- 本机运行服务经 Products 停止 guard 接受后正常退出原 launcher 与两个角色，加载新代码并恢复原启停目标；Computer worker 保持原进程。恢复 Harness 时原打开请求因本机 Models 大文件初始化超过客户端等待上限，仅查询观察它最终 running，未重放原未知请求。
- 真实 Web 已打开现有成功分支，详情显示约 5%，51,182 / 1,048,576 tokens（输入 46,742、输出 4,440）；读取的是旧耐久原生记录与准确模型定义，没有为验收发起新的计费调用。原生自动化导航首次触发服务的 forbidden-origin，使用浏览器正常刷新后成功，未改动 Origin/CSP 防护。

未运行全仓检查、桌面或跨平台验收；实时网络行为使用本地协议事件样本验证，未调用真实模型。历史读取尚未完成时可能短暂显示未报告，读取完成后更新。

## 关联

- [Composer 布局方向](../simplification/2026-11-11-composer-controls.md)。
- [会话视图](../../../../packages/app-harness/src/web/session-view.ts)、[安全投影](../../../../packages/app-harness/src/core/view/types.ts)、[模型组件](../../../../packages/models/src/component.ts)。
- [Web 客户端设计](../../../../docs/web-client-design.md)、[Web 前端](../../../../docs/modules/web/web-frontend.md)。
