# Agent Note: 在模型管理中搜索 Provider 并显示品牌 Logo

Status: implemented

## 问题

模型管理将完整提供方目录放在左列。已有搜索只在选中提供方后筛选其模型，用户查找长目录中的提供方需逐项滚动，行内也缺少品牌标识。

## 决策

Anybox Harness 和 Personal Agent 都在 Provider 列表顶部提供实时搜索，匹配本地显示名、目录名称及来源 Provider ID。保留原分组与选择，返回列表时保留搜索词，离开模型管理时清空。已有设置通过固定目录身份关联品牌，应用随包提供 models.dev 的图标，缺少图标时显示名称首字符。

## 备选方案

仅按显示名称筛选会漏掉自行改名的配置。直接从 models.dev 加载图标依赖网络且需扩大宿主的图片来源策略，采用构建期随包提供的固定资源。

## 影响与代价

搜索在现有列表数据上运行。两款应用的构建将同一份固定绘图数据和许可证输出到各自的静态资源。图标按 models.dev 来源身份匹配，可离线展示，需更新固定数据才能增加图标覆盖。

## 验证

- `npm run check` 通过，2403 项测试通过，18 项跳过。最终调整后重新构建两款应用，`node --test tests/models-client.test.mjs` 12 项通过，`node scripts/verify-web-assets.mjs` 通过。
- Chrome 以同源测试宿主加载两款应用的模型管理代码及样式，在 1094px 和 480px 验证分组、即时筛选、无匹配提示、清空、焦点与返回保留搜索词。验证期间搜索未请求 API，DeepSeek、OpenAI 和名称首字符均正常渲染。
- 验证构建产物各自包含品牌绘图与许可证，且同页挂载时图标内部 SVG ID 不冲突。浏览器实测使用目录替身，未做桌面发行安装验收。

## 关联

- [直接展示完整 Provider 目录](../simplification/2026-11-21-show-provider-directory-in-model-management.md)
- [在 Provider 栏内滑动切换模型列表](../simplification/2026-11-21-slide-model-list-in-provider-column.md)
- [Web 客户端设计](../../../../docs/web-client-design.md)
- [模型设置回归测试](../../../../tests/models-client.test.mjs)
- [固定图标数据](../../../../scripts/assets/provider-logos.json)
