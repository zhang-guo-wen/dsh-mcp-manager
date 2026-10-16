> 覆盖：`loading` 三种模式的语义、`carrierFor` 载体选择、`native` 载体的注册契约与作用域语义、`src/mcp-gate.ts` 的三条抑制路径与归属判据、模式切换的生效语义。何时读：改加载模式、挂载时机、闸门或载体，或排查「行不挂载 / 子进程被拉起 / 切回 `eager` 不恢复」时。

# 加载模式、载体与预加载闸门

## 延迟加载(src/lazy-mcp.ts)

资源仓库 MCP 由 `src/external-mcp.ts` 的内存注册表接收：`mcpManager.replaceExternalMcps(owner, ownerCtx, rows)` / `removeExternalMcps(owner)`。它们不写组合文件；`eager` 下由管理器在提供方作用域挂载，`dynamic` / `lazy` 下进入按需清单和 `mcp_load`。Agent 行必须有真实 scope key，缺失时拒绝托管，不能降级成全局行。资源管理器仍拥有仓库同步、凭据和原始配置。

**两件事分两个开关:** composition 行上的 `disabled` = 用户**允不允许用**(禁用 = 完全不用:不进系统提示里的清单,
`mcp_load` 拒绝);`loading` 模式 = 允许的服务器**什么时候进上下文**。后者是
`mcp-manager` 用户设置(默认值取自 host 插件的 `Config`)**+ UI 三选一**。三种取值:

- `eager`:允许的行照常挂载;不注册按需工具。
- `dynamic`(默认):允许的行**默认不挂载**(见「预加载闸门」);`mcp_load` 用 MCP SDK 直连一条**共享连接**
  (宿主级常驻池,见 [rules/connection-pool.md](connection-pool.md) 的「按需连接池」),再用 harness 的适配器把**可见工具**原生注册进
  **调用方 agent 的作用域**。
- `lazy`:允许的行**默认不挂载**;**用 MCP SDK 直连、完全不注册工具**;`mcp_load` 把工具 schema 作为结果
  返回,模型用固定的 `mcp_call` 代理调用 → **工具列表永不变,请求缓存前缀零失效**。

三种取值对**两个平面**都生效:preset 行与全局行(见「预加载闸门」)。`eager` 下全局行由组合挂载;`dynamic`/`lazy` 下
启动不拉起,可由 `mcp_load` 按需加载并与其他会话共用同一条连接;工具过滤对全局行仍不生效(见「工具过滤」第 3 条)。
三种模式的取舍、否决过的替代方案,以及 Claude Code / Messages API 的延迟加载先例对照,见
[docs/design-decisions.md](../docs/design-decisions.md);本节只讲实现契约。

## 载体选择(src/mcp-carrier.ts)

**载体由模式决定,规则与「本次加载要哪些工具」只决定可见集合**(决策 D8、D16)。`carrierFor(mode, _filter, _narrowed)`:

| 模式 | 载体 | 说明 |
|---|---|---|
| `lazy` | `proxy` | 代理通道,不注册任何工具 |
| `dynamic` | `native` | 插件只注册可见工具(规则与 `query`/`tool` 只决定可见集合) |
| `eager` | `undefined` | 整台由 harness 的 mcp-client 挂载,不注册按需工具;规则不生效并 warn |

**`mount` 载体已删除。** 它把整台服务器交给 harness 的 `mcp-client` 挂进调用方 agent 作用域,而那个插件
**按挂载作用域连接**:per-session 挂载必然得到 per-session 子进程,与「一台服务器在宿主内只起一次、跨会话复用」
(见 [rules/connection-pool.md](connection-pool.md) 的「按需连接池」)不可兼得。`native` 与原生挂载共用同一个适配器,绑定质量不变。

`narrowed` 参数保留只是为了调用点兼容,**它不能改变载体**:`dynamic` 一律 `native`,所以"收窄的加载"和
"整台加载"走同一条注册路径,只差注册哪些定义。

**`native` 载体怎么工作:** SDK 直连 → `listTools` → `filterMcpTools` 只留可见的 → `nativeDefinitions` 用
harness 自己的 `createMcpToolDefinition`(`@deepseek-ai/dsh-mcp-client` 的公开根导出,经 loader 取同一实例)造定义 →
`swapNativeTools` 注册进 **`agent.ctx.get('tools')`**。三条必须记住的事:

1. **注册必须落在调用方 agent 作用域。** 用 `agent.ctx.get('tools')`,不要用插件 root ctx 上那份 —— Cordis 的
   `ctx.get` 返回 scope 绑定的可追踪代理(`reflect.get` → `getTraceable`),`this.ctx` 因此是该 agent 的 ctx,
   `register` 才落进那个层。用 root 那份会变成全局注册,工具漏给所有会话。
2. **注册代次按名字 diff 替换**(`swapNativeTools`):新增的先注册、消失的最后撤销、存活的名字保持原注册 ——
   工具列表只在服务器真的改动处变化,前缀不会因为无关工具重建而失效。任一注册失败要把本次新增的全部撤销再抛,
   与 mcp-client 的「整代或零代」一致。
3. **`tools/list_changed` 要重新同步**:SDK 没有该通知的专用 handler,它走 `client.fallbackNotificationHandler`
   (现在由池装在连接上)。重新列目录后,对**每个持有该连接的会话视图**按**加载时那套规则**重算可见集合,再换一代注册
   (`resyncView`):工具目录是连接级的,可见集合是会话级的。

**`mcp_call` 只服务 `proxy`**:其余载体的行调用它会直接报错让模型按名字调。因为 `dynamic` 下的工具是原生注册的,
它**只在 `lazy` 下注册** —— 那个模式不注册任何工具,代理是唯一的调用通道。

**工具定义用 harness 的适配器,不要自己写。** `createMcpToolDefinition` 负责上游 schema、canonical 结果校验、
`isError`、图片落盘与 PTC 投影;自己拼一个只会得到一个更弱的定义。它在老版本 harness 上不存在时,`native` 载体
**fail loud**(提示改用 `lazy`),不要静默降级。工具名必须用 `mcpToolPublicName` 复刻 mcp-client 的命名契约
(`mcp__<serverName>__<rawName>`,超长/非法字符时截断并接 12 位 SHA-256):同一个工具在不同载体下必须是同一个名字,
否则按 `mcp__<serverName>__` 前缀挂的 toolview 与命名空间都会失准。

**作用域语义(preset 行 vs `mcp_load`):** preset 平面的行是 standing mount,服务的是**该 preset 的所有会话,
以及它们的子代理** —— 子代理加入的是父的 **preset** 而不是父 agent(`applyChildComposition` 调
`agentPresets.composeFrom(childCtx, parent.ctx)`,后者落成 `bindScopeParent(agentKey, standing.key)`),
所以 preset 行的工具会顺着 preset 继承下去。反过来,`mcp_load` 挂进的是**调用方那一个 agent 的 ctx**,
父会话加载的服务器不会漏给子代理(父的 `restrict()` 同理到不了子代理 —— AllenLogo 的 README 记过同一条实测)。
要"绑到 agent 且它的子代理也能用",用 preset 行;要"只给这一个会话",用 `mcp_load`。
同类插件的做法对比见 [docs/competitive-landscape.md](../docs/competitive-landscape.md) 的「作用域分层」。

`mcp_load` / `mcp_unload`(+ `lazy` 下的 `mcp_call`、优化页开启时的 `mcp_search`)让一个会话**按需启动**某台 MCP,
省掉工具 schema 的 token。**服务器清单不做成工具,而是进系统提示**(见 [rules/context-budget.md](context-budget.md) 的「按需清单」),所以工具面最多四个:

- `mcp_load` / `mcp_unload`:两种按需模式下都注册;`mcp_load` 还收 `query` / `tool` / `detail` / `cursor` / `limit`(见「优化策略」);
- `mcp_call`:**只在 `lazy` 下注册** —— 那个模式不注册任何工具,它是唯一的调用通道;`dynamic` 下加载进来的工具
  按 `mcp__<server>__<tool>` 名字直接调;
- `mcp_search`:**只在优化设置的 `search` 打开时注册**。它是否注册会改变请求前缀,所以 `index.ts` 用
  `mcpRegistrationKey(policy)` 判断,值变了才重建整个注册(和加载模式同一条路径);
- `eager`:一个按需工具都不注册,也没有清单段(那时工具本来就在请求里)。

- 被**禁用**的 composition 行完全不参与:工具不进目录,也不能 `mcp_load`。
- `mcp_load` 走 **SDK 直连 + 调用方 agent 注册**:连接来自宿主级常驻池([rules/connection-pool.md](connection-pool.md)),工具注册落进 `agent.ctx.get('tools')`,
  所以一个会话加载的服务器不会把工具漏进别的会话的层;`proxy` 载体只把 schema 作为结果返回,不注册任何工具。
- 工具定义用 `@deepseek-ai/dsh-tools` 的 `defineTool` + `ctx.tools.register(def)`;`register` 返回 disposer,
  注册必须包在 `ctx.effect` 里。`exec.agent` 是拿到当前 agent 的唯一途径(无 agent 时要拒绝执行)。
- harness 的适配器 `createMcpToolDefinition` **经 loader 内部解析**取得
  (`ctx.loader.internal.import(MCP_CLIENT_MODULE)`),与组合用的是同一个模块实例;老 harness 不导出它时
  **fail loud**(提示改用 `lazy`),不静默降级。包名常量在 `src/mcp-modules.ts`。

## 预加载闸门(src/mcp-gate.ts)

`dynamic`/`lazy` 下"允许但不预加载"覆盖**两个平面**——preset 行与全局行——靠**三条互补的抑制路径**,都不写文件:

- **(a) 发布点抑制**(行在本插件 `apply` 之后才发布):gate 订阅 Cordis 的 `internal/plugin`,在该 fiber 发布那一刻
  **同步** `fiber.dispose()`。Cordis 紧接着才解析依赖并激活,被处置的 fiber 直接跳过激活 ——
  **`mcp-client` 的 `apply` 从不执行,子进程不会 spawn**。
  **只对 preset 行用这条**:全局行用发布点处置会把闸门状态写回用户文件(见下)。
- **(b) 挂载前拦截**(行在本插件 `apply` 之前就已建好:Loader 先把组合里的 entry 全建出来,再逐个 import 插件,
  这段窗口没有发布可观察):`index.ts` 在 `apply` 第一条语句同步订阅 `loader/entry-init`,交给
  `gate.onEntryInit(entry)`。`holdBeforeMount` 只在**这一个 entry 实例**上遮蔽 `disabled` 自身属性(不动声明)、
  并拦截它**第一次 `update()`** —— Loader 正是用 `update` 赋 options、紧接着 import 插件,所以在 update 里确认
  `options.name === '@deepseek-ai/dsh-mcp-client'`(options 取自该次 `update` 的入参,此时 entry 上还是上一版)
  再判归属,命中就让 `update` 直接 return,**插件从不被 import**;不是本插件的行立即还原(无副作用)。
  **file-backed Include 子树里的全局行走这条;写在组合本身里的全局行走下面的 (c)。**
  **订阅必须装在 `apply` 第一条语句(任何 `await` 之前)**,否则这段窗口已经过去。
- **(c) late hold**(全局行的兜底:行写在**组合本身**里 —— root anchor 或补丁层 insert —— Loader 在本插件 import 之前
  就把它建好并 import 完了,(b) 的窗口也够不着):`run()` 里 `!wantMounted && !held && mounted` 时由
  `holdMountedGlobal(entry)` 事后接管。**顺序是硬要求:先 `Object.defineProperty` 遮蔽 `disabled`,再
  `fiber.dispose()`** —— Loader 的自处置分支只在 entry 已读作 disabled 时才不落盘(`vendor/loader/src/index.ts:160-165`),
  顺序反了就会把 `disabled` 写回用户的组合文件。切回 `eager` 由 `releaseGlobalHold` 撤销遮蔽;`Entry.update` 不写文件。

**两种全局行形状与产品口径(隔离实例 2a–2d + 1 秒间隔采样复测)**:行放在**独立的 file-backed Include 文件**里
(推荐) → 该 Include 作为组合行在本插件之后激活,(b) 直接挡住,**连插件回调都不发生**;行写在**组合本身**里 →
已挂载的行由 (c) late hold 事后接管。**两种形状在这套 fixture 上都是"启动零拉起"**(1 秒采样:四个 marker 从未创建、
进程数 0);差别只在插件回调层面:形状 B 的 `mcp-client` `apply` 会被调用一次(harness `applyCalls === 1`),
但**没有留下子进程** —— "形状 B 会多起一个子进程"在真实实例上不成立。**两种形状的按需加载、池复用、
`mcp_unload` 三分支、不写回都通过**。**未实测**:真实 `npx -y` 服务器的冷启动路径(fixture 直接 `node` 调用,
刻意避开 npx 的 7.5–23 秒),所以"形状 B 在 `npx -y` 下是否会有可观测的瞬时进程"没有实测。
`globalWritable` 的判据在名册侧:**形状 A 现在是 `true`(行写在自己的 Include 文件里,设置页可以开关)**,只有 root anchor
时是 `false`;由组合/补丁层声明的行即使平面可写也**行级只读**(`readOnly: 'composed-row'`)—— 见「名册读取」。

**归属判据分两种树:**

- **preset tree**:三层判定(`presetOwnedTree`,[`src/preset-mounts.ts`](../src/preset-mounts.ts)):① reader 已捕获的树按身份;
  ② entry 祖先链里有 preset 声明(`tree.ctx.fiber.entry` 向上找 `AGENT_PRESET_MODULE`);③ 该 tree 的 `ctx` 属于
  standing preset scope(`scopes.scopeOf(tree.ctx) !== undefined`,与 `observe()` 捕获判据同源)。
  **第 ③ 层是必需的**:preset tree 的 `ctx` 不是由 Loader entry 建成的(它的 fiber 没有 `entry`),只靠 ② 走不到 ——
  这正是第一次隔离实例实测失败的真因(见 [docs/testing.md](../docs/testing.md))。
- **全局 tree**:`isGlobalPlaneTree(tree)` = 有**字符串 `filename`** 且 **`write` 是函数**(file-backed `Include` 的特征);
  `ownsGlobalTree(tree)` 额外接受 owner entry 名为 `cordis:include` / `@deepseek-ai/cordis-plugin-include` 的树
  (全局行自己的 entry 在 Include 建完之前就被观察到,那时只能靠 owner 名认)。
  **不能用 `ctx === undefined` 判定** —— `EntryTree` 基类给每棵树都设了 `ctx`(这是第一版的真缺陷);preset 树没有
  `filename`,host 组合自己的树与别的插件的 detached 子树两种判据都不命中,保持原状。

**全局行绝不能用发布点 `fiber.dispose()`**:`vendor/loader/src/index.ts:160-165` 在 fiber 自处置时会
`entry.options.disabled = true` + `entry.parent.tree.write()`,而全局行的树是 file-backed `Include` ——
**会把闸门状态写回用户的 `cordis.yml`**。全局行只能在内存里拦截(遮蔽 + 拦截首次 `update`),任何时刻都不改它的 options。

**全局行按需加载**(`gate.globalRows()`):从 Include 子树**递归**读行(嵌套 group 也读),返回
`{entryId, enabled, held, mounted}`。**`enabled` 必须读声明 `entry.options.disabled !== true`,不能读实例上的 getter**
—— 被遮蔽的行会被读成"用户禁用",于是 `mcp_load` 直接拒绝(verify-instance 实测到的 G2 缺陷)。
`mcp_load` 对 held 的全局行**不释放 hold**,直接走宿主级常驻池;只有切到 `eager` 时才由
`releaseGlobalHold(entryId)` 撤销拦截并 `entry.update({disabled:false}, false, true)` 让 Loader 真正挂载 ——
`Entry.update` **不写文件**(写文件的只有 `EntryTree.create/update/remove` 与 fiber 自处置)。

`reconcile()` 里原有的 `entry.update({disabled})` 仍然保留:它读每个 preset 代次的**声明快照**、继承祖先分组禁用、
用该行 Loader evaluator 求 `!!js`(拒绝求值则不允许),让 live 行满足 `mounted === (allowed && mode === 'eager')`,
作为幂等、可重放的补充路径(漏网路径与 eager↔dynamic 恢复都靠它)。
**必须读声明,不能读 live 行** —— live 行正是 gate 自己摘掉的,读回来会把摘过的行永久锁死。
四条必须记住的性质:

1. **不写声明,两个平面都不写。** preset 树是 registry 的内存树(`PresetTree`),`write()` 是空实现,所以内存里摘行
   不会碰用户的 profile patch。**全局行同样只在内存里拦截** —— 它们的树是 file-backed `Include`,一旦让 fiber
   自处置(`fiber.dispose()`)或走 `EntryTree` 写路径,`write()` 就会把闸门状态写回用户的 `cordis.yml`;
   所以全局行的 options 一概不改,挂载与摘除都靠实例遮蔽 + `entry.update`(`Entry.update` 不写文件)。
2. **触发点。** `tools/change`、`loader/entry-init`、`loader/partial-dispose`、相关 `internal/status` 和
   `agent-preset/selected` 都使快照失效。entry-init 在 parent/options 赋值前发出，必须下一 microtask 再观察。
   同步批次合并，`reconcile()` 内部串行化、幂等、可重放。
   **另有两处"取行集合变化"必须自己上报**:`createMcpPreloadGate(..., onRowTaken)`(gate 刚接管一行)与
   `createPresetMountReader(ctx, scopes, onCaptured)`(新 preset 代次变得可读),`index.ts` 据此 `queueMicrotask(resync)`。
   被 hold 的行**没有 fiber**,所以过去那些 `internal/status` 事件不会发生 —— 靠 fiber 状态事件驱动清单刷新,会让
   系统提示里的 MCP 清单**一直为空**(真实回归)。
3. **一次 reconcile 会真的 kill 掉 MCP 子进程**(`entry.update` 走 `Entry._dispose`),所以设置页先等
   `gateState`(它内部 await reconcile)再读名册,否则会看到"摘到一半"的名册。
4. **抑制不是闩锁,而且抑制是一等状态。** 切回 `eager` 后同一行要能重新挂载:preset 行由 `reconcile()` 在
   `wantMounted` 分支先 `releasePreHeldRow(leaf)` 还原 (b) 路径的遮蔽与 `update` 拦截,再
   `entry.update({disabled:false})`;全局行走 `releaseGlobalHold(entryId)`(撤销拦截 + `entry.update({disabled:false},
   false, true)` 让 Loader 真正挂载)。
   **这条有真实反面案例**:只还原 `entry.disabled` 而漏掉遮蔽时,该行的 `entry.disabled` 恒为 true,行静默死亡
   直到宿主重启。`zero-launch` 的 `holds a row that was declared before the plugin activated`、
   `global-zero-launch` 的五项(含 late hold 的接管与恢复)与 `on-demand-pool` 的
   `mounts the row under eager and mounts it again after suppression` 固定了这些路径。
   被抑制的行(两个平面、三条路径)的 fiber/状态都可能读成"已停止",所以 gate 单独登记 `suppressedEntryIds()`;
   名册据此报 `fiberPhase: 'held'`(见「名册读取」),UI 对它不显示标记。

同名坑:**`@Remote` 方法的形参名必须是 `request`**。网关按方法签名推导 descriptors,写成 `_request` 会让调用方收到
`args fields do not match the descriptor: unexpected "request"`,而客户端如果吞掉这个错误,表现就是"开关没反应"。

第 5 条性质:**配置不完整的行也不挂载,和"模式不预加载"共用同一条摘行路径。**
`allowed` 是 `declaredRow.enabled === true && diagnoseRowConfig(declaredRow.options.config).length === 0`
(见「配置诊断」)。区别在语义与 UI:模式造成的未挂载不该显示成状态,配置造成的必须显示且不许开启。
preset 行由这条判据直接摘除;全局行不参与这条判据(闸门不读它们的配置),它们的配置问题只由名册标记 ——
与"模式造成的未挂载"是两件事,UI 上分别对应「未配置」与不显示标记。

## 生效语义

- **host 半边是进程内模块**:插件代码在 host 启动时被 import,重建 `lib/` 不会替换运行中的代码 —— 必须重启宿主。
- **client 半边按内容 revision 提供**:Host 用 `lib/client.js` 的内容 revision 更新 bundle URL,改了 client 刷新页面
  即可;`HANDOFF_ID` 必须等于 `package.json` 的包名,改它会让 Web 启动图找不到该插件。
- **模式与规则是活设置**:加载模式、行描述、工具过滤提交后对所有会话的**下一次请求**生效,不需要重启。
  提交不同的加载模式会重建工具面并释放该模式的会话引用,无人再持有的按需连接随之停止(池对象本身只在插件卸载时关闭,
  见「按需连接池」)。
- **按需连接在宿主进程内常驻**:首次 `mcp_load` 起,活到最后一个会话释放引用、模式切换或插件卸载;
  **不跨宿主重启**(重启后需要重新 `mcp_load`);而"启动与声明重建永不 spawn"是无条件的,与之前是否加载过无关。
