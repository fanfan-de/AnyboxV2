# Models 公共目录与原生协议验收

日期：2026-09-28。范围为独立 Models 模块、现有 Web 设置、Anthropic Messages 和 Gemini Interactions 文本/函数工具契约。

## 自动验证

最终根检查通过：386 项测试中 384 项通过、0 项失败，2 项真实系统凭据测试按既有门控跳过。

根 `npm run check` 执行 TypeScript strict 检查、完整构建、模块与 Harness/Web 行为测试。目录测试覆盖纯归一化、来源覆盖、未知能力和可选价格、离线快照、缓存恢复/内存回退、独占与文件别名、304/24 小时过期/一小时退避、busy、取消、超时、Nya 依赖替换，以及 result 已到但 done 未退出时不发布。

原生协议测试覆盖 JSON/SSE、分片、多工具与多轮续轮、签名/原生 ID 私有化、截断抑制工具、终态与坏响应、参数校验、分页发现和 usage。配置测试验证可空 catalogRef、CAS 冲突、多账号、旧记录/历史不重写与目录移除后继续执行。

Web 测试通过真实 Nya 和本地 HTTP，使用三套临时 SQLite、内存 Vault、mock fetch 和受控 reader。验证目录与连接建议、参考数据筛选、创建代理连接、保存模型与会话调用，并覆盖断连和关闭等待清理。已有 Responses、Chat Completions、DeepSeek、Run、Session 和工具回归包含在根检查中。

离线 npm pack 解包后可独立载入内置快照：225 个 Provider、8268 个模型；快照资产、provenance、摘要、MIT 全文和显式更新脚本均包含在分发包中。

## 实际浏览器

运行 `npm run build`，再运行 `node tests/helpers/catalog-browser-host.mjs`，打开其输出的临时地址。该宿主使用真实应用组件，所有远端请求和凭据均为 mock；退出时通过 harness.close() 等待清理并删除临时数据库。

在 Codex 内置浏览器中完成：

1. 选择 Anthropic 目录提供方，查看 Messages 连接方案，填写独立本地连接。
2. 修改为测试代理地址并保存；读取只显示 Key 配置状态。
3. 选择 Claude QA，确认能力、USD/百万 token 价格、上下文限制，预填新模型的 4096 输出 token 参数。
4. 修改模型名称和地址草稿后刷新目录，确认草稿原样保留，再保存模型。
5. 创建会话，选择该模型，提交工具请求，完成原生流式文本 → Bash → 最终答案。
6. 重载页面，确认会话模型选择与完成答案保留。
7. 手动添加连接，将默认模板协议切换为 Gemini Interactions，确认模板转为自定义；保存后来源引用未关联，没有遗留 DeepSeek 引用。

目录连接方案的默认选择和设置内部滚动也通过浏览器核对。仅公开目录快照抓取使用真实 models.dev 数据；测试与浏览器未调用真实模型、系统 Keychain/Secret Service 或工作区数据库。

## 验收边界

本次执行支持文本、函数工具、流式输出和原生推理续轮。图片、音频、视频、embedding 等仅作为目录信息；有效图片输入仍为 false。真实 Provider 的付费调用、workspace Key 权限和系统凭据跨平台测试需在对应环境另行运行，默认两项平台凭据测试按现有门控跳过。
