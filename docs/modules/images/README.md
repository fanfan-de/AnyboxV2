# 图片资源模块

[返回模块导航](../README.md)

图片资源模块提供会话输入图片的导入、验证、不可变存储和引用保留。图片字节由组件独占，会话关联及原始输入属于 [Session](../sessions/session.md)，原生请求编码属于 [Models](../models/README.md) 与[协议应用注册](../execution/protocol-agent-registry.md)。

| 组件 | Nya 名称 | 服务 | 职责 |
| --- | --- | --- | --- |
| [Image Assets](image-assets.md) | `harness-image-assets` | `harness.image-assets` | 图片文件、草稿有效期、事务保留、读取句柄、目录排他与回收 |

`limits.ts` 是浏览器与服务端共享的纯限制数据及批量校验函数，`validation.ts` 是静态图片验证适配器，`directory-lock.ts` 是组件私有的目录所有权实现；它们均不是额外 Nya 组件。

当前 Responses、Chat Completions、Anthropic Messages 和 Gemini Interactions 四种协议都支持显式声明的静态 JPEG/PNG/WebP 输入。图片先保存为草稿，Session 接受 Run 时同事务永久保留引用；协议 execution 只在受管操作启动后读取并编码原字节，持久历史不含 base64。原生记录为 v2，当前 Run 输入为 v3；它们与图片组件自己的 `image-assets` v1 迁移域独立。

会话归档由 Session 限制新的图片导入，不删除已保存图片或永久保留凭证；历史读取及草稿续期继续可用。组件不依赖会话状态，也不因归档而回收历史资源。完整接口、配额和取消/关闭等待见 [Image Assets](image-assets.md)。
