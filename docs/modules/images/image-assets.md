# Image Assets 组件

[图片资源模块](README.md) · [模块导航](../README.md)

## 职责与工厂

图片资源组件独占上传临时文件、完成后的原始图片字节、图片元数据、保留凭证、读取句柄和后台回收。它不解释 Session、Run 终态或原生协议 payload，也不上传图片至第三方文件服务。

| 项目 | 定义 |
| --- | --- |
| 工厂 | `createImageAssetsComponent({ directory, now?, newId?, collectionIntervalMs? })` |
| 源码 / 契约 | [component.ts](../../../src/applications/harness/core/image/component.ts) / [port.ts](../../../src/applications/harness/core/image/port.ts) |
| Nya 名称 / 服务 | `harness-image-assets` / `harness.image-assets: ImageAssetsPort` |
| 注入依赖 | `local-storage: LocalStoragePort` |
| 私有适配器 | [validation.ts](../../../src/applications/harness/core/image/validation.ts)、[directory-lock.ts](../../../src/applications/harness/core/image/directory-lock.ts) |
| 共享限制 | [limits.ts](../../../src/applications/harness/core/image/limits.ts) |

所有元数据与保留凭证通过既有业务 SQLite 连接读写，不另开数据库连接。组件在 `apply` 中登记 `image-assets` 领域迁移、恢复遗留上传和删除，再提供服务；长期回收定时器不阻塞启动。

## 支持范围和限制

仅接受完整可解码的静态 JPEG、PNG、WebP，单图最多 10 MiB、宽高分别最多 4096 像素。每轮最多 8 张且合计最多 20 MiB；`validateImageBatch()` 按实际发送次数计算重复图片。纯限制模块可直接由浏览器导入。

扩展名与请求 Content-Type 不是格式证据。验证先检查容器签名，拒绝 APNG 的 `acTL`、WebP 的动画标志/块，再用锁定版本 `sharp@0.35.5` 检查元数据和完整像素解码，拒绝多页、截断和损坏图像。图片保持上传原字节，不缩放、旋转、重编码或删除元数据。组件的可取消 FIFO 队列最多同时接收并验证两次导入；排队时不创建资产行或文件。

## 服务契约

| 接口 | 行为 |
| --- | --- |
| `importImage({scopeId, bytes}, signal?)` | 接收 `AsyncIterable<Uint8Array>`，返回拥有取消、`result` 和实际退出 `done` 的调用；成功返回服务端生成的 `ImageRef` |
| `describe(scopeId, assetIds)` | 查询指定作用域内仍有效或已永久保留的图片元数据，保持传入顺序 |
| `retainIn(tx, scopeId, ownerKey, refs)` | 调用方同一业务库事务中的同步参与方法；复核全部不可变字段、批量限制与有效期，再写永久保留凭证 |
| `readImage(scopeId, assetId, signal?)` | 返回受管原字节读取；检查作用域、文件类型、大小和 SHA-256 |
| `renew(scopeId, assetIds)` | 事务内把尚未过期草稿续至当前时间后 24 小时，返回 `{valid,invalid}`；不复活已过期资产 |

`ImageRef` 包含 `assetId/sha256/mediaType/byteLength/width/height`，未保留草稿另含 `expiresAt`。`assetId` 为随机不可变身份，SHA-256 用于校验，不进行按内容去重。`describe/renew` 单批最多 8 个 ID，客户端可分批处理多面板草稿；共享续期间隔建议为 5 分钟。

`scopeId` 使用已由受信 Session 入口验证的会话 ID。组件不回调 Session，不能用随机资产 ID 代替宿主权限或会话归属检查。浏览器不可传入本地路径。受信 Models 的读取桥也必须限定允许的历史和本轮资源引用。

## 文件、表与原子接纳

组件持有 `harness_image_assets` 与 `harness_image_retentions`。前者保存 `staging/ready/deleting` 状态、作用域、摘要、格式、尺寸和有效期；后者按 `assetId/ownerKey` 保存不可过期保留凭证。`ownerKey` 是不透明字符串，通常为 `run-input:<runId>`。Session 持有原始输入及图片顺序，图片组件不复制会话树关系。

导入顺序为登记 `staging`、写 `<assetId>.part`、同步文件、完整解码、以不覆盖已有路径的文件链接发布 `<assetId>.image`、删除临时链接、同步目录、提交 `ready`。只有最终状态提交后才返回引用。Windows 不支持目录 fsync，仍同步文件内容。临时文件和原图使用私有文件权限；不向浏览器暴露存储路径。

Session 在接纳事务中先检查幂等请求、会话和父节点，然后调用 `retainIn()`，接着保存 Run 与原生输入，一起提交或回滚。`retainIn` 的 SQL 留在图片组件，调用方不直接操作图片表；该方法不得另开事务、执行文件 I/O、保存 transaction 对象或异步返回。调用者与组件必须共享同一个 `local-storage` 实例。到期时间在事务执行时读取注入时钟，调用者传来的旧 `expiresAt` 不改变判定。

已保留图片可以用于同会话重新生成和并行分支，各 Run 各有保留凭证。取消、失败和 interrupted 的已接受 Run 仍需要原始输入，因此不释放图片。当前历史没有删除接口，组件也没有公开释放永久凭证的接口。

## 回收、崩溃与竞争

草稿在完成后 24 小时过期；移除输入框预览不直接删除文件。后台默认每小时回收，`collectionIntervalMs` 可供宿主和测试调整。回收先在业务库事务内挑选无永久保留、无活动读取且过期的资产，标记 `deleting`，提交后再删文件及元数据。读取在串行存储操作中同步取得私有活动租约，文件句柄关闭后才释放。保留与删除标记共享同一存储队列：接纳先提交则不会删除，删除标记先提交则接纳明确失败。

启动时清理此前进程留下的全部 `staging`，重试 `deleting`，保留未过期草稿和永久引用。文件完成但 `ready` 未提交的上传也作为 `staging` 清理。已删文件但尚未删元数据可幂等完成；后台删除失败保留标记等待下次重试。文件缺失或摘要不符报告稳定错误，不改写历史、不静默丢图，也不从网络补取替代文件。

规范化目录旁的 `.lock` 目录持有唯一 token 文件，包含 hostname 和 PID。候选锁先完整写入且同步 token，再原子重命名发布，因此活动正式锁始终非空。竞争者只在同主机 `kill(pid, 0)` 明确返回 `ESRCH` 时回收死亡持有者；未知主机、权限不足和 PID 复用均保守拒绝。回收和关闭只删除精确 token 文件再尝试移除空目录，绝不递归删除锁；竞争者安装新 token 后，旧清理不会移除它。杀死进程后目录可重新取得，无须新增 SQLite 连接。

## 取消与关闭

`result` 在导入/读取和它的资源清理结束后结算；`done` 区分普通业务失败与清理失败。取消请求停止后续读取并调用输入迭代器的 `return()`，但必须等已开始的 `next()`、sharp 解码、文件操作和迭代器退出，不能把发出取消当作完成。排队取消也关闭尚未消费的输入迭代器。操作完成全部清理后再检查取消，因此最后关闭文件期间发生的取消也不能返回成功字节。

组件 Effect 先关闭准入和定时器，取消全部受管调用，等待已接纳查询/续期、导入、读取与回收，最后释放目录锁。Session/协议注册通过注入依赖保证先于图片组件退出；图片组件先于共享业务库退出。失败清理不会报告成功，Nya 根关闭会收到错误。

## 失败边界与测试

公开错误统一为 `ImageAssetError`，通过 `isImageAssetError` 判断，`code` 为 `asset-invalid`、`asset-too-large`、`asset-unsupported`、`asset-expired`、`asset-missing`、`asset-corrupt`、`asset-unavailable`、`asset-occupied`、`asset-cancelled` 或 `asset-cleanup-failed`。底层解码、文件和路径错误不越过服务边界。

[image-assets.test.mjs](../../../tests/image-assets.test.mjs) 覆盖原字节保持、真实解码拒绝、跨领域事务原子性、并发分支保留、过期/续期/回收、接纳与 GC 两种获胜顺序、活动读取保护、删除失败重试、文件损坏、最后关闭阶段的取消与实际退出、导入并发限制、跨数据库目录排他、真实进程强杀后的锁回收、竞争回收者和各文件提交阶段的崩溃恢复。整体完成运行 `npm run check`。
