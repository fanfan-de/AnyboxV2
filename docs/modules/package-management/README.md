# 包管理模块

[返回模块导航](../README.md) · [应用包设计](../../application-packages-design.md)

包管理属于 Anybox 宿主的生命周期职责。应用可直接从文件夹安装，显式本地信任目录无需发布签名或压缩；`.anybox-app` 是可选的签名 ZIP 分发形式。D1.1 提供安装事实、耐久操作、确切版本快照与代码使用证明，D1.2 增加独立产物、目录/归档和准备验证，D1.3 接入本地安装与显式恢复，D1.4 接入正式角色加载与受控版本生效，D1.5 复用批次接入本机卸载和默认保留数据的代码回收；应用业务、数据迁移、执行设备连接和业务凭据继续由各应用持有。

| 组件 | Nya 名称 | 服务 | 职责 |
| --- | --- | --- | --- |
| [安装事实与操作账本](registry.md) | `host-package-registry` | `host.package-registry` | 安装与选择事实、操作幂等及恢复、目录快照、跨进程使用凭证和受控回收准入 |
| [正式角色加载、生效与卸载](activation.md) | `host-package-activation` | `host.package-activation` | 全角色及页面保护、精确目录加载、耐久交接、实际就绪、卸载回收协调和显式恢复 |
| [本地目录与文件安装](installation.md) | `host-package-installer` | `host.package-installer` | 先登记再接收目录快照或归档、信任与完整性验证、独立准备、不可变目录提交、取消与中断恢复 |

注册库依赖同一 Nya 根上独立命名的 [Local SQLite](../infrastructure/local-sqlite.md) 实例：`host.package-registry-storage`。它持有包管理目录中的 `registry.sqlite`，不复用客户端控制及应用业务连接，也不增加 Context。

`port.ts` 定义宿主账本契约，`domain.ts` 与 `file-install-domain.ts` 保存校验、身份归一化与状态转移纯函数；`usage-locks.ts` 管理跨进程实际锁，`paths.ts` 验证注册库路径，`installer-files.ts` 持有安装器的文件副作用。这些是组件内部实现或供受信角色启动器使用的辅助函数，不另计 Nya 组件。

[归档与独立产物](archives.md)说明 D1.2 的纯验证器、临时准备进程、空宿主入口和构建工具，它们不另计 Nya 组件。只读 `anybox-host verify` 不写入安装事实；本地文件安装使用独立安装端口，成功后登记已安装待生效。最小 CLI/桌面宿主已通过 D1.4 把安装版本接入正式加载与生效；原 distribution 默认完整组合保留，旧发行迁入留在 D3。D1.5 已接入卸载与代码回收，文件回收辅助器归生效组件使用，不新增组件。加载器、固定 bootstrap、稳定代理与多页面 SSE 归生效手册说明，均为内部受信辅助实现，不另计组件。
