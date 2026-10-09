# Anybox 桌面形态迁移：视觉与交互验收

final result: passed

## 对照依据与边界

- 来源截图：`/Users/tezign/Documents/GitHub/anybox/tmp/codex-devtools/anybox-main.png`，2327×1265 像素。旧图的 CSS 视口和 DPR 未记录，按应用结构与已核实的源码尺寸比较，不宣称逐像素一致。
- 主题依据：旧版 `packages/desktop/src/shared/appearance-token-manifest.json` 的 `built-in:classic` light 覆盖值。
- 实现截图：[`docs/ui/anybox-conversation.png`](docs/ui/anybox-conversation.png)、[`docs/ui/anybox-empty.png`](docs/ui/anybox-empty.png)、[`docs/ui/anybox-settings.png`](docs/ui/anybox-settings.png)，均为内置浏览器原始截图，1280×720 像素，CSS 视口1280×720、DPR 1。未裁切、合成或重绘。
- 来源和实现截图已在同一次图像检查中共同查看。来源含未迁入第二版的右侧文件/审查区，且会话内容、视口不同；这些差异属于明确的功能边界，不能作为布局像素误差。
- 局部检查：另在实际 888×864 CSS 视口查看图标、标题截断、分支栏、消息排版与输入框；全图中的对应区域可读，无须另造局部对照图。
- 响应式验证：真实 DOM 测量为桌面 1440×900、窄屏 390×844 CSS px；当前内置浏览器 DPR 约 1.4，视口工具按设备尺寸设定后核实 CSS 尺寸。该模式截图会在外层画布缩放，故未用它作像素级比较。最终交付截图使用独立标签页的默认 1280×720 视口，无该缩放问题。
- 测试后端运行在独立临时 SQLite 与内存凭据环境；预置模型本地返回，不访问真实模型、真实 Key 或工作区 `data/harness.sqlite`。

## 五项视觉核对

| 项目 | 结果 |
| --- | --- |
| 字体与文字 | 普通系统 sans、正文 14px、侧栏 12px、次级信息 10–11px；保留 IBM Plex 优先字体名并使用系统后备。未打包旧桌面的完整字体资源，跨系统字形可能有轻微差异，列为 P3。 |
| 间距与布局 | 54px 功能栏、236px 项目侧栏、40px 顶部与面板标题、880px 阅读列；助手无卡片、用户右侧轻气泡、输入框6px圆角无阴影。小面板按自身高度收紧。 |
| 颜色 | 主画布 #f2f2f2、侧栏 #e8e8e8、功能栏 #ededed，低对比细边线与黑灰主按钮；透明桌面表面折算成显式 Web 色值。 |
| 图像与图标 | 猫盒从旧版三个 idle masks 原样合成点阵 SVG，并非重绘替代；普通功能图标统一细描边。图像边缘清楚，无远程图像依赖。 |
| 文案与内容 | 保留当前真实功能：项目、会话、分支、发送、取消、Key、Prompt；未放置插件/日历/文件面板等无实现入口。会话标题只从已加载输入派生，未修改服务端数据模型。 |

## 迭代记录

1. 初版迁移将绿色卡片工作台调整为 Classic 灰白桌面结构。根节点原先因运行记录隐藏而完全空白，现显示起点提示与已有分支按钮；继续保留用户此前隐藏 Run 列表的修改。
2. [P2，已修复] 小高度分屏沿用整窗 `22dvh` 底部空间会裁切空白页/输入框。改用面板 size container queries；四面板实测每个 571×426px，输入框下沿分别454/888px，均在面板466/900px下沿以内。380px以下进一步隐藏品牌装饰、缩短编辑区。
3. [P2，已修复] 隐藏面板会将长草稿输入框高度重置。隐藏或未连接时跳过重算，显示和布局尺寸变化时重算。窄屏来回切换后五行草稿完整保留，输入框132px，无整页横向溢出。
4. [P2，已修复] 设置按钮移到常驻功能栏后，原逻辑仍按侧栏是否隐藏来还焦。改为按设置入口本身是否可见判断，窄屏关闭设置后焦点确认为 `open-settings`；抽屉 Esc 后焦点确认为 `toggle-sidebar`。
5. 会话标题在加载期间可能从暂态数据漂移，改为已完成读取后缓存首次已知输入。后续截图与导航检查中标题保持稳定。

修复后重新捕获并查看上述三张交付截图，没有未处理的 P0/P1/P2 问题。保留的字体差异、静态品牌图而非动画、单浅色主题、设置采用当前功能对应的较小窗口，均为本轮明确边界。

## 流程检查

1. 打开项目/会话：正常；路径在悬停中可查，已加载会话展示输入标题。
2. 根节点选择后续分支：正常；不推断全局 head，不自动跳到最新节点。
3. 输入并发送：正常；空白不可提交，真实 Run/SSE/SQLite 接受、返回并保存回答，主动发送的结果按原规则跟随。
4. 跨项目四分屏：正常；右侧、下方打开以及跨项目导航保持已有面板，输入框未裁切。
5. 响应式切换：正常；窄屏显示面板切换条，草稿与显示高度保持，无整页横向溢出。
6. 设置与 Prompt：正常；弹窗内容内部滚动，嵌套开关正常，关闭返回合理焦点；未写入或删除凭据。
7. 移动导航：正常；抽屉显示、Esc关闭与焦点恢复符合预期。
8. 浏览器控制台：检查的两个测试标签页无 error/warn。

完整自动检查结果见 `docs/web-client-design.md` 的本轮验收补充。取消、工具执行与资源退出依赖原有自动行为测试；本轮未调用真实模型验证这些流程，不声称截图证明完整可访问性合规。


## 后续：项目下分组会话（2026-09-27）

用户要求会话直接列在各自项目下。新版将原来的两段列表改为各项目的可折叠组，统一滚动；行内“＋”在对应项目创建会话。其余画布与对话样式不变。

已查看 [`docs/ui/anybox-grouped-sidebar.png`](docs/ui/anybox-grouped-sidebar.png)（1280×720、DPR 1）和实际窄屏抽屉截图，检查缩进、截断、滚动和工具按钮。隔离测试确认：折叠项目A不隐藏项目B；在B行创建后会话只增加在B下；从A会话菜单在B旁分屏，两个项目组与面板均保留。控制台无 error/warn；全量检查244通过、2跳过。没有新增 P0/P1/P2 问题，final result 仍为 passed。

## 后续：Codex 文件侧栏布局（2026-10-02）

Date: 2026-10-02

final result: passed

### Target and scope

Reference: the supplied Codex screenshot, 2868 × 1572 pixels at 144 dpi. The target is the file workspace layout: preview on the left, full-height tree on the right, file tabs, a path row, filtering, compact tree rows and selection.

Implementation: the existing Anybox Harness application. The Anybox light palette, plain-text preview, range selection and snapshot/reference actions are retained. This is a layout adaptation; it does not add Markdown rendering, source editing, terminal actions or Codex's outer application chrome.

The isolated test host used a real 1440 × 900 CSS-pixel iframe and disposable projects. Browser captures are 1687 × 949 pixels at 72 dpi. The reference and implementation file regions were cropped and normalized to 600 pixels wide in [comparison.png](artifacts/file-layout-qa/comparison.png); their different panel heights remain visible. Full context is in [desktop.jpg](artifacts/file-layout-qa/desktop.jpg), with the narrow state in [mobile.jpg](artifacts/file-layout-qa/mobile.jpg).

### Visual comparison

- Typography: compact system-font tabs and tree rows, with the existing monospace raw-file reader. Text stays selectable and file contents remain textContent.
- Spacing and layout: preview and tree are side by side; the tree is 220px wide and the two regions scroll separately. Tabs, path and reference controls sit above the reader. At file-panel widths of 480px or less, the regions stack inside the existing drawer.
- Colors: the existing Anybox light surfaces and borders are retained; hover, focus and selected rows remain distinct. The supplied dark theme is outside the requested layout change.
- Image quality: all eleven local, unmodified Codicons SVG assets load successfully. No raster placeholders or newly drawn icon approximations are used.
- Copy and content: short filenames appear in tabs; complete paths, ranges and snapshot/current-file identity are available through title and accessible labels. The filter states that it covers loaded entries. Device/project scope appears in the path row.

### Iteration and fixes

The first desktop capture showed a P2 issue: a long breadcrumb pushed the filename outside the visible area. The path now occupies its own toolbar row, ancestors shrink with ellipsis, and the final filename remains visible. Full-path and individual segment titles preserve the omitted text. The revised desktop capture and normalized comparison above confirm the fix. No open P0/P1/P2 visual issues were found in the requested region.

### Interaction and behavior verification

- 1440px, 1024px and 390px containers: side-by-side layout, stacked layout and drawer; no file-panel overflow.
- Multi-level expansion, selection, case-insensitive filtering, retained ancestors, input focus and Escape clearing.
- Keyboard tab switching, range preview and reference insertion, plus snapshot/current-file separation in behavior tests.
- Switching Alpha/Beta sessions changes project bytes and restores each session's file tabs; refresh restores descriptors and rereads content.
- On mobile, Escape first clears a nonempty filter, then closes the drawer and returns focus to its opener.
- The iframe test surface captured two MutationObserver startup diagnostics without source stacks. The direct updated application page produced no warning or error entries on startup and file-panel loading. These diagnostics were not attributed to the file-layout change.

Validation: npm run check completed with 818 passing tests, 13 gated skips and zero failures. After the final breadcrumb style/title adjustment, npm run build passed with exact browser resource verification. No model requests or real credentials were needed for isolated acceptance.

## 后续：参考相邻 Anybox 文件界面实现（2026-10-02）

final result: passed

Reference: `../anybox/packages/desktop/src/renderer/src/app/files/WorkspaceFilesPanel.tsx` and `../anybox/packages/desktop/src/renderer/src/styles/right-sidebar.css`. The source supplies a full-width path bar, reader / splitter / tree layout, collapsible tree, compact rows and filtering over already loaded entries. V2 keeps its existing file tabs, raw text/reference semantics and narrow-container layout.

The path bar now shows session device/project scope even before a file is opened. Directory refresh and collapse sit together there. The internal 8px separator supports pointer dragging, keyboard steps, Home/End and a double-click reset. Requested tree width is saved per session, while fitting reserves 280px for the reader without rewriting that preference. A collapsed tree gives the reader the full content width. Search is 28px high and tree rows are 24px high.

Filtering can temporarily reveal cached collapsed branches. Only entry metadata is retained, never server cursors or continuation handles. Explicit expansion still reads through the existing tree client. Review found two issues, both repaired and covered by behavior tests: a filtered explicit expansion initially skipped its read, and a successful empty reread initially left stale cached rows.

Browser acceptance in the disposable host verified pointer resizing from 230px to 270px, complete collapse, temporary filtering and Escape restoration, independent Alpha/Beta widths, and refresh recovery of Alpha's width and file. At 1024px the narrow file panel stacks its regions; at 390px its drawer has no horizontal overflow and the internal separator is hidden. Updated screenshots: [workspace](artifacts/file-layout-qa/anybox-reference.png), [desktop](artifacts/file-layout-qa/anybox-reference-desktop.jpg), [mobile](artifacts/file-layout-qa/anybox-reference-mobile.jpg). No open P0/P1/P2 issues were found in the changed region.

The direct 3000 application page was refreshed and showed the new path bar and directory layout, with no warning/error console entries. The iframe fixture again recorded two MutationObserver startup errors without source stacks, matching the earlier fixture limitation; this check does not claim that the entire iframe console was clean.

Validation: `npm run check` passed with 820 passing tests, 13 gated skips and zero failures. Exact browser assets and strict TypeScript checks passed. No real model calls or credentials were needed.

## 后续：Anybox Harness 紧凑轨迹视图（2026-10-02）

final result: passed

Reference: the supplied DeepSeek Harness screenshot (`codex-clipboard-248f1935-0c03-478c-8547-93c79b5c3661.png`, 2876 × 1332 pixels), plus the adjacent `deepseek-harness/packages/client/ui-trajectory` implementation. This adaptation follows its continuous role rows, three-lane timeline and row inspection while retaining Anybox's gray theme, conversation tree and current safe-display budget.

The isolated host used disposable SQLite databases, in-memory credentials and a local model fixture. Two real successive Runs produced ten model operations and eight Bash/Apply Patch calls, including an actual rejected patch and preserved earlier file changes. No real model service or production credentials were used.

Screenshots: [desktop](artifacts/trajectory-qa/trajectory-desktop.jpg), [side details](artifacts/trajectory-qa/trajectory-details.jpg), [390px search/details](artifacts/trajectory-qa/trajectory-narrow-search.jpg), [short split](artifacts/trajectory-qa/trajectory-short-split.jpg). The direct desktop viewport measured 1019 × 925 CSS px, DPR 1.5; its browser-returned image is 1018 × 925 pixels. The narrow iframe measured exactly 390 × 900 CSS px, DPR 1.5; its full context capture is 2248 × 1297 pixels. Captures are original browser output without resampling or compositing. Reference, desktop and narrow captures were viewed together; viewport/content/theme differences make this a structural comparison, not a claim of pixel identity.

### Visual comparison and iteration

- Typography: compact system-font role labels and 32px rows; tool arguments/results use the existing monospace face. Full safe text remains available in the inspector and accessible labels.
- Spacing/layout: toolbar above three 14px lanes; model/tool rows form a continuous table. Run headers preserve branch origins and counts. Tools reserve separate argument/result columns so long commands do not hide the result. Desktop inspection sits on the right; panes at 640px or less stack it below.
- Colors: existing gray surfaces/borders, with blue user, green context, purple assistant and ochre tool labels; failures are visible in timeline and detail state. There is no additional theme or fabricated metric.
- Image quality: the view uses native text and existing local SVG icons; no raster mockups or remote assets are inserted into the application.
- Copy/content: user summaries preserve original input, while actual sent prompts and returned reasoning remain in safe detail fields. Search describes its loaded-display scope; loading, missing old facts, failed reads and truncation are distinct states.

Review repaired timeline navigation to a search-hidden target, inconsistent global tool-fold state after selecting a tool-free answer, hidden inspector scroll loss, and short-pane detail clipping. The final gray layout retains the intended density without the earlier Run cards. No open P0/P1/P2 issue was found in the changed region.

### Behavior acceptance

- Two Run groups and 21 rows render in stable operation order; durations correspond to recorded event intervals. Time mode omits unknown input durations and retains concurrent overlap in the pure projection tests.
- Clicking a timeline block locates/selects its row; desktop side inspection exposes exact stdout/stderr, exit state, patch changes/pending/diagnostic and answer navigation.
- Case-insensitive `FILE-NOT-FOUND` search finds the diagnostic beyond the visible row abbreviation. Escape clearing restores the list; Escape on a selected row closes detail. Call folding remains consistent after selecting the final answer.
- A real 390px iframe has a 346px Anybox Harness pane and no document horizontal overflow. Bottom inspection uses 385/315px rows and remains scrollable. At 530 × 312px in an actual vertical split, its close button is still within the pane; the layout has no horizontal overflow.
- Behavior tests cover arrow/Home/End selection, fold focus, search while reads are pending, two-slot progressive loading, SSE/reconnect updates, terminal cache, hidden/reactivated position preservation, repeated tool IDs, branch/concurrent/failed/cancelled/interrupted Runs and partial patch facts.
- The iframe fixture again recorded a MutationObserver startup diagnostic without a source stack, matching the earlier fixture limitation. Its mounted application completed the checks; this report does not claim that the whole iframe console was clean.

Validation: `npm run check` completed with 879 passing tests, 13 gated skips and zero failures, including strict TypeScript and exact browser-resource verification. Final independent read-only review found no blocking issue. Complete long-history pagination and full-history search remain the next stage; the current `/view` display budget is unchanged.

The existing `npm run web` launcher was gracefully stopped and restarted with the same data configuration. Client/Products returned HTTP 200, the execution endpoint retained its unauthenticated HTTP 401 boundary, and served trajectory/session modules matched the new build hashes. The direct 3000 application mounted successfully with no captured warning/error entries. The temporary acceptance host was then shut down.
