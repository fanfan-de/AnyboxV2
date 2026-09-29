# 图片资源模块

[返回模块导航](../README.md)

图片资源模块提供会话输入图片的导入、验证、不可变存储和引用保留。图片字节由组件独占，会话关联及原始输入属于 [Session](../sessions/session.md)，原生请求编码属于 [Models](../models/README.md) 与[协议应用注册](../execution/protocol-agent-registry.md)。

| 组件 | Nya 名称 | 服务 | 职责 |
| --- | --- | --- | --- |
| [Image Assets](image-assets.md) | `harness-image-assets` | `harness.image-assets` | 图片文件、草稿有效期、事务保留、读取句柄、目录排他与回收 |

`limits.ts` 是浏览器与服务端共享的纯限制数据及批量校验函数，`validation.ts` 是静态图片验证适配器，`directory-lock.ts` 是组件私有的目录所有权实现；它们均不是额外 Nya 组件。
