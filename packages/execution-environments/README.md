# Agent 执行环境

Personal Agent 和 Anybox Harness 分别在所属执行端装配本包。每份组件使用所属应用的独占执行库，持有 Agent 工具授权和在途准入，不读取连接令牌或模型密钥。

## 入口

| 导出 | 用途 |
| --- | --- |
| `@anybox/execution-environments` | Nya 工厂 `createExecutionEnvironmentComponent({serviceKey})`、授权管理和准入端口 |
| `/contracts` | 浏览器可用的环境工具身份、授权修订、变更回执和结构校验 |
| `/catalog` | 受信环境契约、固定快照、退役工具兼容、真实提供方绑定与 scope 分派 |
| `/bindings` | 从项目附着、提供方资源、完整工具定义及其版本生成确切身份，将实际声明固定到 Run |
| `/run-policy` | 核对 Session 声明与可用权限，向 Models 提供受管的发送回调 |
| `/run-authority` | 封装函数分派的准入、原操作查询、scope 接管与退出等待 |
| `/management` | 对接各应用的管理接口、环境目录投影与输入校验 |
| `/settings-view` | 两款应用的执行端环境授权界面 |

组件依赖、准入提交点和中断恢复见[执行环境授权组件](../../docs/modules/tools/execution-environments.md)。工具提供方契约和独立资料库示例见[环境提供工具](../../docs/tool-environments.md)。本包的运行测试覆盖同一执行库的不同 Agent、权限 CAS、子进程异常退出、原操作查询与所有者退出，使用真实 SQLite 和临时目录。

```sh
npm run build
node --test packages/execution-environments/tests/*.test.mjs
```
