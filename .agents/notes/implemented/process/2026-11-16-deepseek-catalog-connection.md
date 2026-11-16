# Agent Note: 本机 DeepSeek 连接改用 models.dev 目录

Status: implemented

## 问题

用户要求删除当前本机执行设备的“DeepSeek（迁入）”连接，改用 models.dev 目录中的 DeepSeek。现有连接来自兼容初始化，关联用户定义的提供方及“默认模型（迁入）”，当前没有配置 API Key。

## 决策

已通过当前运行客户端的正式模型管理 API，使用已接纳的 models.dev DeepSeek 提供方定义创建名为 DeepSeek 的连接，确认创建成功后按现有修订删除旧连接。新连接采用目录返回的 Chat Completions 方案与 DeepSeek API 地址。未手工写配置库、修改来源定义、凭据或会话记录。此次只调整当前本机实例，不修改通用初始化代码。

## 备选方案

未采用只重命名旧连接，因为名称变化不能关联 models.dev 的提供方与模型定义。未采用直接编辑运行中的 JSON 配置，因为正式 API 已提供写入、修订检查与删除协调。

## 影响与代价

删除旧连接时一并删除其实际模型配置，保留配置历史、对话和已开始的运行；引用旧模型的会话后续需要重新选模。旧连接无 Key，新连接同样不填入或猜测 Key，缺少凭据时维持待配置状态，自动基础模型同步需用户配置 Key 后完成。

## 验证

通过 `http://127.0.0.1:3100` 当前客户端的执行设备代理，以实例与设备连接修订绑定目标，完成以下真实运行配置验证：创建新连接成功；旧连接按 revision 2 删除成功；再次查询仅剩一条 DeepSeek 连接，其提供方来源为 external / models.dev / deepseek；旧连接的实际模型配置已删除，连接历史的两条修订仍保留。新连接返回四个目录模型，其中两个因缺少凭据不可用、两个已弃用；实际配置数量为零，凭据状态为未配置，自动同步为 pending，符合尚未提供 Key 的行为。

已在用户当前 Chrome 的模型管理中刷新并确认：仅一条 DeepSeek 连接，明确显示“来源：models.dev / deepseek”，模型列表为四个目录模型，状态为“待填写 Key”。截图位于本机 `/tmp/anybox-deepseek-catalog-connection.jpg`（临时交付材料，不属于耐久配置）。未运行真实模型调用、填写凭据或重启服务；此次未改程序代码，未运行构建及测试套件。

## 关联

- [模型管理组件](../../../../docs/modules/models/models.md)
- [模型目录组件](../../../../docs/modules/models/catalog.md)
- [模型管理 API](../../../../packages/app-harness/src/http/models-api.ts)
- [兼容初始化](../../../../packages/app-harness/src/server-models.ts)
- [后续：移除模型连接的兼容自动初始化](../simplification/2026-11-16-remove-model-bootstrap.md)
- [后续：清理旧定义并统一目录添加入口](../simplification/2026-11-16-retire-imported-provider.md)
