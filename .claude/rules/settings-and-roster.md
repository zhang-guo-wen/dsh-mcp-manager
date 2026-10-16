---
paths:
  - "src/settings.ts"
  - "src/mcp-authoring.ts"
  - "src/mcp-diagnostics.ts"
  - "src/mcp-variable-refs.ts"
  - "src/mcp-roster.ts"
  - "src/preset-source.ts"
---

> 覆盖：`mcp-manager` 设置命名空间与畸形值收敛、MCP 行的两条写入路径（改 Include 文件 + `Include.refresh()` / `configEditor.edit`）、配置诊断、名册读取（声明 vs live）与全局/行级可写判据。何时读：改设置命名空间、行写入、配置诊断或名册读取时。

# 设置命名空间、行编写、诊断与名册

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
