---
paths:
  - "src/mcp-spec.ts"
  - "src/mcp-tokens.ts"
  - "src/mcp-remote.ts"
  - "src/client/McpSection.tsx"
  - "src/client/McpSection.module.css"
  - "src/client/McpEditor.tsx"
  - "src/client/McpTargetSelect.tsx"
  - "src/client/config-issues.ts"
  - "src/client/mcp-row-state.ts"
  - "src/client/agent-filter.ts"
  - "src/client/settings-controller.ts"
---

> 覆盖：设置页分区（全局分组恒在最前、加载方式选择器、写入落点、行级只读置灰）、行内布局（平面芯片、右侧居中、状态徽标）、工具列表的 token 估算与加载态、MCP JSON 推断规则。何时读：改设置页布局与交互、改工具列表、或动 spec 推断时。

# 设置页分区、行内布局与 MCP JSON

## 设置页分区(src/client/McpSection.tsx)

**Agent 显示名复用宿主**：传给页面的预设保留 `{id,name?}`，不可提前 `name ?? id` 抹掉内置预设判据。由 `settings.agentPreset` 字典 + `@deepseek-ai/dsh-agent-preset-registry/display` 的公共纯 helper 在 render 时解析（本包 `preset-name.ts` 仅包缺字典回退），筛选菜单、卡片平面芯片、新增目标与编辑范围共用 resolver，写入/筛选始终用原始 id。自定义 name（含空串）不翻译；缺字典退回 id。不要为显示名调会等待 activation audit 的 registry RPC，不复制中文映射，不 runtime-import UI 插件；构建仅把无 import 的 `/display` 精确内联，不请求宿主动态 ModuleLoader 子路径。

一个 `settings.section`(id `mcp-manager`,order 14)承载插件的两面,**页内用 `SegmentedTabs` 分「服务器」/「设置」**
(2026-10-16 起两页合并;此前是第二条 `settings.section`,order 15 与内置插件区撞号、在侧栏里排不到一起,
被读成"同一个插件两个页面";同日第二轮把第二个页签从「上下文」改名「设置」并把加载方式移进它)。
名册是**一个列表**,两个平面用列表内的分组标题分开,全局恒在最前 **(更早一轮已不再有平面 tab)**。约束:

1. **全局分组恒在最前、永不被过滤掉** —— 会话带着它的全局行,不管跑哪个预设;预设下拉只收窄 agent 行。
2. **开关的语义不再用一句页内说明讲**(`mcp.list.hint` 已于 2026-10-16 删除):`dynamic`/`lazy` 下开关打开**不等于**
   启动,何时进上下文由「设置」页签的加载方式决定(决策 D1);这个区分现在只由两处控件自身的标签与所在页签承载,
   要恢复一句说明就加回去,但**不要再写"全局行始终加载 / 不受加载模式影响"** —— 那是更早之前的行为。
   全局分组的空态只留一句(`mcp.empty.global.hint`:对所有会话可用、工具过滤不生效)。
3. **加载方式在「设置」页签,排在策略行之前**:它不随名册页签走 —— 这是页级偏好,不是列表的属性。
   **块标题旁那句「立即生效…」(`mcp.mode.when`)与策略行上方那段总述(`opt.intro`)已于 2026-10-16 第五轮
   按用户要求删除**(见 D30):生效时机由控件自身与下方每个模式的说明承载,策略行各有自己的标题与说明;
   **加载方式的三段控件占满整块宽度**(`.modeBlock` 用 `align-items: stretch`,与页面页签同宽),不要退回
   `flex-start` 那种"内容宽的小工具栏"。
4. **写入落点由一个下拉选**(`McpEditor` 的 `plane` 入参只是**初值**;弹窗用 `McpTargetSelect`,2026-10-16
   第四轮按用户要求把原来的两级「配置范围 + Agent 预设」合成一个,见 D27):
   编辑某行 → 该行自己的平面,弹窗只读显示;新增 → 一个下拉列出 **全局 + 全部已声明预设**(空串哨兵 = 全局,
   预设 id 非空;预设项文案 `预设 · <名>`)。**不要再把写入平面做成页面级状态**:单列表改版删掉平面 tab 之后,
   `writePlane` 只能靠"编辑一条已有全局行"赋值,于是全局分组为空时**写入全局在界面上不可达**;而默认停在
   "全部 Agent 预设"又让 `needsPreset` 把新增按钮在首屏就禁用、原因只写在 `title` 里。全局平面不可写时
   **那一档在下拉里禁用**并在地下拉下方写明原因(`mcp.global.unavailable`),而且**初值回落到第一个预设**(有预设时
   根本不会卡在不可写的全局上);一个可写的落点都没有才禁用保存(`mcp.form.noTarget`)。空态里的「新增到全局 /
   新增到 Agent 预设」按钮只在**该平面真能收下这一行**时出现。
5. **行级只读要真的置灰**:名册行带 `writable` / `readOnly`(全局行的 `composed-row`、平面的 `no-writable-include` /
   `several-writable-includes` / `unreadable-include`):只读行的卡片不进"点击打开编辑器"那条路径,开关禁用并把原因
   写进 `title` / 提示位;不要只靠服务端拒绝,也不要把禁用的控件留在可点击状态。**行内不再有「编辑 / 密钥」按钮**
   (2026-10-16 第三轮,用户要求去掉,见 [design-decisions.md](../../docs/design-decisions.md) D26):整张卡片就是
   编辑入口,有 `env`/`headers` 的行落在编辑器「密钥」页、其余落在「配置」页,所以去掉按钮不丢能力;
   `mcp.edit` / `mcp.credential.button` / `mcp.credential.buttonHint` 三键与 `.mcpActions` 已一并删除,
   不要再按"行内按钮"找编辑入口。
6. **客户端判"这一行开没开"有唯一入口**:`rowAllowed(enabled, suppressed)`(`src/client/mcp-row-state.ts`,不依赖
   React 的纯模块,便于单测)。规则是 **Host 明确的 `enabled: false` 优先于兜底标志 `suppressed`** —— 后者只为
   "老 bundle 下被 hold 的行也报 false"这种情况留的后路,绝不允许把用户停用的行重新显示成已启用(易崩第 43 条)。
7. **状态徽标只在有话说时出现**(`statusOf`):配置不完整、`conditional`、以及可操作的 fiber 相位才带徽标;
   **渲染了开关的行不再重复标「已禁用」** —— 开关自己就是那个状态,54 行挂 54 个一样的徽标只是噪声(D15 对
   `pending`/`held` 已经这么判过,这里是同一条规则的延伸)。没有开关的行(无 Loader id、只读行)仍要标。
   **行右侧的顺序固定为「状态 → 平面标记(全局标签 / 预设名)→ 开关」**(2026-10-16 第三轮与用户调换,见 D26):
   状态是唯一"有时没有"的元素,原先夹在平面标记与行按钮之间,它一出现就把同一行别的元素推位,几行并排看就是没对齐;
   平面标记贴住恒渲染的开关,行与行的右端才落在同一列。**平面标记是 tab 样式的芯片**(`.rowScope`,第四轮按用户要求
   从"`Tag` + 纯灰字"改成两者同一个芯片:R12 + `--dsw-alias-border-l3` 细线 + `--dsw-alias-bg-layer-3`,即宿主页签
   选中态那套 token),**右侧那一组上下居中**(`.mcpRight { align-self: center }`;容器 ≤480px 的堆叠布局里必须改回
   `align-self: stretch`,否则那组缩成内容宽、开关离开右缘)。
8. **描述是内容不是空字段**(`McpDescription`):静止时渲染成无边框文本(空值显示「添加描述」),点击才变成真正的
   input;它进系统提示、按 `MAX_DESCRIPTION_CHARS`(从 `src/mcp-inventory.ts` 导入,不复制常量)截断,所以
   **超预算时才就地提示**,不在 54 行上各显示一次占位符。
9. **新增表单的必填与自动填**(2026-10-16 第四轮,见 D28):只有**服务器名**与**JSON 配置**是真的不能空,标签后
   用 `.requiredMark` 渲染 `*`(`aria-hidden`,语义靠控件上的 `aria-required="true"`;**不要**把 `*` 写进字典文案)。
   能默认就默认:落点下拉默认在名册筛到的预设上,JSON 框带 stdio 骨架,**服务器名在用户没碰过这个字段时由 JSON
   现推**(`serverNameFromSpec`:stdio 取第一个非 `-` 开头的参数,取不到而命令又不是 `PACKAGE_RUNNERS` 里的启动器
   才退回命令本身;HTTP 取主机里第一个非通用标签的 label;IP 与不可解析的 URL 一律不给名字)。**用户一旦在这个
   输入框里改过,就再也不自动填** —— 名字是行的主键,不能被一次粘贴顺手改掉。推断规则只有一份,在
   `src/mcp-spec.ts`,回归测试 `tests/mcp-spec.spec.ts`。
9. **名册有按名字/描述的筛选框**,与预设下拉同一行:它是视图,不改任何计数口径。标题旁的计数在不筛选时报
   `{n} 行 · 已启用 {m}`,筛选时报 `匹配 {n} / 共 {m} 行`;分组标题只报**本组渲染出来的行数**。
   **计数不再复述预设名**(`mcp.count.narrowed` 的 `· 筛选：{name}` 后缀已于 2026-10-16 删除):下拉本身
   就显示当前取值,再在计数里念一遍是同一串文字在一屏出现两次。
10. **Agent 行按预设过滤**:预设一多,54 行那种列表就没法看。**选项是全部已声明预设**(持有行的按行数降序在前,
   0 行的也在,因为新增行要写进其中一个 —— 选项与受控值必须来自同一份集合,否则 0 行的预设选不中),不用另一个
   RPC 拉预设列表;预设名在同一次 `listMcps` 里带着,不必再读一次。`全部 Agent 预设`用空串当哨兵值(预设 id 非空),
   下拉的 `value` 与列表共用同一个校验后的值 —— 名册刷新后选中项消失时回退到"全部",不会留下一个空列表,也不会
   出现"下拉显示 A、列表渲染 B"。规则在 `src/client/agent-filter.ts`(纯函数),回归测试见 `tests/agent-filter.spec.ts`。
   下拉里**不再带计数**(计数曾经同时出现在下拉选项和分组标题里,同一串文字在一屏里出现两次)。
11. **工具列表给的是 token,不是"可不可用"**(`McpEditor` 的工具列表页,2026-10-16 第五轮,见 D30):每行右侧显示
   该定义估算的 token(`mcp.form.toolTokens` = `≈{n}`,tabular-nums + `margin-left: auto` 成列);提示句是
   `mcp.form.toolsHint`(「取消勾选则不加载进上下文：当前加载 ≈{n} token，取消 ≈{m} token。」),两个数分别是
   **勾选与未勾选定义之和**,与新值同一份估算。**估算规则只有一份**:host 侧 `src/mcp-tokens.ts` 的
   `estimateToolTokens` 在**列出的那一次**算好、随 `McpToolRow.tokens` 下发(浏览器拿不到 schema,也不许重算);
   口径是"定义序列化后的文本,约 4 字符/token,CJK 约 2 字符/token",界面上一律带 `≈`,**不要**写成精确值或字节数。
   **工具页签没有"加载"按钮**:进页签(`pickTab('tools')`)就是列举的触发点,新增与编辑两种模式都列举;表单
   (JSON 或服务器名)自上次列举以来变过才重列(`listedFor` 记的是"命名空间 + spec"),没变就保留现有列表 ——
   列举会真连一次(stdio 会起子进程),**不要**每次进页签都连。`.toolsHead` **始终渲染且带 `min-height: 28px`**,
   计数与「全选/全不选」只在有列表时出现,所以下面那行说明不会因为按钮出现/消失而上下跳。
   加载态是**面板中间**的 `.toolsLoading`(转圈 + `mcp.form.toolsLoading`,`role="status"`),**不要把等待塞回
   按钮文字里**(按钮已经没有了):换字会把上方那行提示挤动,而它在等待期间必须原地不动;转圈动画在
   `prefers-reduced-motion: reduce` 下关闭。
12. **JSON 文档的校验结果是字段自己的,不是表单的**(2026-10-16 第六轮,见 D31):`JSON 配置` 读不出来（不能解析，
   或传输结构不完整）时，消息显示在该字段**标签行上、标签右侧**（`.fieldError` + `role="alert"`），并置
   `aria-invalid`；**不要**放回表单底部那条共用错误行，也**不要**放到文本框下方 —— 弹窗内容区会滚动，实测那里的
   消息会被下边缘裁掉。**判定时机是失焦**（`onBlur` 调 `jsonProblem`，`onChange` 只清掉上一次结论），**不要**
   逐键判：写一半的文档是编辑常态。落点不可用、缺服务器名、Host 拒绝这些仍走表单自己的错误行；只有 Host 能回答的
   `${env:…}` 引用不在这里判（D15）。在工具列表页点「加载工具列表」而文档读不出来时，结论同样落到该字段并
   **切回「配置」页签**（旧行为是报成工具列表页的连接错误）。

### 界面规范与状态反馈(src/client/McpSection.module.css、src/client/config-issues.ts)

设置区是宿主设置弹窗里的**一列**,不是一级页面——面板宽度(800px)、左侧导航(188px)与内容区 24px 内边距都由
`ui-settings-general` 的 shell 拥有,本包的 CSS 只管这一列自己的阅读宽度与行内控件。标准见仓库根 AGENTS.md
「插件 UI 规范」,实现按下面几条固化:

1. **列几何。** `.section` 用 `container: mcp-manager / inline-size` + `max-width: 760px`,与宿主
   `ui-settings-plugin-inventory` 的设置区同款;`@container (max-width: 480px)` 才把行改成上下堆叠、
   下拉与筛选框各占整行。**断点必须按容器写**:窗口级 `@media` 在这个列上永远不成立(面板固定 800px、
   内容列约 564px),旧代码用 `@media (max-width: 760px)` 隐藏分组提示,结果是提示在最需要收起的宽度下
   一直显示。**不要套一级页面那条 `calc(960px + 2 * clamp(24px, 4vw, 48px))`** ——设置弹窗的内容列正常只有
   约 560px,套上去会与 shell 已有的 24px 内边距叠加。窗口级规则只有两条:`@media (max-width: 600px)` 把文本输入
   (描述框、筛选框、JSON 框、下拉)提到 16px/24px 免得 iOS 聚焦缩放;`@media (pointer: coarse)` 把行抬到
   44px 触摸目标,并把描述文本按钮抬到 32px(它静止时只有一行字高)。窄屏靠**堆叠**而不是隐藏元数据,所以没有
   需要移出网格与焦点顺序的隐藏控件。
2. **滚动归列表。** `.section` 以 `height:100%` 使用宿主 `.options` 已限定的内容高度；活动 `.tabPanel` 与 `.rosterBlock` 均 `flex:1` + `min-height:0`。页头、页签、服务器标题/新增、提示和筛选保持自然高度，不在 `.rosterBody` 内；只有永远挂载的 `.rosterBody` 滚动，loading/error/list/refreshing 都在其中。刷新不重建滚动节点；设置页签自行滚动，隐藏页签保留 `display:none`。使用宿主滚动条变量补偿 rail，保留卡片焦点环安全间距；不写宿主 hashed selector，不用固定 viewport offset 或列表 max-height。
3. **层级:页头 16/24/500 + 一行 14/22 说明,块标题 14/22/600,行名 14/22/600(代码字体),元数据/说明
   12/18 三级色。** 「服务器」/「设置」两个页签是页面级的 `SegmentedTabs`,**占满整列宽度、两个页签各占一半**
   (2026-10-16 第三轮按要求去掉原先 320px 的宽度封顶与 `align-self: flex-start`;`box-sizing: border-box`
   保留,否则 8px 内边距会把宽度顶破);同一面里的块标题与页签不要同款,`SegmentedControl`
   只在块内用(加载方式)。
3. **控件与材质。** **两类表面按角色分开**:名册的实体行是设置卡片(`--dsw-radius-xl` +
   `--dsw-alias-settings-card-fill`/`-stroke`,不加阴影);「上下文」那一面的偏好行按宿主设置行recipe ——
   `padding: 14px 0` + `border-bottom: 0.5px solid var(--dsw-alias-border-l2)`,组内最后一行去掉分隔线,
   控制件靠右、文字列 `padding-right: 24px` 换行。状态的块(目录缓存)才用 `--dsw-alias-bg-layer-1` +
   `--dsw-elevation-stroke` + R16,与设置行区分开。按钮、标签页、开关、分段控件一律用
   `@deepseek-ai/dsh-client-ui-primitives`。加载方式用 `SegmentedControl`,页面页签与编辑器分区用
   `SegmentedTabs`;每个分段 `aria-controls` 指向的面板都要真实存在(未选中的挂 `hidden`,并且自绘
   `display` 的容器必须补 `.panel[hidden] { display: none }`,否则 `[hidden]` 会被自己的 `display: flex` 盖掉)。
   按钮只有 `sm`=28px 与 `md`=36px 两档:**标准里的 32px 档在这套 primitives 里没有对应变体,弹窗按钮保持
   `sm`**,不要为此手写 32px 高度。字号成对:能用角色 token 就写 `font: var(--dsw-font-*)`,代码文本写
   `font: 12px/18px var(--ds-font-family-code)`;**禁止只写 `font-size`**。焦点环统一
   `outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))`
   (`--dsw-focus-ring-color` 在指针模态下解析为 `transparent`,fallback 是必需的)。**当前安装的 ui-primitives
   没有导出 `Select`**,下拉仍是原生 `<select>`,样式按 36px/R12 手写。
3. **异步操作都有进行中/成功/失败三态,不是只把按钮变灰。** 加载方式:进行中在控件下方显示 `mcp.mode.saving`,
   成功进共享 `notice`,失败显示 `mcp.mode.saveFailed` + 重试(用同一个 mode 再提交一次)。行开关:进行中显示
   「启动中/停止中」,成功进 notice,失败**留在该行内**显示原因 + 重试。失败后**保留名册**:`finally` 里只刷新,
   失败记录只在该行成功时删除,所以刷新不会抹掉提示;`disable` 永远允许(起不来的行必须能关掉)。
4. **首屏骨架、刷新不清空。** 首屏是三张卡片形状的骨架(`--dsw-alias-bg-skeleton`,脉冲在
   `prefers-reduced-motion` 下关闭),`role="status"` 的无障碍文本放在骨架容器之外。刷新沿用上一版名册,并把
   busy/失败/成功提示放在**列表下方**——插在列表上方会让正在读的行整体位移、滚动位置跟着跳(宿主 `.options`
   是滚动容器,列表不重挂时滚动位置自然保留)。空态给出「为什么空 + 下一步」两行,不只是一行灰字。
5. **诊断文案进字典。** `diagnoseMcpConfig` 的 `reason` 是 Host 侧英文,会经名册读回与保存校验变成用户可见文本。
   浏览器侧统一走 `src/client/config-issues.ts` 的 `formatMcpConfigIssues(issues, t)`:按 `kind` 取本包字典
   (中英同步),把 `names` 填进 `{names}`/`{name}`;`reason` 只在 kind 未知时兜底。**新增 `McpConfigIssueKind`
   时同时补字典键**,否则那一类问题回退成英文。
6. **约束由测试守住。** `tests/client-css.spec.ts` 断言:TSX 里 `css.X` 引用的类必须在
   `McpSection.module.css` 里定义、CSS 里的类必须被引用(防静默无样式)、无字面量颜色与颜色 fallback、
   字号成对、圆角在刻度内、焦点环带 fallback、中性描边 0.5px;`tests/config-issues.spec.ts` 覆盖诊断文案。
   CSS 字符串断言**不能**替代浏览器里的盒子测量。

## MCP JSON 兼容

### 解析器只有一份(src/mcp-spec.ts)

编辑器的 JSON 框读的是 Claude Code 那批形状,所以**推断规则只实现一次**:

- 省略 `type`:有 `command` → stdio;有 `url` → streamable-http。
- `{ "<name>": { … } }` 单键映射、`{ "mcpServers": { … } }` 包装 → 用 key 当 `serverName`(标题字段为空时)。
- 裸 spec `{ type, command, args }` → `parseSpecText` 不给名字,需要名字时用 `serverNameFromSpec` 现推
  (`@upstash/context7-mcp` → `context7`),见 D28。

`McpEditor.tsx` 曾经自带一份 `parseSpec`/`specFromObject`;两份实现必然漂移(表现为"弹窗收得下、别处却拒绝"),
所以提取成了共享模块。**改推断规则只改 `src/mcp-spec.ts`。**

## 已删除:导入 Claude 配置(2026-10-16,D29)

「导入 Claude 配置」整条链路已按用户要求删除:`src/claude-import.ts`(只读扫描)、`mcp-remote.ts` 的 `addMcps`
与 `scanClaudeMcp` 两个 Remote(以及批次写入的 `writeGlobalBatch`/`writePresetBatch`/`PlannedRow`)、
`src/remote.ts` 的两个 descriptor、`src/client/ClaudeImportDialog.tsx`、`src/types.ts` 的批次与 Claude 类型、
`mcp.import.*` 全部字典键、`.import*` 全部样式、`tests/claude-import.spec.ts`,以及名册工具栏的「导入」按钮。
**不要再照着旧文档把它加回来**:要恢复就先补一条决策记录(D29 的反向决策)并说明为什么。
