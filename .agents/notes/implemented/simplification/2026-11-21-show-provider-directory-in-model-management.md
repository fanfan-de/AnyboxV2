# Agent Note: 模型管理直接展示完整 Provider 目录

Status: implemented

## 问题

简约两列模型管理首屏只列出已保存设置的提供方。用户要求直接浏览所有目录 Provider，并将已经配好的项置顶。

## 决策

左列合并当前设备的已保存设置与 models.dev 当前可选的提供方，以稳定 ID 去重，优先使用本地显示名称。已保存 Key 或选择无需认证的提供方排在顶部。待补 Key 的已有设置与未配置项接在其后，每组按名称排序。

初始未选中任何 Provider。点击目录项后，右列读取公开模型。点击“配置 API”进入预选同一提供方的现有配置表单，取消返回该项的预览。保存并完成认证设置后，该项移入已配置组，右列切换到本地模型清单。

## 备选方案

维持只展示已配置项并从搜索流程浏览目录，会增加一次进入目录的操作，也无法从左列直接扫描可选提供方。

## 影响与代价

Anybox Harness 和 Personal Agent 使用同样的交互。左列可独立滚动，桌面和窄屏都保留两列。右列按明确选择读取模型，配置沿用已有表单、身份规则和 HTTP 接口。

## 验证

- 两款应用均通过 TypeScript 编译。`node --test --test-concurrency=2 tests/models-client.test.mjs tests/models-directory-web.test.mjs` 33 项全部通过，覆盖目录合并、去重和分组。
- macOS Chrome 使用临时 Web 宿主、目录替身和内存凭据实测两款应用。进入时完整目录可浏览，初始没有模型清单请求。键盘选择按身份读取公开目录或对应的本地模型。取消配置返回同一预览，保存测试 Key 后原 Provider 进入顶部组。320px、400px 和桌面布局保持两列。

## 关联

- [从 Provider 列表直接配置](2026-11-21-configure-provider-from-list.md) 更新了选择未配置项后的流程。
- [在 Provider 栏内滑动切换模型列表](2026-11-21-slide-model-list-in-provider-column.md) 调整了模型清单的展示位置。
- [先选择提供方的简约模型管理](2026-11-21-provider-first-model-management.md)
- [Web 客户端设计](../../../../docs/web-client-design.md)
- [模型设置回归测试](../../../../tests/models-client.test.mjs)
