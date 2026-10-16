---
paths:
  - "src/lazy-mcp.ts"
  - "src/mcp-carrier.ts"
  - "src/external-mcp.ts"
  - "src/mcp-modules.ts"
  - "src/mcp-tool-name.ts"
---

> 覆盖：`loading` 三种模式（eager/dynamic/lazy）的语义与「允不允许用 / 什么时候进上下文」两个开关的分工、`carrierFor` 载体选择与 `native` 载体的注册契约、作用域语义（preset 行 vs `mcp_load`）、按需工具面、模式切换的生效语义。何时读：改加载模式、载体、按需工具注册或作用域语义时。

# 加载模式、载体选择与生效语义

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

## 生效语义

- **host 半边是进程内模块**:插件代码在 host 启动时被 import,重建 `lib/` 不会替换运行中的代码 —— 必须重启宿主。
- **client 半边按内容 revision 提供**:Host 用 `lib/client.js` 的内容 revision 更新 bundle URL,改了 client 刷新页面
  即可;`HANDOFF_ID` 必须等于 `package.json` 的包名,改它会让 Web 启动图找不到该插件。
- **模式与规则是活设置**:加载模式、行描述、工具过滤提交后对所有会话的**下一次请求**生效,不需要重启。
  提交不同的加载模式会重建工具面并释放该模式的会话引用,无人再持有的按需连接随之停止(池对象本身只在插件卸载时关闭,
  见「按需连接池」)。
- **按需连接在宿主进程内常驻**:首次 `mcp_load` 起,活到最后一个会话释放引用、模式切换或插件卸载;
  **不跨宿主重启**(重启后需要重新 `mcp_load`);而"启动与声明重建永不 spawn"是无条件的,与之前是否加载过无关。
