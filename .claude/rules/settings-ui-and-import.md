---
paths:
  - "src/mcp-spec.ts"
  - "src/mcp-remote.ts"
  - "src/claude-import.ts"
  - "src/client/McpSection.tsx"
  - "src/client/McpSection.module.css"
  - "src/client/config-issues.ts"
  - "src/client/mcp-row-state.ts"
  - "src/client/agent-filter.ts"
  - "src/client/ClaudeImportDialog.tsx"
  - "src/client/settings-controller.ts"
---

> 覆盖：设置页分区（全局分组恒在最前、加载方式选择器、写入目标、行级只读置灰）、MCP JSON 推断规则、导入 Claude 配置（自原「设置页：命名空间、诊断、名册、写入与导入」拆出）。何时读：改设置页布局与交互、spec 解析或 Claude 配置导入时。

# 设置页分区、MCP JSON 与导入

## 设置页分区(src/client/McpSection.tsx)

一个 `settings.section`(id `mcp-manager`,order 14)承载插件的两面,**页内用 `SegmentedTabs` 分「服务器」/「设置」**
(2026-10-16 起两页合并;此前是第二条 `settings.section`,order 15 与内置插件区撞号、在侧栏里排不到一起,
被读成"同一个插件两个页面";同日第二轮把第二个页签从「上下文」改名「设置」并把加载方式移进它)。
名册是**一个列表**,两个平面用列表内的分组标题分开,全局恒在最前 **(更早一轮已不再有平面 tab)**。约束:

1. **全局分组恒在最前、永不被过滤掉** —— 会话带着它的全局行,不管跑哪个预设;预设下拉只收窄 agent 行。
2. **开关的语义不再用一句页内说明讲**(`mcp.list.hint` 已于 2026-10-16 删除):`dynamic`/`lazy` 下开关打开**不等于**
   启动,何时进上下文由「设置」页签的加载方式决定(决策 D1);这个区分现在只由两处控件自身的标签与所在页签承载,
   要恢复一句说明就加回去,但**不要再写"全局行始终加载 / 不受加载模式影响"** —— 那是更早之前的行为。
   全局分组的空态只留一句(`mcp.empty.global.hint`:对所有会话可用、工具过滤不生效)。
3. **加载方式在「设置」页签,排在策略行之前**:块标题旁写明生效时机(`mcp.mode.when`:立即生效、会重建工具面并可能释放连接)。
   它不随名册页签走 —— 这是页级偏好,不是列表的属性。
4. **写入平面由创建它的弹窗自己选**(`McpEditor` / `ClaudeImportDialog` 的 `plane` 入参只是**初值**,两个弹窗各自
   有 `配置范围` / `导入到` 下拉):编辑某行 → 该行自己的平面,弹窗只读显示;新增/导入 → 下拉里选 全局 / Agent 预设,
   预设那档再选一个预设。**不要再把写入平面做成页面级状态**:单列表改版删掉平面 tab 之后,`writePlane` 只能靠
   "编辑一条已有全局行"赋值,于是全局分组为空时**写入全局在界面上不可达**;而默认停在"全部 Agent 预设"又让
   `needsPreset` 把新增/导入两个按钮在首屏就禁用、原因只写在 `title` 里。平面不可用时那一档在下拉里禁用并写明
   原因(`mcp.global.unavailable`),两个平面都不可用才禁用保存(`mcp.form.noTarget`)。空态里的「新增到全局 /
   新增到 Agent 预设」按钮只在**该平面真能收下这一行**时出现。
5. **行级只读要真的置灰**:名册行带 `writable` / `readOnly`(全局行的 `composed-row`、平面的 `no-writable-include` /
   `several-writable-includes` / `unreadable-include`),开关与「编辑」按钮据此禁用并把原因写进 `title` / 提示位;
   不要只靠服务端拒绝,也不要把禁用的按钮留在可点击状态。
6. **客户端判"这一行开没开"有唯一入口**:`rowAllowed(enabled, suppressed)`(`src/client/mcp-row-state.ts`,不依赖
   React 的纯模块,便于单测)。规则是 **Host 明确的 `enabled: false` 优先于兜底标志 `suppressed`** —— 后者只为
   "老 bundle 下被 hold 的行也报 false"这种情况留的后路,绝不允许把用户停用的行重新显示成已启用(易崩第 43 条)。
7. **状态徽标只在有话说时出现**(`statusOf`):配置不完整、`conditional`、以及可操作的 fiber 相位才带徽标;
   **渲染了开关的行不再重复标「已禁用」** —— 开关自己就是那个状态,54 行挂 54 个一样的徽标只是噪声(D15 对
   `pending`/`held` 已经这么判过,这里是同一条规则的延伸)。没有开关的行(无 Loader id、只读行)仍要标。
8. **描述是内容不是空字段**(`McpDescription`):静止时渲染成无边框文本(空值显示「添加描述」),点击才变成真正的
   input;它进系统提示、按 `MAX_DESCRIPTION_CHARS`(从 `src/mcp-inventory.ts` 导入,不复制常量)截断,所以
   **超预算时才就地提示**,不在 54 行上各显示一次占位符。
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
2. **层级:页头 16/24/500 + 一行 14/22 说明,块标题 14/22/600,行名 14/22/600(代码字体),元数据/说明
   12/18 三级色。** 「服务器」/「设置」两个页签是页面级的 `SegmentedTabs`,宽度封顶 320px(带
   `box-sizing: border-box`,否则封顶值会被 8px 内边距顶破);同一面里的块标题与页签不要同款,`SegmentedControl`
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

编辑器的 JSON 框与 Claude 配置导入读的是同一批形状,所以**推断规则只实现一次**:

- 省略 `type`:有 `command` → stdio;有 `url` → streamable-http。
- `{ "<name>": { … } }` 单键映射、`{ "mcpServers": { … } }` 包装 → 用 key 当 `serverName`(标题字段为空时)。
- 裸 spec `{ type, command, args }` → 从参数推断 `serverName`(如 `@upstash/context7-mcp` → `context7-mcp`)。

`McpEditor.tsx` 曾经自带一份 `parseSpec`/`specFromObject`;导入功能需要同样的规则,两份实现必然漂移
(表现为"弹窗收得下、导入却拒绝"),所以提取成了共享模块。**改推断规则只改 `src/mcp-spec.ts`。**

## 导入 Claude 配置(src/claude-import.ts)

设置页工具栏的「导入 Claude 配置」按 `scanClaudeMcp` Remote 读 Claude Code 自己的配置文件:

| 来源 | 路径 | 取法 |
|---|---|---|
| 用户级 | `~/.claude.json` | 顶层 `mcpServers` |
| 用户配置里的项目分区 | 同上 | `projects[<cwd>].mcpServers`,只取 cwd 命中的那条 |
| 设置 | `~/.claude/settings.json`、`settings.local.json` | `mcpServers` |
| 项目级 | `<cwd>/.mcp.json` | `mcpServers`,也兼容裸单键映射 |

八条实现约束:

1. **只读扫描,导入一次 `addMcps` 写完。** 扫描不挂载任何东西、不碰任何 composition;导入把选中的条目**一次**交给
   Host 的 `addMcps`,由它逐行校验、一次 patch 提交(全局:一次文件写 + 一次 `refresh`;预设:一次
   `configEditor.edit`,即**一次重挂**)。**不要循环调 `addMcp`**:每台一次就等于该 preset 全量重启一轮,
   4 台就是 4 轮,`npx -y` 那种一台 7.5–23 秒。也**不要为导入另写写入路径** —— `addMcps` 复用的正是 `addMcp`
   的校验、冲突检测与原子写。
2. **一个来源坏掉不能拖垮其它来源。** 文件不存在 → 整个来源不出现;存在但读不出/不是 JSON → 该来源带
   `problem` 返回(`missing`/`unreadable`/`malformed`/`too-large`),其余来源照常导入。
3. **名称先按 composition 规范预检。** `mcp-client` 的 `serverName` 必须匹配 `/^[A-Za-z0-9_-]{1,32}$/`,
   所以带空格或超长的名字标成 `problem: 'unsupported-name'` 并**预先不勾选**,而不是等导入时报一句
   "serverName must match …"。实测真实 `~/.claude.json` 里 `MiniMax` 合法、`my server` 不合法。
4. **一行被拒不影响其余行。** `addMcps` 返回逐行 `outcomes`(`entryId: null` + `reason`),UI 按行汇总
   「已导入 N 台,M 台失败」并逐条列出原因。**全部成功就关窗** —— 剩下的信息在设置页里(名册会刷新);有失败才留在
   弹窗里显示原因。
5. **`env`/`headers` 的值必须跟着 `spec` 走**(否则导进去的服务器连不上),但 UI 只显示键名
   (`envKeys`)。所以**不要往诊断里打 spec** —— 它带着明文凭据。
6. **导入目标是弹窗自己的字段**,不再继承页面的隐藏状态:「导入到」下拉选 全局 / Agent 预设,预设那档再列
   **预设**下拉(多预设时挑一个,默认第一个);平面不可用时那一档禁用并写明原因,没有可写预设时「导入所选」禁用
   并说明。页面级的「导入 Claude 配置」按钮只在整份文档不可写时禁用(原因放 `title`)。
7. **勾选状态只在"打开弹窗"时重置。** 同一次打开里的重扫(批次结束后的 `setAttempt`、重试按钮)必须保留用户
   自己的勾选 —— 曾经每次重扫都 `setExcluded(new Set())`,表现就是"只勾了一个,结果全部又被勾上"。工具栏要有
   `已选 {n}/{m}` 计数:默认本来就是全选,`全选` 按钮本身没有可见变化,没有计数就会被当成"点了没反应"。
   名册侧同理不能清空(见「名册读取」):`servers` 瞬时为空会让 `已存在` 的行重新渲染成已勾选。
8. **排版与重绘。** 控制行只有一条(左:写入平面/预设;右:`已选 n/m` + 全选/全不选),两组用
   `align-items:center` 对齐 —— `已选` 是裸 `span`,容器 `stretch` 会让它和按钮文字错位。卡片要带
   `mcpEditorDialog`(默认卡只有 380px,路径与说明会折成三四行)。`EntryRow` 是 `memo` 且 `toggle` 用
   `useCallback`,勾选只重绘那一行 —— 真实 Claude 配置几十台时,整列重绘是"卡"的主因。**导入期间不要在 section 上
   按条 toggle `editorBusy`**:每次 toggle 都重绘整个设置页,而遮罩的 `backdrop-filter` 得跟着重新合成,而且遮罩
   本来就挡住了 section 的点击。剩下的大头在宿主侧:遮罩的 `backdrop-filter`(`ui-primitives` 的 `Modal.module.css`,
   token `--dsw-mask-blur`)对整页做模糊,插件改不了。

`scanClaudeMcp(cwd, home?)` 的 `home` 可注入,`tests/claude-import.spec.ts` 就是靠它跑临时 fixtures;
默认取真实 `homedir()`。
