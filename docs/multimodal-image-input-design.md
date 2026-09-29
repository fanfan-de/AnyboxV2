# Harness 图片输入链路

状态：2026-09-29。Responses、Anthropic Messages、Gemini Interactions、Chat Completions 与 DeepSeek 非推理扩展支持本地静态 JPEG、PNG、WebP 输入。上传、粘贴、拖拽、工具续轮、编辑、重新生成和重启后沿成功父节点继续，共用同一资源事实。所有协议都要求模型配置明确声明图片能力；没有远程 URL、动画、PDF、音视频、图片输出或工具返回图片支持。

## 数据与资源所有权

`harness-image-assets` 是根上的独立 Nya 组件，只依赖业务存储。它独占图片目录、上传/解码队列、临时文件、读取句柄与 GC；业务 SQLite 的图片表使用独立迁移域，不增加连接。目录默认为 `${harnessDatabasePath}.images`，可通过 `ANYBOX_IMAGE_ASSETS_DIRECTORY` 指定。PID、hostname 和随机 token 的排他锁阻止多进程同时占有；只回收可确认已退出的本机进程锁。

图片以随机 assetId 命名，不跨上传去重。`sharp` 适配器识别真实格式、尺寸及动画状态，并实际解码验证；最终保存原始字节，SHA-256 校验完整性，不压缩或转码。状态为 staging → ready → deleting；只有 ready 可供提交。启动恢复未完成 staging/deleting，保留图片缺失或摘要错误会明确失败。

应用限制集中在 `src/harness/image/limits.ts`，前后端共用：单图 10 MiB、每轮最多 8 张且合计 20 MiB、宽高各不超过 4096；上传/校验并发为 2。Models 独立包另设实际 HTTP 请求 32 MiB 上限，包含祖先历史、其他消息和 base64 膨胀。超过限制明确拒绝，不丢图或自动缩小。

## 输入、接纳与回收

`RunInput` 保留 `input: string`，新增有序 `images?: { assetId: string }[]`；文字和图片至少一项非空。先查询已接受幂等键，再解析当前模型、模板与图片。内存和数据库幂等比较都包含图片 ID 及顺序。已接受请求重试不会重新检查草稿期限或执行模型。

新写入 `NativeRunInput` v2 保存原始文本、服务端确认的图片描述、模板快照和处理后文本；旧 v1 按无图片读取，历史 JSON 不改写。task-template 只处理本轮文本一次。各协议有图片时编码为文本块（非空时）加有序图片块，无图片时沿用原文本编码。

Run 准备阶段只查询图片元数据。Session 接受事务复核会话、父节点、协议和初始化，再调用图片组件的同步 `retainIn(tx, scopeId, ownerKey, refs)`；它只操作所属表，不启动事务或文件 I/O。保留凭证与 Run 同时提交/回滚。失败、取消及 interrupted 的已接受 Run 仍永久保留其图片。Node 的 images 从来源 Run 投影，没有重复附件事实。

草稿期限为 24 小时。GC 只选择无永久保留、已过期且无活动读取的资源；先在事务标记 deleting，再删文件。GC 先提交则接纳失败，Run 先提交则图片不可回收；删除失败留待重试。保留凭证没有自动撤销入口。

## 原生执行与历史兼容

Models 不查询 Session 或图片表。`openNative({ resources, requirements: { imageInput } })` 固定本次 execution 的受信读取端口，端口不进入快照或记录。`prepareExchange(intent, { resourceRefs })` 同步固定意图和描述；原生 v2 请求记录的顶层 resourceRefs 保存 ID、MIME、字节数和 SHA-256，payload 内只使用包内构造的资源 URI。各协议只解析明确的用户图片字段，不递归替换任意字符串。

执行顺序为：同步校验/生成引用记录 → Runtime 持久化意图 → start 同步登记操作 → 操作内读取完整请求图片 → 等实际读取退出并校验摘要 → 临时编码原生图片字段 → 检查完整请求体 → 请求模型 → 等图片及网络资源退出 → 提交候选上下文。读取失败不会发模型请求，base64 不进入数据库、事件、浏览器草稿或持久原生状态。

当前输入或所选成功父路径含图片时都要求有效图片能力，由配置声明与驱动实现共同决定。目录刷新不改已有配置；unknown/unsupported 需要用户显式修改。DeepSeek 保留原有禁用 thinking 策略和工具循环。

五种协议驱动均为 2.1.0、绑定 1.1.0，新 Run 全部写 record v2；展示版本仍为 v1。明确兼容旧驱动 2.0.0、绑定 1.0.0、record v1 文本历史，可混合 v1/v2 父链；v1 reader 不接受图片记录。只有完整父路径验证为无图片时，允许 imageInput 从 false 增为 true；其他能力、账户 epoch、连接、远端模型、模型定义版本与执行参数仍严格匹配。Session `run-state` v6 只增加通用引用列；旧 JSON 保持不变，dialogue-v1 继续只读。

协议编码固定如下：Responses 用户 `input_image.image_url` 为内部 URI，发送时改为 data URL；Anthropic 用户 `image.source` 保存 `{ type: 'url', url: 内部URI }`，发送时改为 base64 source；Gemini `user_input.content` 保存 `image.uri`，发送时改为 `image.data/mime_type`。三者与 Chat 共用 `protocols/images.ts` 的受管读取、体积校验和退出屏障；不递归解释工具参数或任意字符串。

每个 execution 的读取端口只允许当前输入及选定成功父链中的图片，作用域固定到 Session。同父并发、编辑和重新生成各自建立 execution，不包含兄弟路径。图片、Session、Models 都遵守 cancel 请求停止、done 等待实际退出的契约；清理失败不能创建成功节点。

## HTTP 与浏览器

以下路径沿用 Host/Origin 检查：

| 路径 | 契约 |
| --- | --- |
| `POST /api/v1/sessions/:sid/images` | 单图二进制上传，返回服务端描述 |
| `GET /api/v1/sessions/:sid/images/:assetId/content` | 验证会话归属，返回真实 MIME 与原图，不公开路径 |
| `POST /api/v1/sessions/:sid/images/renew` | 批量续期未接受草稿，返回有效/失效引用 |
| `POST /api/v1/sessions/:sid/runs` | 小型 JSON 新增 images，保持 64 KiB 上限 |

选择文件、粘贴和拖拽共用上传队列，添加时固定位置，完成乱序不改变图片顺序。有上传中、失败或过期项时禁止发送，保留文本及占位。预览只使用上传成功后的同源 URL，CSP 不需要 data/blob 图片地址。

草稿按 Session/父节点保存文本与小型引用，pending v2 也不保存 File、字节或 base64；旧 pending v1 作为无图片读取。工作区每 5 分钟及恢复可见时统一扫描所有分支与隐藏/关闭面板草稿和 pending，分批续期。提交前先恢复 pending 幂等状态，再检查新提交图片；响应丢失先查键，避免重复 Run。编辑和重新生成保留原图片引用。

未接受的 pending 如果因模型能力或协议变化无法发送，会回到原父节点草稿并解除待提交锁定。遇到已有草稿时保留双方内容并提示检查；即使合并后超限，刷新也保留内容，发送前要求删减。

## 验证与升级

普通 `npm run check` 不访问真实模型，使用临时数据库、内存凭据和模拟 HTTP。主要验收入口：

| 范围 | 测试 |
| --- | --- |
| 图片格式/原字节/取消/排他/恢复/GC/保留 | `tests/image-assets.test.mjs` |
| 资源端口/摘要/能力/版本/32 MiB/退出/JSON 与 SSE | `packages/models/tests/native-images.test.mjs`、`packages/models/tests/multimodal-protocols.test.mjs` |
| 五种协议工具续轮、纯图片、重启、混合版本、分支、幂等与损坏 | `tests/native-protocol-agents.test.mjs` |
| Session 包装器与组件关闭 | `tests/session.test.mjs` |
| HTTP/顺序/草稿/pending/模型能力 | `tests/{image-client,session-client,web-server,protocol-web-modules,web-startup-config}.test.mjs` |
| 显式真实 API 图片识别与重启 | `tests/native-live-api.test.mjs` |

真实图片测试沿用 `ANYBOX_NATIVE_API_TESTS=1` 和显式协议/地址/模型/Key/原生参数，另外设置 `ANYBOX_NATIVE_API_IMAGES=1`，对选中的任一已实现协议运行。详见[原生协议验证入口](./native-protocol-agent-framework-design.md#11-独立联网验证入口)。普通检查跳过这些测试；模拟成功不能当作某个远端模型已通过图片识别验收。

升级前关闭宿主并等待退出，同时备份业务数据库和图片目录；配置数据库继续使用 v3。回退代码需恢复升级前数据库备份。实现与测试不操作用户实际业务数据。

组件细节见[图片资源](./modules/images/image-assets.md)、[Session](./modules/sessions/session.md)、[协议注册表](./modules/execution/protocol-agent-registry.md)、[Models](./modules/models/models.md)和[Web](./modules/web/web-frontend.md)。

### 首期 Chat/DeepSeek 验收记录（历史）

- 根 `npm run check` 通过：TypeScript strict 检查、构建与 525 项测试；516 项通过、0 失败、9 项门控跳过（7 项真实 API、2 项平台凭据）。
- Models 图片资源测试覆盖读取退出、摘要/体积、驱动撤销与混合版本恢复；宿主集成覆盖 Chat/DeepSeek 图片工具续轮、重启、同父并发及引用隔离。
- 原生 Chrome 使用临时数据库、内存凭据和模拟模型，验证上传、同源预览、纯图片成功运行、编辑恢复原图、刷新保留草稿和重新生成。新分支保留相同 assetId；测试宿主及新建标签页已关闭。
- `git diff --check` 通过。未启用真实 API 或平台凭据门控，未修改 NyaCore 或用户实际业务数据库。

### 多协议扩展验收

- 根 `npm run check` 通过：TypeScript strict 检查、构建与 585 项测试；573 项通过、0 失败、12 项门控跳过（10 项真实 API、2 项平台凭据）。`git diff --check` 通过。

- 三个新增协议均覆盖纯图片、多图及 JPEG/PNG/WebP 原字节编码、JSON/SSE、工具续轮、Anthropic pause 续轮、重启及混合版本恢复。
- 资源读取取消、超时、关闭、协议注销和网络清理失败均等待真实退出；终态后的取消仍保留受信原生诊断，不生成成功节点。
- 浏览器入口：`node tests/helpers/multimodal-browser-host.mjs`。使用临时数据库、内存凭据和本地模拟提供方；后者解码并校验收到的原生图片字节，退出清理临时目录。
- 原生 Chrome 已逐一验证 Responses、Anthropic、Gemini 的粘贴上传、64×64 同源预览、纯图片发送、刷新草稿、编辑保留图片和重新生成，共 9 次成功请求。文件选择器自动上传受 Chrome 扩展本地文件权限限制，本次通过粘贴上传完成端到端验收，未修改扩展权限。
- 真实 API 与系统凭据门控未启用；模拟验收不代表远端模型识图能力验收。应用上传限制保持原值，远端更严格的限制通过提供方失败路径返回，不自动丢图、转码或重试。
