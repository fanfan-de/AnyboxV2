# Computer Tools

独立的受信计算机工具能力包，不依赖 Anybox Harness、Models、Session、Projects 或 worker 通信协议。调用方先固定工作目录，并用自己的不透明 scope 身份关联调用。

`/contracts` 仅包含现有工具 ID、版本、来源定义、schema 和纯预检；`/adapters` 将来源命名与参数转换为执行请求。这两个入口不加载 Nya、文件系统、进程或原生二进制。

执行入口 `/bash`、`/processes`、`/apply-patch`、`/files` 保留四个真实 Nya 组件及原服务名称。每个进程只有一个调用方拥有的根；Files 通过注入共享 Apply Patch 写入队列，图片仅通过 `tools.images` 的窄导入能力交给调用方。组件停止准入、取消并等待所有真实资源退出后才完成卸载。命令提前返回后的进程由 scope 持有，`scope.close().done` 等待它们全部退出。

工作目录是相对路径基准，不是文件系统沙箱；权限、目录绑定与调用接纳由调用方提供。工具仅报告执行事实，不读取或决定 Agent 任务状态。外部操作的耐久账本、查询原结果、恢复与重试属于调用方。

`/platform/process-runtime` 随包携带原生进程监督器；独立构建在开发机编译该包的目标二进制，安装快照不运行构建脚本。shell runtime 目录通过选项注入，既有显式 shell 环境变量保持兼容。测试运行 `npm test --workspace @anybox/computer-tools`。
