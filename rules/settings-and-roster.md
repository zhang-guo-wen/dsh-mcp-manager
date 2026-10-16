> 覆盖：`mcp-manager` 设置命名空间与畸形值收敛、配置诊断、名册读取(声明 vs live)、全局平面与行级可写判据、MCP 行的两条写入路径、设置页分区、MCP JSON 推断规则、Claude 配置导入。何时读：改设置页、名册、行写入、配置诊断、spec 解析或导入时。

# 设置页：命名空间、诊断、名册、写入与导入

## 设置命名空间(src/settings.ts)

`mcp-manager` 命名空间属于本插件,字段四个:`loading`(加载模式)、`descriptions`(行描述)、
`tools`(每行工具过滤规则)、`optimize`(上下文预算策略,见「优化策略」)。键统一是
`mcpRowKey(target, serverName)`(`preset:<id>:<name>` / `global:<name>`),`optimize` 例外——它是全局策略,不分行。

**schema 用 `z.dict(z.any())`,不要在设置 schema 里校验规则。** 设置由用户手写在 active profile 的 `cordis.patch.yml` 里,
schema 拒绝一个字段会让**整个 `mcp-manager` 命名空间**回退到上一次好的值(warn 后静默失效),
所以畸形值必须在读取时收敛:`parseMcpToolFilter` 跳过无法解析的条目,空规则不过滤任何东西,
`parseMcpOptimizeFlags` 把每个 `optimize` 字段收敛到默认值(越界数字夹到区间,类型不对取默认)。

## MCP 行编写(src/mcp-authoring.ts)

MCP 行有两种来源,更新路径不同:

- **全局**:改 file-backed Include 的**文件**,再 `Include.refresh()` 让组合重读并重新套用补丁层。
  **绝不能用 `loader.create`/`loader.update` 写全局行** —— 那会走 `EntryTree` 的写回,`Include.write()`
  把**带过补丁的树**序列化回文件,bundle 层与用户补丁层就被拍平进用户文件了(这正是旧版把全局判为只读的理由)。
  文件里永远只有用户自己的行;`refresh()` 之后的活行才是最终结果,写一次就当场生效,不需要重启。
  另注:`loader.resolve` 看不到 Include 的子行(它只走根 store),所以按叶子 id 或限定 id 在 `tree.entries()` 里找
  (见 `globalMcpEntry`)。可写目标是 `writableGlobalIncludes` 选出的**用户自己的** Include:宿主的 **root anchor**
  (`app-boot` 的 Loader id `include` → `$DSH_HOME/profiles/<profile>/cordis.yml`,`prepareProfile` 每次启动重写成
  空模板)**一律排除**(判据与后果见「名册读取」)。写入是**整表序列化回文件**:功能正确,但会丢注释、规范引号、
  并在启用后留下显式 `disabled: false`(实测 1247B → 942B),**不回到逐字节原样** —— 已知限制,是否改成
  "只改该行的 `disabled` 键"待定。
- **preset(agent)**:改 **profile patch 里那条 preset 声明行**的 `config.plugins`,经 `configEditor.edit` 写。
  写入本身就是生效:editor 落盘后 reconcile 该 entry,声明行重建、按 diff 挂/摘改动的那一行。
  **不要再写 `agent.cordis.yml`,也不要再调 `tree.refresh()`/`standingKeyFor`** —— 目录预设与增量 refresh
  的契约在 0.1.7 已随 "declare Agent compositions in profile YAML" 一起移除。

**一次写入 = 一次 preset 重挂。** 写 preset 会让整条声明行重建,该 preset 里**每个** MCP 行都会重新挂载并重启
子进程(`npx -y` 那种 7.5–23 秒,实测)。所以批量场景走 `addMcps`(一次 patch 提交多行,逐行校验、逐行报结果),
不要循环调 `addMcp` —— 导入 4 台就是 4 次全量重启。

开关 MCP 时 UI 用**行级乐观状态**(`启动中`/`停止中`)+ 后台异步,不要锁整列表。
启用本质要等 MCP 子进程启动(`npx -y …` / `uvx …` 通常 1-3 秒),那是进程启动耗时,不是插件开销;
用直接可执行文件替代 `npx -y` 能显著缩短。

**新版 registry 已移除 `livePresetMounts`，不能再静态或动态依赖它。**
`src/preset-mounts.ts` 从公开 Loader entry 的 `parent.tree` 定位 detached 树，再用经 loader 内部解析的
scope 帮助函数与 `agentPresets.composedPreset` 读取代次身份。短命空 scope 探针马上销毁，不重组真实 Agent，
不读 registry 私有 generations/bindings。root-local weak state 保存每代的原始禁用元数据，避免 manager-only
HMR/关闭再启用把旧 suppression 当成用户禁用；树销毁后不强持有它。

当前声明的编写与未挂载名册仍由 `configEditor`(`ctx.get('configEditor')`)提供，见 `src/preset-source.ts`。
运行时 gate/按需加载读每代快照，不拿最新声明覆盖旧会话；不调用等待激活的 `compositionInventory()`。
实现理由和替代方案见 `docs/design-decisions.md` D14。

## 配置诊断(src/mcp-diagnostics.ts、src/mcp-variable-refs.ts)

**「按需可用」不是状态,「配置不完整」才是。** 早期版本在 `dynamic`/`lazy` 下给每一行都标「待加载」——
那是模式的必然结果,等于给整张列表加噪声,而真正需要用户动手的"少填了东西"被淹没。现在只有配置不完整
才显示标记(`mcp.status.unconfigured`),并按下面的口径拦截。

判定三类,纯函数、环境由参数传入,所以 vitest 直接跑:

| kind | 判定 | 保存时 | 之后 |
|---|---|---|---|
| `missing-command` / `missing-url` | `command` 或 `url` 为空 | **拒绝** | —— |
| `unsupported-config` | transport 无法识别,或声明连 spec 都解析不出 | **拒绝** | —— |
| `unreachable-variable` | `${env:NAME}` 在本进程解析不出(未设或空白) | 接受 | 保持「未配置」,不许开启 |
| `empty-credential` | credential 形状的 `env`/`headers` 键存在但值为空 | 接受 | 保持「未配置」,不许开启 |

- **`${env:NAME}` 是 `dsh-resource-manager` 已有的拼写**,不要发明第二套:`resolveMcpVariables` 用它解析资源
  MCP,而且**变量缺失的资源 MCP 根本不会交接**给本插件。本插件只**诊断**这个引用,不解析、不管理变量。
- **两条输入形状都要认**:preset 声明里是 Claude spec(`command`/`url`,常无 `type`),全局行与托管行是归一化
  的 `mcp-client` config(`transport`)。`diagnoseRowConfig` 用 `specFromObject` 归一再判定;`specFromObject`
  的推断规则只有一份(见「MCP JSON 兼容」)。`diagnoseMcpConfig` 只管已归一的 config。
- **三个拦截点**:gate 不挂载 preset 行;`mcp_load` 在 `describeRow` 之后报出原因;`mcp-remote.ts` 的
  `assertRunnableConfig` 在**开启**开关时拒绝(`disable` 永远允许,否则起不来的行会无法移除)。
- **浏览器没有环境**:编辑器只把结构性错误挡在保存前,变量类问题由 Host 在名册读回时判定;保存成功但尚未完整
  时,弹窗用 `mcp.form.pendingConfig` 说明该行为何还不能开启。所以 `diagnoseMcpSpec` 的 `env` 是**必填参数**,
  客户端显式传 `{}`;`mcp-variable-refs.ts` 不引用 `process.env`,才能安全打进浏览器包。
- **全局行的配置问题只能标记**:全局行的树是 file-backed `Include`,闸门不读它们的配置(性质 1:不写声明),
  所以配置不完整的全局行表现为「未配置」+ 开关不可开,而不是按配置判据摘除。它是否挂载只由**加载模式**决定
  (见「预加载闸门」),两件事在 UI 上分别是「未配置」与不显示标记。

## 名册读取(src/mcp-roster.ts)

设置页的名册走**插件自己的** `mcpManager.listMcps`,**不要**改回 `remote.pluginInventory.list`。
后者走 agent-preset registry 的 `compositionInventory()` → `diagnostic()` → `auditRows()`,而 `auditRows`
会 `tree.await()` + 逐行 `fiber.await()`;MCP 行的 `apply` 要等子进程握手,`npx -y` / `uvx` 启动在本机实测
7.5–23 秒,所以那次读取会让整个设置页(以及每次新增/开关/导入后的刷新)卡住那么久。

`readMcpRoster(ctx, mountReader, heldEntryIds, globalRows)` 只读**声明 + live fiber**,不 await 任何激活:

1. **全局行**由 `gate.globalRows()` 提供(行在 Include 子树里,不在 Loader 根,见「预加载闸门」):`enabled` 取
   `entry.options.disabled !== true`(声明,不是被 gate 遮蔽的实例 getter),`fiberPhase` 由 `mounted` 推出,
   `held` 标记当前是否被拦截。**同一次读取必须按 entryId 去重** —— 既扫 Include 子树、又扫根 `loader.entries()`
   时,2 台全局行会被读成 8 条(verify-instance 报的重复现象);根扫描只作为"直接挂在根上的 mcp-client 行"的
   兜底,已由 `globalRows` 报出的 entryId 不再计入。
2. **preset 行**优先取 live mount 树的 entry(拿 `entry.fiber.state`),**但 `enabled` 取该代次声明**,
   不是 live 行的 `!entry.disabled`。preset 没挂载时退回声明,并按 Loader 的规则继承 group 的 `disabled`;
   `!!js` 在挂载外无法求值,一律报 `conditional` 而不是猜。
   **声明的来源有两级**:首选 `configEditor` 的 `listPresetDeclarations`;`configEditor` 缺失时(测试 harness、
   只读宿主)回退到 **live mounts 的 `presetId` + 捕获到的 `declaration`**,同一代次同样给出声明性答案。
   **live 行的 `disabled` 是 gate 自己的产物** —— `dynamic`/`lazy` 下 gate 真的会把每个 allowed 行设成 disabled,
   把它当成用户意图会让整个 preset 平面显示成"已禁用"(实测回归:宿主未重启 + 新 client 时整列变「已禁用」)。
   声明才是"用户允不允许"的答案;live 只提供 fiber 相位。
   **被抑制的行(两个平面、三条路径)不能报成"已停止"**:`readMcpRoster(ctx, mountReader, heldEntryIds)` 收
   `gate.suppressedEntryIds()`,把命中的行报成 `fiberPhase: 'held'`(它同样只是 `dynamic`/`lazy` 的产物,
   UI 对它不显示任何标记,见 D15)。
   **注意这是两个问题,别合并**:`gate.suppressedKeys()` 回答的是"模式正在扣住一个**用户允许**的行",只作设置页的
   兜底标志,且**被用户停用的行必须退出它**;`gate.suppressedEntryIds()` 回答的是"闸门此刻实际扣住了哪些行",
   名册据此报 `held`。把前者当用户意图的后果是:运行中停用一行后开关仍显示"已启用",再点只是把 `disabled: true`
   重复写一次(幂等 no-op),只有重启实例才显示正确(易崩第 43 条)。
3. **同一批返回 `globalWritable`**:设置页必须在用户填完表单之前就说明全局平面能否写入。判据只有一条 ——
   组合里是否**恰好挂着一个用户自己的 file-backed Include**(`writableGlobalIncludes`,见下)。

**全局平面的可写判据必须排除宿主的 root anchor Include。** `app-boot` 固定 Loader id `include`,指向
`$DSH_HOME/profiles/<profile>/cordis.yml`,而且 `prepareProfile` **每次启动都把它重写成空模板**;把它算进来,
"profile 自己声明了一个 Include"的组合就会被读成"两个 Include",整个平面被判只读(本轮修掉的 bug)。排除之后:
**推荐形状 A(全局行写在自己的 Include 文件里)现在是 `globalWritable=true`,设置页能真正开关全局行**;
只有 anchor → 平面只读(`no-writable-include`);≥2 个用户 Include → 仍拒绝(`several-writable-includes`,定不出文件);
唯一那个 Include 的文件读不出 → `unreadable-include`。这些原因在行上以 `readOnly` 报出。

**行级可写是第二个判据(平面可写 ≠ 这一行可写)。** global 行**只有**在该行 id 出现在那个可写 Include 的
**文件行**里时才可写(`mcp-authoring.ts` 的 `readEntryListRowsSync` + `findEntryRows`);由组合或补丁层声明、
文件里没有对应行的行恒为只读,报 `readOnly: 'composed-row'`。客户端据此把开关与「编辑」**置灰并给出原因**,
服务端同时以 **`mcp/read-only`** 拒绝(双保险;写前校验,否则补丁层声明的行会先撞上误导性的 `mcp/not-found`)。
形状 B(行写在组合本身里)照旧能按需加载、池复用、`eager` 挂载,只是设置页不能开关或编辑它。

**全局写入是整表序列化回文件。** 功能正确(`disabled: true` 确实被移除),但会丢掉用户手写 Include 文件里的
**注释**、规范化引号风格、并在启用后留下显式的 `disabled: false`(实测 1247B → 942B)——**不回到逐字节原样**,
这是一条已知限制;是否改成"只改该行的 `disabled` 键"待定,文档里如实记着(见「MCP 行编写」)。

**设置页刷新时保留已渲染的名册**,不要退回 `loading`:读取本身很快,清空列表只会让页面闪。

## 设置页分区(src/client/McpSection.tsx)

名册是**一个列表**,两个平面用列表内的分组标题分开,全局恒在最前 **(2026-10-16 起不再有平面 tab)**。五条约束:

1. **全局分组恒在最前、永不被过滤掉** —— 会话带着它的全局行,不管跑哪个预设;预设下拉只收窄 agent 行。
2. **全局分组标题旁要说明"全局行同样跟随加载方式"**(`mcp.plane.global.eager`;`<=760px` 隐藏):`eager` 下由组合直接挂载,`dynamic`/`lazy` 下启动不拉起、可用 `mcp_load` 按需加载并与其他会话共用同一条连接;工具过滤对全局行**仍然不生效**(见「工具过滤」第 3 条)。**不要再写"全局行始终加载 / 不受加载模式影响"** —— 那是本轮之前的行为。
3. **加载方式选择器对两个平面都生效**(它下面就是那个统一列表):它决定的是 preset 行的进上下文时机,放在全局 tab 会暗示它对全局行有效。
4. **写入目标跟着用户最后的选择**(`McpEditor` 的 `plane` 入参,`editorTarget()`):编辑某行 → 该行自己的平面;预设下拉选了一个预设 → agent 平面,弹窗只保留"Agent 预设"下拉以便多预设时挑一个,没有可写预设时禁用保存并说明。**编辑**时范围来自被编辑行自身,所以只读显示那一行,不给下拉。两个 tab 的"新增/导入"与行操作在**该平面不可用时**禁用(全局:没有唯一的 file-backed Include;原因放按钮 `title`),不要放进弹窗再失败。
5. **行级只读要真的置灰**:名册行带 `writable` / `readOnly`(全局行的 `composed-row`、平面的 `no-writable-include` / `several-writable-includes` / `unreadable-include`),开关与「编辑」按钮据此禁用并把原因写进 `title` / 提示位;不要只靠服务端拒绝,也不要把禁用的按钮留在可点击状态。
6. **客户端判"这一行开没开"有唯一入口**:`rowAllowed(enabled, suppressed)`(`src/client/mcp-row-state.ts`,不依赖 React 的纯模块,便于单测)。规则是 **Host 明确的 `enabled: false` 优先于兜底标志 `suppressed`** —— 后者只为"老 bundle 下被 hold 的行也报 false"这种情况留的后路,绝不允许把用户停用的行重新显示成已启用(易崩第 43 条)。
7. **Agent 行按预设过滤**:预设一多,54 行那种列表就没法看,所以工具栏有一个下拉。**选项是全部已声明预设**(持有行的按行数降序在前,0 行的也在,因为新增行要写进其中一个 —— 选项与受控值必须来自同一份集合,否则 0 行的预设选不中),不用另一个 RPC 拉预设列表;预设名在同一次 `listMcps` 里带着,不必再读一次。`全部 Agent 预设`用空串当哨兵值(预设 id 非空),下拉的 `value` 与列表共用同一个校验后的值 —— 名册刷新后选中项消失时回退到"全部",不会留下一个空列表,也不会出现"下拉显示 A、列表渲染 B"。分组标题上的计数是该分组的行数。规则在 `src/client/agent-filter.ts`(纯函数),回归测试见 `tests/agent-filter.spec.ts`。

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
6. **导入目标跟着设置页当前 tab 走**,弹窗里不再有独立的"导入到"选择:全局 tab → 全局平面(只读显示一行
   `全局`);Agent tab → 只列**预设**的下拉(多预设时挑一个,默认第一个)。没有可写预设时禁用导入并说明。
   平面本身不可用(没有唯一的 file-backed Include)时,工具栏的"导入"直接禁用(原因放 `title`)。
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
