# @anybox/storage-sqlite

可选的本地 SQLite 提供方。业务应用与宿主自己的控制元数据可以使用它；依赖最小 `application-api` 的应用不必依赖此包。

公开入口 `@anybox/storage-sqlite` 导出存储端口与 `createLocalSqliteComponent(file, options?)`；`/port` 仅导出存储契约，`/sqlite` 导出 Nya 组件工厂。`LocalSqliteOptions.serviceKey` 可指定该连接的服务名，省略时仍为 `local-storage`；组件名仍为 `local-sqlite`。服务名在工厂调用时验证，必须是非空白且不含 NUL 的字符串，不触发文件访问。

需要独立数据库时，可在同一个 Nya 根安装两个实例，例如业务库使用默认端口，宿主安装账本使用 `createLocalSqliteComponent(registryFile, { serviceKey: 'host.package-storage' })`。各实例分别拥有自己的文件、队列和清理；自定义服务名不会绕过同文件的排他所有权，也不创建额外 Context。

组件拥有指定文件的一条排他连接、操作串行队列与 `schema_migrations` 账本。各领域在自己的组件初始化中调用 `migrate(domain, migrations)` 登记表，提供方不接收应用业务迁移。`read` 禁止写入；`transaction` 可以原子修改同一连接上多个领域的表，失败或取消回滚。回调退出后读写句柄失效。

清理先拒绝新操作，等待已经接受的队列实际退出，再关闭连接。现有默认调用保留原来的路径、领域账本与事务边界，不分割业务数据库、不复制数据、不额外打开相同文件。`tests/storage.test.mjs` 覆盖重开、版本升级、跨领域事务、排他所有权、取消、关闭等待，以及同根不同服务端口的独立所有权和清理。运行 `npm test --workspace @anybox/storage-sqlite`。
