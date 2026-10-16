# AGENTS.md

本仓 `dsh-mcp-manager` 是**独立于 harness monorepo** 的 DeepSeek Harness (DSH) 插件：
管理 MCP 服务器行(全局平面 + 各 agent preset)、决定允许的服务器何时进上下文、按行过滤工具,
并提供设置页的「MCP 管理」区块。

它不打包 `@deepseek-ai/*`,运行时从宿主 harness 解析这些包。

## 目录

仓库根**就是**包:`package.json` 即 `@guowenzhang/dsh-mcp-manager`。
这不是风格选择——`dsh plugin add <git-url>` 取的是仓库根,包放在 `packages/*` 下会被装成错误的东西。

- `src/` —— host 入口 `index.ts`;浏览器半边在 `src/client/`。
- `src/mcp-carrier.ts` —— 载体选择(`carrierFor`)与原生注册原语(`nativeDefinitions` / `swapNativeTools`)。
  纯逻辑:只 import `node:crypto` 与同仓纯模块,不碰 harness 运行时包,所以 vitest 能直接跑到。
  `src/mcp-tool-name.ts` —— 公开工具名契约,镜像 mcp-client 的 `publicToolName`。
  `src/mcp-inventory.ts` —— 系统提示里那段按需清单的纯渲染器(预算与截断规则都在这里)。
- `src/mcp-pool.ts` —— 宿主级常驻连接池(`createMcpConnectionPool` / `connectionFingerprint`):按「行身份 + 连接配置指纹」
  去重、按每会话 claim 计数释放。纯 Map + `node:crypto`,不 import harness 包,vitest 直接跑。
- `src/mcp-modules.ts` —— 宿主包名常量(`MCP_CLIENT_MODULE` / `AGENT_PRESET_MODULE`),gate 与组合读取共用一份拼写。
- `lib/` —— 构建产物:**已提交进仓库**(`index.mjs` host + `client.js` 浏览器 handoff),
  这样别人可以直接从 git 安装。改完源码**记得 `npm run build` 并把 `lib/` 一起提交**。
- `cordis.patch.yml` —— 把插件行插入组合的 bundle 层。
- `src/remote.ts` —— 手写的客户端 `TYPERT_REMOTE` 贡献对象。
- `src/client/agent-filter.ts` —— Agent 平面按预设过滤的纯规则(可选值、收窄后的行)。它只认 roster 行的
  `scope` / `presetId` 两个字段,不 import 任何 harness 包,所以 vitest 能直接跑 —— 而 `settings-controller.ts`
  会经 `@deepseek-ai/dsh-client-store` 拉进 `zustand`,在 Node 里加载即报 `Cannot find package 'zustand'`。
  所以过滤规则放这里,不要挪回 controller。
- `docs/design-decisions.md` —— 加载相关决策的参考页(为什么这样设计、否决过什么、Claude 先例对照)。
  改加载模式、闸门、工具过滤的语义时先读它,并把新决策补进去。
- `docs/competitive-landscape.md` —— 同类插件对比与功能路线图(社区三簇做法、逐维度差距、P0-P3 待办)。
  决定"下一步做什么"前先读它,做完一条就地更新。
- `docs/testing.md` —— 行为验证记录:harness 回归的覆盖矩阵与结果、隔离实例实测(启动零拉起 / 常驻复用 / `eager` 对照)
  的原始读数与复现命令、以及未覆盖项。改加载行为后按它复跑,并把新结果写回去。

## 构建

`npm run build` 跑两段打包:

- host:`tsdown` 打 `src/index.ts` → `lib/index.mjs`,所有 `@deepseek-ai/*` 与 `@modelcontextprotocol/*` 保持 external。
- client:`build-client.mjs`(rolldown)→ `lib/client.js`,包成 `window.__ModuleLoader__.load({ id, factory })`,
  react / `@deepseek-ai/*` external,`.module.css` 用 lightningcss 编译并内联。

**Node 不解析 TC39 装饰器。** tsdown 默认不降级装饰器,所以 `tsdown.config.ts` 里有一个
`lowerDecorators` transform(用 `typescript` 的 `transpileModule`),对含 `@装饰器` 的文件在打包前降级。
`McpManager` 上的 `@Remote` 少了这一步会以原始语法留在 `lib/index.mjs`,host 加载即崩。

## 插件契约(Cordis)

- host 插件导出 `{ name, inject, Config, apply }`;`apply(ctx, config)` 里注册能力,注册一律走 `ctx.effect(...)` 收口。
- 依赖的服务用 `ctx.get('x')` 取,**不要** `ctx.x` 属性访问 —— 未 inject 的服务属性在 Cordis 的 inject guard 下会抛错。
- **顶层静态 import 的宿主包必须在 manifest 里落地。** profile 只安装插件的 `dependencies`,其余裸模块名靠宿主
  的运行时解析从"安装闭包"供给;闭包里没有这个包时,表现就是启动告警 `failed to import`(终端不给原因,根因在
  `$DSH_HOME/logs/startup-*.log`)。所以:身份敏感的宿主包(模块级状态按同一性比较,如 `dsh-scope`、`dsh-mcp-client`)写
  `peerDependencies` + `devDependencies`;纯函数包(无实例内状态,如 `schemastery`)写 `dependencies`,让 profile 一定装到它。
  本地 `link:` 安装常常照跑,因为源码目录自己的 `node_modules` 恰好有这些包 —— 别用本地能跑证明声明齐了。
- client 半边必须打成 `window.__ModuleLoader__.load({ id, factory })` 手接格式;`HANDOFF_ID` 必须始终等于
  `package.json` 的包名。Host 用内容 revision 更新 bundle URL;不要通过修改 handoff id 做缓存失效,否则 Web 启动图找不到该插件。

## Typert Remote(前后端通信)

host 侧:`class McpManager extends TypertRemoteService`,构造里 `super(ctx, 'mcpManager')`,方法加 `@Remote('name')`。
**无条件注册这个服务** —— 不要用 `if (ctx.get('loader') !== undefined)` 之类前置守卫,守卫为假时服务根本不注册,
客户端 RPC 会收到 HTTP 404。host 网关按服务方法的**运行时参数名**推导 invocation descriptor,

- 新增一个 Remote 方法要**三处齐**:`@Remote('x')` 方法(形参必须叫 `request`)+ `src/remote.ts` 的
  `TYPERT_REMOTE.descriptors` 加一行 + `src/client/index.ts` 的 `McpManagerNamespace` 接口。
  漏掉 descriptor 的表现是客户端调用失败/"not mounted"。
- client 侧:`await ctx.remote.$mount(TYPERT_REMOTE)`,之后用 `ctx.get('remote.mcpManager')` 调用。
- 客户端贡献对象是 `{ package, descriptors }`;`descriptors` 里每个参数/结果的 codec 必须 `mode: 'strict'`,
  **两种 schema 座位都要带**(`schema.parse` 与 `create()` 工厂),缺 `create()` 时 `ctx.remote.$mount` 抛
  `strict codec has no create() factory`,整个 client 半边直接加载失败(浏览器只显示 "Failed to load plugins",
  不打印原因)。emit 两个字段的 `codec()` 在 `src/remote.ts`,注释里写了何时能去掉断言。

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

### 延迟加载(src/lazy-mcp.ts)

资源仓库 MCP 由 `src/external-mcp.ts` 的内存注册表接收：`mcpManager.replaceExternalMcps(owner, ownerCtx, rows)` / `removeExternalMcps(owner)`。它们不写组合文件；`eager` 下由管理器在提供方作用域挂载，`dynamic` / `lazy` 下进入按需清单和 `mcp_load`。Agent 行必须有真实 scope key，缺失时拒绝托管，不能降级成全局行。资源管理器仍拥有仓库同步、凭据和原始配置。

**两件事分两个开关:** composition 行上的 `disabled` = 用户**允不允许用**(禁用 = 完全不用:不进系统提示里的清单,
`mcp_load` 拒绝);`loading` 模式 = 允许的服务器**什么时候进上下文**。后者是
`mcp-manager` 用户设置(默认值取自 host 插件的 `Config`)**+ UI 三选一**。三种取值:

- `eager`:允许的行照常挂载;不注册按需工具。
- `dynamic`(默认):允许的行**默认不挂载**(见下面的 gate);`mcp_load` 用 MCP SDK 直连一条**共享连接**
  (宿主级常驻池,见本节下面的「按需连接池」),再用 harness 的适配器把**可见工具**原生注册进
  **调用方 agent 的作用域**。
- `lazy`:允许的行**默认不挂载**;**用 MCP SDK 直连、完全不注册工具**;`mcp_load` 把工具 schema 作为结果
  返回,模型用固定的 `mcp_call` 代理调用 → **工具列表永不变,请求缓存前缀零失效**。

三种取值对**两个平面**都生效:preset 行与全局行(见「预加载闸门」)。`eager` 下全局行由组合挂载;`dynamic`/`lazy` 下
启动不拉起,可由 `mcp_load` 按需加载并与其他会话共用同一条连接;工具过滤对全局行仍不生效(见「工具过滤」第 3 条)。
三种模式的取舍、否决过的替代方案,以及 Claude Code / Messages API 的延迟加载先例对照,见
[docs/design-decisions.md](docs/design-decisions.md);本节只讲实现契约。

### 载体选择(src/mcp-carrier.ts)

**载体由模式决定,规则与「本次加载要哪些工具」只决定可见集合**(决策 D8、D16)。`carrierFor(mode, _filter, _narrowed)`:

| 模式 | 载体 | 说明 |
|---|---|---|
| `lazy` | `proxy` | 代理通道,不注册任何工具 |
| `dynamic` | `native` | 插件只注册可见工具(规则与 `query`/`tool` 只决定可见集合) |
| `eager` | `undefined` | 整台由 harness 的 mcp-client 挂载,不注册按需工具;规则不生效并 warn |

**`mount` 载体已删除。** 它把整台服务器交给 harness 的 `mcp-client` 挂进调用方 agent 作用域,而那个插件
**按挂载作用域连接**:per-session 挂载必然得到 per-session 子进程,与「一台服务器在宿主内只起一次、跨会话复用」
(见下面的「按需连接池」)不可兼得。`native` 与原生挂载共用同一个适配器,绑定质量不变。

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
同类插件的做法对比见 [docs/competitive-landscape.md](docs/competitive-landscape.md) 的「作用域分层」。

`mcp_load` / `mcp_unload`(+ `lazy` 下的 `mcp_call`、优化页开启时的 `mcp_search`)让一个会话**按需启动**某台 MCP,
省掉工具 schema 的 token。**服务器清单不做成工具,而是进系统提示**(见下面的「按需清单」),所以工具面最多四个:

- `mcp_load` / `mcp_unload`:两种按需模式下都注册;`mcp_load` 还收 `query` / `tool` / `detail` / `cursor` / `limit`(见「优化策略」);
- `mcp_call`:**只在 `lazy` 下注册** —— 那个模式不注册任何工具,它是唯一的调用通道;`dynamic` 下加载进来的工具
  按 `mcp__<server>__<tool>` 名字直接调;
- `mcp_search`:**只在优化设置的 `search` 打开时注册**。它是否注册会改变请求前缀,所以 `index.ts` 用
  `mcpRegistrationKey(policy)` 判断,值变了才重建整个注册(和加载模式同一条路径);
- `eager`:一个按需工具都不注册,也没有清单段(那时工具本来就在请求里)。

- 被**禁用**的 composition 行完全不参与:工具不进目录,也不能 `mcp_load`。
- `mcp_load` 走 **SDK 直连 + 调用方 agent 注册**:连接来自下面的常驻池,工具注册落进 `agent.ctx.get('tools')`,
  所以一个会话加载的服务器不会把工具漏进别的会话的层;`proxy` 载体只把 schema 作为结果返回,不注册任何工具。
- 工具定义用 `@deepseek-ai/dsh-tools` 的 `defineTool` + `ctx.tools.register(def)`;`register` 返回 disposer,
  注册必须包在 `ctx.effect` 里。`exec.agent` 是拿到当前 agent 的唯一途径(无 agent 时要拒绝执行)。
- harness 的适配器 `createMcpToolDefinition` **经 loader 内部解析**取得
  (`ctx.loader.internal.import(MCP_CLIENT_MODULE)`),与组合用的是同一个模块实例;老 harness 不导出它时
  **fail loud**(提示改用 `lazy`),不静默降级。包名常量在 `src/mcp-modules.ts`。

#### 按需连接池(src/mcp-pool.ts)

**连接属于宿主,不属于加载它的会话。** 池条目按「行身份 + 连接配置指纹」去重(`rowKey` + 连接相关字段
transport / serverName / command / args / env / cwd / url / headers 的 SHA-256 前 16 位十六进制),宿主级持有;
同一台服务器的后续加载——同一会话、别的会话、子代理——都复用同一条连接(stdio 就是同一个子进程)。
每个会话对条目持有一个 **claim**:

- `mcp_load` 命中已有条目直接复用(不重连):`native` 载体在这个 agent 的 tools 上重建**这一代**注册,
  `proxy` 载体按会话保留 `tools` / `hidden` 视图。
- `mcp_unload` 只释放**调用方那个会话**的 claim,结果是三个字段:`released=false`(本会话没加载过)/
  `released=true, stopped=true`(最后一个引用,进程已停)/`released=true, stopped=false`(别的会话仍在用,
  进程与连接都保留)。
- 会话销毁(`bindAgentScope` 用 `agent.ctx.effect` 注册一次清理,每个会话只注册一次)同样只释放该会话的 claim;
  **最后一个 claim 释放时才关闭连接**。
- **存活语义**:连接在宿主进程内保持,直到最后一个会话释放引用、或**提交了不同的加载模式**(工具面重建、
  该模式的引用释放,无人再持有时停止)、或插件卸载。常驻 = **宿主进程生命周期内**,**不是**跨宿主重启持久化
  ——宿主重启后需要重新 `mcp_load`;而"启动与声明重建永不 spawn"是无条件的(见「预加载闸门」)。
- 池的操作串行化,两个会话同时加载同一台不会开出两条连接;连接配置变化会开出**新条目**,旧连接继续服务仍在
  用它的会话。指纹只进键与日志,**`env`/`headers` 的值不落日志、不进错误消息**(易崩清单第 12 条)。
- `eager` 不走池:preset 是 standing mount,全局共享一个实例。

**坑(实测):不要把注册放在 preset 作用域。** 曾把按需工具做成 preset 行(`inject: ['tools']`,在 preset 的
standing 作用域里 `ctx.tools.register`),结果 **preset 每 ~5 秒被重挂一次**(MCP 子进程反复重启)。
撤掉该行即恢复。所以注册落在 **host 平面**(插件 `apply` 时的 root ctx):`ctx.effect` 收口。

模式是**活的用户设置**:`readMcpSettings(config)` 读 Config 的 volatile 字段,`index.ts` 在
`loader/volatile-update` 上先 `dispose()` 掉旧注册(工具面重建、该模式的会话 claim 一并释放,无人再持有的连接
随之停止)再按新模式注册 —— 交换对**所有会话的下一次请求**生效。池对象本身跨这次重建存活,只在插件卸载时
整体 `dispose()`(见「按需连接池」)。`parseMcpLoadingMode` 把无法识别的存量值收敛回 `dynamic`(设置文档是用户可编辑的,
不能因为一个拼错的值让提交失败)。UI 侧是 `McpSection.tsx` 的 `McpLoadingPicker`(三个 radio),读写 `loading` 字段。

### 按需清单(src/mcp-inventory.ts)

`dynamic`/`lazy` 下请求里没有任何 MCP 工具 schema,所以**服务器名单必须主动出版**:`registerMcpTools` 在
`systemPrompt.section` 上注册 `mcp-manager:on-demand`,位置用 harness 预留的 `MCP_SERVERS`(与 mcp-client 放
server instructions 同一个位置)。四条契约:

1. **渲染是纯函数。** `renderMcpInventory(rows, mode, search)` 只吃「名字 + 描述」与两个开关,不碰 Loader/preset,所以 vitest 能直接跑。
2. **段文本是快照,装配时不能 await。** 系统提示装配是同步的,所以注册句柄持有 `inventory` 字符串,由返回的
   `refresh()` 重读 allowed rows 再渲染;`index.ts` 在 `gate.reconcile()` 之后、以及模式提交后各调一次。
   漏调的表现是模型看到上一版名单 —— 新增的行它永远加载不了。
3. **绝不写"是否已加载"。** 那会让每次 `mcp_load` 都重写系统提示 → 整个前缀(系统 + 工具 + 历史)失效,
   比工具列表变化贵得多。加载状态本来就在会话历史里。
4. **预算只削描述,不删名字。** 单条 80 字符、整段描述预算 900 字符;超预算先丢描述,**服务器名永远列全**
   (模型看不到名字的服务器就加载不了)。`interpolate: false` —— 描述是用户文本,`{{...}}` 必须原样保留。
5. **只提这次真的注册了的工具。** 那句导语按模式点名 `mcp_load` / `mcp_unload` / `mcp_call`,并在
   `searchEnabled` 为真时才提 `mcp_search`。`searchEnabled` 在注册时取一次(不是每次装配读活设置),
   否则设置刚提交、注册还没重建的那一瞬间,模型会被指向一个不存在的工具。

`registerMcpTools` 因此返回 `{ dispose, refresh, toolsChanged }`;第四参数是三个活闭包 `{ filterFor, descriptionFor, optimize? }`,第五个是宿主级常驻池 `pool`,第六个是 `external`、第七个是 `catalog`。

清单段的原文(每行 `名字 — 描述`,描述取自该行的设置;这段是模型可见文本,改动要同步快照):

```
MCP servers available on demand: call `mcp_load` with one of these names to add that server's
tools to this session — pass `query` to add only what matches, or `tool` for one tool and its
argument schema — and `mcp_unload` with the same name to release it again.

- alibaba-devops-mcp — 云效MCP，任务管理工具，可以操作
- playwright
```

`search` 打开时导语多一句前置说明:`MCP servers available on demand: Use \`mcp_search\` to find tools by
what they do without loading a server, and call \`mcp_load\` …`。

### 预加载闸门(src/mcp-gate.ts)

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

- **preset tree**:三层判定(`presetOwnedTree`,[`src/preset-mounts.ts`](src/preset-mounts.ts)):① reader 已捕获的树按身份;
  ② entry 祖先链里有 preset 声明(`tree.ctx.fiber.entry` 向上找 `AGENT_PRESET_MODULE`);③ 该 tree 的 `ctx` 属于
  standing preset scope(`scopes.scopeOf(tree.ctx) !== undefined`,与 `observe()` 捕获判据同源)。
  **第 ③ 层是必需的**:preset tree 的 `ctx` 不是由 Loader entry 建成的(它的 fiber 没有 `entry`),只靠 ② 走不到 ——
  这正是第一次隔离实例实测失败的真因(见 [docs/testing.md](docs/testing.md))。
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

### 配置诊断(src/mcp-diagnostics.ts、src/mcp-variable-refs.ts)

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

### 名册读取(src/mcp-roster.ts)

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

### 工具过滤(src/mcp-tool-filter.ts)

一台服务器几十个工具、常用只有几个时,`mcp_load` 一次就把全部 schema 倒进会话历史。过滤规则存在
`mcp-manager` 设置的 `tools` 字段里,键是 `mcpRowKey(target, serverName)`,值是一个字符串数组:

- 不带 `!` 的条目 = 保留(allow);只要有一个 allow 条目,这台服务器就是**白名单**;
- `!` 开头的条目 = 隐藏(deny);只有 deny 条目时是**黑名单**;
- `*` / `?` 通配,其余正则元字符都转义,大小写敏感。

四条实现约束:

1. **过滤点跟着载体走。** `proxy` 载体两个点都要:`mcp_load` 的返回(模型看不到被隐藏的工具名)与 `mcp_call`
   的入参校验(拿旧名字调用会被拒绝)。`native` 载体只需要前者 —— 被隐藏的工具根本没有注册,模型照历史名字调用
   直接得到未知工具;`mcp_call` 对这类行也拒绝(它只服务 `proxy`)。
2. **过滤不切换载体**(见「载体选择」)。`eager` 下规则不生效 —— 该模式由 harness 的 mcp-client 整台挂载,插件没有
   插手的点 —— `index.ts` 的 `warnFiltersWithoutEffect` 会在启动和每次提交时警告。
3. **`global:` 的规则同样不生效,而且 UI 不可改。** 全局行由组合直接挂载,工具已经进了每次请求,规则藏不掉它
   (`mcp_load` 那份是**另一份**实例)。所以:`warnFiltersWithoutEffect` 在非 `eager` 模式下只对 `global:` 键警告;
   编辑弹窗的「工具列表」对全局行**整体只读**(按钮与勾选框全禁用 + 给出原因),切 tab 也不会去连一次服务器,
   保存更不会写规则。要过滤就把行写到 Agent 预设里。
4. **规则 reader 是活闭包而不是快照**:`registerMcpTools(ctx, mode, gate, { filterFor, descriptionFor })` 收的是读者,
   `index.ts` 在 `apply` 里把它们指向 `readSettings().tools` / `readSettings().descriptions`。所以改规则不需要重建注册,
   下一次 `mcp_load` 就读到新值;已经加载的服务器保持加载时那套工具(不追溯),服务器自己发 `tools/list_changed`
   时也按加载时那套规则重算。

`mcp_load` 的结果带 `hidden` 字段(被隐藏的数量),render 里有一行提示 —— 模型需要知道"还有工具但不可调用",
否则会照历史里的名字硬调。

弹窗保存的就是这份 deny 列表 —— 取消勾选 `delete_workitem` 会写成:

```yaml
mcp-manager:
  tools:
    "preset:standard-yunxiao:alibaba-devops-mcp":
      - "!delete_workitem"
```

### 优化策略(src/mcp-optimize.ts、src/mcp-catalog.ts、src/client/McpOptimizeSection.tsx)

规范侧能用的只有两件:游标分页,以及 2026-07-28 的 `CacheableResult`(`ttlMs` / `cacheScope`)。`tools/list`
**没有** `query` 参数,也**没有**「只列名称」的线上形态(`inputSchema` 必填),所以检索、只带名称、目录缓存
都只能做在宿主侧 —— 官方《Client Best Practices》正是这么要求的(`search_tools` → `get_tool_details` → 执行)。
三条粒度互不替代,写在 `optimize` 字段里,由 `parseMcpOptimizeFlags` 收敛:

1. **选择**:`mcp_load` 的 `query`(词法匹配,离线、无 embedding)与 `tool`(按名取一个)收窄**能调用**的集合;
   **载体不变**(`dynamic` 一律 `native`,收窄只决定注册哪些定义,见「载体选择」)。已经加载过的服务器再给新
   `query` 只会**加宽**(`widen`),永不收窄。
   **不带 `query`/`tool` 的调用 = 整台**:它会把已收窄的会话视图**加宽回当前可见全集**,并在结果里如实报
   `widened: true`(render 里也有一行说明)——所以"只加宽、永不收窄"是自洽的,不是漏判。
2. **列表**:`cursor` / `limit` 只分页结果(默认 `pageSize`),`loaded` 仍是全部被选中的工具 —— 分页是上下文预算,
   不是能力开关。模型要知道"还有工具",靠 `nextCursor`,不靠少注册几个工具。
   **`cursor` 的空白串(`''` 或纯空白)等价于"从头开始"**(`mcp-optimize.ts` 的偏移解析),与"空串是合法游标"对称;
   `undefined` 才是"没给",只有 `nextCursor === undefined` 表示列完。
3. **形态**:`namesOnly` 默认让 `mcp_load` 只带名称与描述;`tool`(按名要一个)默认升到 `full`,因为那正是要参数的时机。

其余开关与实现约束:

- **`mcp_search` 只在 `search` 打开时注册**,所以 `index.ts` 用 `mcpRegistrationKey(policy)` 参与"是否重建注册"的
  判断(与加载模式同一条 `external.transition` 路径)。**其余策略字段一律在调用点读活值**,不要为它们重建注册。
- **`listAllTools(client, maxTools)` 是唯一的发现入口。** 游标按规范当**不透明字符串**:空串是合法游标,
  只有 `nextCursor === undefined` 才是结束(写成 `if (!next)` 会静默丢掉第二页);页数封顶 `MAX_TOOL_PAGES=64`,
  采集量封顶 `maxTools`,被截断时结果带 `truncated: true`。
- **目录缓存在两个点失效**:服务器自己的 `ttlMs` 比设置更短时以服务器为准;`notifications/tools/list_changed` 一到就
  `catalog.invalidate(row.key)`(规范要求通知立即作废仍然新鲜的列表)。行被增删改(`mcp-remote.ts` 的四个 mutation)
  后 `catalog.clear()`,因为改配置等于换了台服务器。
- **`mcp_search` 默认不连接任何服务器**(`searchIndex` 打开才连,`SEARCH_INDEX_CONCURRENCY=3`、
  `SEARCH_INDEX_TIMEOUT_MS=8000`),否则二十台服务器的部署会因为模型问一句就 spawn 二十个子进程。查不到的服务器
  以 `pending` 名单返回,让模型先 `mcp_load`。
- **收窄到空的加载不建立 mount。** `query` 没命中时返回空结果并关掉连接;`tool` 给的名字不存在时直接报错。
  否则会话会挂着一个空 mount,之后连"加载整台"都只能看到空列表(要 `mcp_unload` 才能恢复)。
- **注解是策略输入,不是承诺。** `hideDestructive` 只认显式 `destructiveHint: true`(规范里缺省值是 true,
  按缺省处理会把没有注解的服务器整台藏掉);`annotations` 只把服务器**真的声明过**的提示带进列表。
- **设置页是独立的 `settings.section`(id `mcp-manager-optimize`,order 15),复用同一个 controller。** 它按字段
  merge 写 `optimize` 开映射,每个开关有自己的保存中/已保存状态;目录面板走 `catalogState` / `clearCatalog`
  两个 Remote(注意:新增 Remote 要三处齐,见「Typert Remote」)。策略解析复用 `src/mcp-optimize.ts`,
  **不要在浏览器侧再写一份默认值**,否则两侧会漂移。

### 设置页分区(src/client/McpSection.tsx)

名册是**一个列表**,两个平面用列表内的分组标题分开,全局恒在最前 **(2026-10-16 起不再有平面 tab)**。五条约束:

1. **全局分组恒在最前、永不被过滤掉** —— 会话带着它的全局行,不管跑哪个预设;预设下拉只收窄 agent 行。
2. **全局分组标题旁要说明"全局行同样跟随加载方式"**(`mcp.plane.global.eager`;`<=760px` 隐藏):`eager` 下由组合直接挂载,`dynamic`/`lazy` 下启动不拉起、可用 `mcp_load` 按需加载并与其他会话共用同一条连接;工具过滤对全局行**仍然不生效**(见「工具过滤」第 3 条)。**不要再写"全局行始终加载 / 不受加载模式影响"** —— 那是本轮之前的行为。
3. **加载方式选择器对两个平面都生效**(它下面就是那个统一列表):它决定的是 preset 行的进上下文时机,放在全局 tab 会暗示它对全局行有效。
4. **写入目标跟着用户最后的选择**(`McpEditor` 的 `plane` 入参,`editorTarget()`):编辑某行 → 该行自己的平面;预设下拉选了一个预设 → agent 平面,弹窗只保留"Agent 预设"下拉以便多预设时挑一个,没有可写预设时禁用保存并说明。**编辑**时范围来自被编辑行自身,所以只读显示那一行,不给下拉。两个 tab 的"新增/导入"与行操作在**该平面不可用时**禁用(全局:没有唯一的 file-backed Include;原因放按钮 `title`),不要放进弹窗再失败。
5. **行级只读要真的置灰**:名册行带 `writable` / `readOnly`(全局行的 `composed-row`、平面的 `no-writable-include` / `several-writable-includes` / `unreadable-include`),开关与「编辑」按钮据此禁用并把原因写进 `title` / 提示位;不要只靠服务端拒绝,也不要把禁用的按钮留在可点击状态。
6. **客户端判"这一行开没开"有唯一入口**:`rowAllowed(enabled, suppressed)`(`src/client/mcp-row-state.ts`,不依赖 React 的纯模块,便于单测)。规则是 **Host 明确的 `enabled: false` 优先于兜底标志 `suppressed`** —— 后者只为"老 bundle 下被 hold 的行也报 false"这种情况留的后路,绝不允许把用户停用的行重新显示成已启用(易崩第 43 条)。
7. **Agent 行按预设过滤**:预设一多,54 行那种列表就没法看,所以工具栏有一个下拉。**选项是全部已声明预设**(持有行的按行数降序在前,0 行的也在,因为新增行要写进其中一个 —— 选项与受控值必须来自同一份集合,否则 0 行的预设选不中),不用另一个 RPC 拉预设列表;预设名在同一次 `listMcps` 里带着,不必再读一次。`全部 Agent 预设`用空串当哨兵值(预设 id 非空),下拉的 `value` 与列表共用同一个校验后的值 —— 名册刷新后选中项消失时回退到"全部",不会留下一个空列表,也不会出现"下拉显示 A、列表渲染 B"。分组标题上的计数是该分组的行数。规则在 `src/client/agent-filter.ts`(纯函数),回归测试见 `tests/agent-filter.spec.ts`。

### 工具选择 UI(src/client/McpEditor.tsx)

编辑弹窗分成「配置」与「工具列表」两个 tab,后者是规则的可视化入口:勾选 = 可见,取消勾选 = 隐藏,默认全勾。

- **数据来自 `mcpManager.listMcpTools`**(`mcp-remote.ts`),它按**表单当前的 spec** 连一次服务器并
  `listTools`,返回 `{name, description}[]`,完成后 close。之所以传 spec 而不是 `entryId`:新增行还没有 entryId,
  而且用户在弹窗里改了 command/url 后点"加载工具列表"应该按新配置拉。连接有 30 秒超时(`withTimeout`)。
- **默认全勾 = 没有规则。** 勾选状态由 `admits(parseMcpToolFilter(toolRulesInitial), name)` 算出,所以手写的
  allow/通配规则在 UI 里也显示正确;保存时展开成 `!<name>` 的 deny 列表,全勾则写空数组 → 删掉该键。
- **连不上就不动规则。** `tools === null` 时保存只提交连接配置 —— 否则一次连接抖动会清掉用户已有的过滤。
- **切到「工具列表」tab 才会真起一个 MCP 连接**(stdio 是新的子进程,`npx -y` 那种 1-3 秒):edit 模式首次切过去
  自动拉,add 模式靠按钮,因为新增时表单里的 spec 常常还是空的。只改描述就不进这个 tab,不会白起一个进程。
- **全局行整块只读**(`toolsReadOnly`):按钮与勾选框禁用、切过去也不连接、保存不写规则,并在原提示位置说明原因
  (`mcp.form.toolsGlobal`)—— 全局行由组合挂载,规则藏不掉它已经进上下文的工具(见「工具过滤」第 3 条)。
- **改 client 后必须重建 `lib/client.js`**;Host 用内容 revision 让浏览器加载新 bundle,`HANDOFF_ID` 不得改变。
  改了 CSS module 要核对类名两边都在:JSX 引用了 CSS 里没有的类只得到 `undefined`,静默无样式。

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

## 测试

`npm test` 跑 `vitest run`,配置在仓根 `vitest.config.ts`。**必须带这份本地配置**:本仓是 harness checkout
的**兄弟目录**而不是它的 workspace,裸 `vitest run` 会继承 harness 根配置,一个 spec 都收不到
(`No test files found`)。配置把 `root` 钉在本仓，排除需要真实源码的 `*.harness.spec.ts`。

`npm run test:harness` 先重建分发产物，再跑真实 Loader/registry/scope 的兼容测试。
默认宿主位置为 `../../deepseek-harness`，可用 `DSH_HARNESS_ROOT` 指定其它 checkout。
覆盖导入/启动、pending Host injection、分组与表达式禁用、旧代/子代理、manager-only 重载和清单隔离。

`npm test` 现在是 **19 个 spec 文件 / 204 项**：本轮新增 `tests/mcp-pool.spec.ts`、`tests/fiber-publication.spec.ts`、
`tests/mcp-gate.spec.ts` 的 6 项**挂载前拦截**用例（`update` 直接返回、`init` 从未调用、`fiber` 保持 undefined；
非本插件的行与 `eager` 下立即还原；切回 `eager` 能撤销遮蔽并真正挂载）、全局平面的读取/拦截单测，以及
**`tests/mcp-row-state.spec.ts`（`rowAllowed`：明确 `false` 压过 `suppressed` 兜底）与全局写入目标/行级只读的单测**。
`npm run test:harness` 是 **6 个 harness spec / 25 项**（`zero-launch`（4 项）、`global-zero-launch`（**5 项**：
全局行在 `dynamic`/`lazy` 下不被 import、`eager` 下照常挂载、被 hold 的行能按需加载、组合已挂载的行由 late hold 接管、
切回 `eager` 后连用户文件一起完好）、`on-demand-pool`、`plugin-startup`、`preset-compat`、`global-toggle`）。
**2026-10-16 快照(合并 + 全局行开关修复后，最终产物)**：`npm test` **19/204 通过**、`npm run test:harness` **6/25 通过**、
`npm run typecheck` 与 `npm run build` 通过；产物 `lib/index.mjs` = `121B8C0A…`、`lib/client.js` = `E1B1051A…`。
**隔离实例实测通过（最终产物 `121B8C0A…`/`E1B1051A…`）**：`dynamic` 启动后四个 marker 全不存在、进程 0、
stderr 为空；`eager` 对照四台长期存活；多次 `mcp_load` 复用同一条子进程（同一 pid）、末位释放才停；全局行的
开关（形状 A：行写在自己的 Include 文件里）在设置页真正可用，被用户停用的行开关立即显示为关。
**两种全局行形状在这套 fixture 上都是"启动零拉起"**（1 秒间隔采样复测：marker 从未创建、进程 0）；
差别只在插件回调层面 —— 形状 B 的 `mcp-client` `apply` 会被调用一次（`applyCalls === 1`）但**没有留下子进程**，
形状 A 连回调都不发生。**推荐把全局行放在它自己的 file-backed Include 文件里**。**未覆盖**：真实 `npx -y` 冷启动路径、
GUI 里由模型决定的调用路径、`tools/list_changed` 跨会话 resync、活动实例内运行中切换加载模式、活动实例里的 `lazy` 池复用、
`mcp_search` 工具本身、新增/导入/删除行与编辑弹窗「保存」的浏览器实测、用户 Include 的注释保留
—— 明细见 [docs/testing.md](docs/testing.md)。旧产物 `9B5D8D19…` / `D498FEC7…` 的读数保留在 testing.md 里作为历史。

**行为验证记录在 [docs/testing.md](docs/testing.md)**：harness 回归的覆盖矩阵与结果、隔离实例实测（启动零拉起 /
常驻复用 / `eager` 对照）的读数、复现命令与未覆盖项。改加载、池或闸门行为后按它复跑，并把新结果写回去；
**没跑过的项不要写成已通过**。

## 部署

用官方命令安装,它把参数转发给 profile 目录里的 pnpm,**并自行维护 profile 清单**(依赖与 `dsh.profile.bundles` 一起加):

```sh
dsh plugin --profile web add C:/02-codespace/deepseek-harness/dsh-mcp-manager   # 本地开发
dsh plugin --profile web add github:zhang-guo-wen/dsh-mcp-manager               # git 源
```

本地目录安装时 pnpm 建的是 **symlink(记作 `link:`)** —— 所以重建 `lib/` 后**重启即生效,无需重装**。
`file:` 依赖则可能退化成物理拷贝,那时改源码不会影响正在跑的 dsh,要重装或手动同步 `lib/`。
client 产物变了由 Host 的内容 revision 切换 bundle;必要时刷新浏览器,不要修改 `HANDOFF_ID`。

## 发版(Release)

`lib/` 是提交进仓库的,所以**发版 = 改版本号 + 构建 + 提交产物 + 打 tag**。别人按 tag 安装,
`master` 上的临时提交不会被他们拿到。

1. 改根 `package.json` 的 `version`。
2. `npm run build`,确认 `lib/index.mjs` 与 `lib/client.js` 是最新的。
3. 提交源码与 `lib/`(不要把 `lib/` 落在外面的工作区)。
4. 打带注释的 tag 并推送:

   ```sh
   git tag -a v<version> -m "dsh-mcp-manager <version>"
   git push dsh-mcp-manager master --follow-tags
   ```

## 易崩清单

1. `@Remote` 装饰器没在构建期降级 → host 加载崩(Node 不解析装饰器)。
2. 服务被守卫条件挡住没注册 → 客户端 RPC 404。
3. `ctx.x` 属性访问未 inject 的服务 → 抛错(用 `ctx.get('x')`)。
4. client 包不是 `window.__ModuleLoader__.load` 格式 → 浏览器加载失败。
5. **新 Remote 方法漏掉 `src/remote.ts` 的 descriptor** → 客户端调用失败,浏览器可能只显示
   "Failed to load plugins",不打印原因。
6. CSS module 里 JSX 引用但 CSS 未定义的类 → `undefined`,静默无样式(改样式后核对类名齐全)。
7. `HANDOFF_ID` 不等于包名 → bundle 加载后没有注册启动图等待的 factory,Web 汇总为 `import failed`。
8. **把 live preset 行当"声明真值"读** → gate 会把自己摘掉的行当成用户禁用,切回 `eager` 也永远不再挂载。
9. 依赖 `livePresetMounts` → 新版 registry 已删除导出，ESM 链接直接失败；使用 `src/preset-mounts.ts` 的公开接口适配。
10. **写 preset 行绕过 `configEditor.edit`**(或再去写 `agent.cordis.yml`) → profile patch 没落盘,运行态也不会 reconcile,UI 开关不动。
11. **在设置 schema 里校验 `tools` 值** → 一个写错的规则让整个命名空间回退,用户所有 MCP 设置静默失效。
12. **把 `env`/`headers` 的值打进日志或错误消息** → 明文凭据落进会话与日志文件;导入的服务器恰恰都是带 token 的。
13. **给导入单写一条写入路径** → 绕开 `addMcp` 的冲突检测与原子写,重名会写出重复行。
14. **把原生载体的工具注册到插件 root ctx**(而不是 `agent.ctx.get('tools')`) → 工具变成全局注册,漏给所有会话。
15. **自己拼 MCP 工具定义而不用 `createMcpToolDefinition`** → 丢 canonical 结果校验、`isError`、图片落盘与 PTC 投影。
16. **复刻工具名时漏掉 mcp-client 的规范化与哈希** → 同一个工具在不同载体下拿到两个名字,`mcp__<serverName>__`
    前缀的命名空间与 toolview 失准。
17. **在清单段里写"是否已加载"** → 每次 `mcp_load` 都重写系统提示,整个缓存前缀(系统 + 工具 + 历史)失效一次,
    比工具列表变化贵得多。加载状态本来就在会话历史里。
18. **忘了调 `refresh()`**(新注册、模式提交、reconcile 之后) → 模型看到上一版名单:新增的 MCP 行它永远加载不了。
19. **名册读回 `remote.pluginInventory.list`** → 走 `auditRows` 等每一行的激活,MCP 子进程启动几秒就卡几秒(见「名册读取」)。
20. **用 `loader.create`/`loader.update` 写全局行** → 触发 `Include.write()`,把带补丁的整棵树写回用户的
    `cordis.yml`,bundle 层与用户补丁层就被拍平了。全局行只能"改文件 + `Include.refresh()`"(见「MCP 行编写」)。
21. **刷新时把名册清成 `loading`** → 每次新增/开关后页面闪一下;保留上一版名册,只标记 `refreshing`。
22. **批量导入循环调 `addMcp`** → 每行一次写入 = 该 preset 重挂一次 = 里面每台 MCP 重启一轮;用 `addMcps` 一次提交。
23. **顶层静态 import 的宿主包没写进 manifest** → profile 只装插件的 `dependencies`,其余裸模块名靠宿主安装闭包供给;
    闭包里没有它(或版本线不同)就是导入失败,而**终端只显示 `failed to import`**、根因在 `$DSH_HOME/logs/startup-*.log`。
    本地 `link:` 安装会照跑(源码目录自己的 `node_modules` 恰好有),所以本地能跑不代表声明齐了(见「插件契约(Cordis)」)。
24. **让浏览器去判断变量能不能解析,或在浏览器包里引用 `process.env`** → 浏览器没有环境,`${env:NAME}` 会被一律判成
    未配置,用户永远存不下这样的行;所以变量判定归 Host(名册读回时),编辑弹窗只挡结构性错误(见「配置诊断」)。
25. **给"模式造成的未挂载"加状态标记** → `dynamic`/`lazy` 下每一行都会被标上,等于给整张列表加噪声,真正的
    「未配置」被淹没(见「配置诊断」)。
26. **把 preset live 行的 `disabled` 当成"用户禁用"** → gate 在 `dynamic`/`lazy` 下真的会把每个 allowed 行设成
    disabled,于是整个 preset 平面显示成「已禁用」,开关也全灭。名册的 `enabled` 必须取声明(见「名册读取」)。
    实际踩过一次:宿主没重启、浏览器已加载新 client,于是整列 54 行变「已禁用」。
27. **把 `nextCursor` 当真假值判断**(`if (!next) break`) → 规范允许空串游标,第二页被静默丢掉;只认 `undefined`。
28. **为策略字段重建整个注册** → 除 `search` 外都在调用点读活值;为 `pageSize` 之类的改动 dispose 再注册,会把
    每个会话已加载的 MCP 全部杀掉重来。
29. **收窄结果为空却仍然留下一个视图** → 会话之后连"加载整台"都只看到空列表,只能 `mcp_unload` 才能恢复。
30. **`mcp_search` 默认去连接未缓存的服务器** → 模型问一句就 spawn 一批子进程;必须由 `searchIndex` 显式打开并限并发。
31. **在浏览器侧复制一份策略默认值** → 两侧漂移;设置页必须 `import` `src/mcp-optimize.ts` 的 `parseMcpOptimizeFlags`。
32. **把 `internal/plugin` / `loader/entry-init` 的订阅装在 `apply` 的 `await` 之后** → 挂载前拦截的窗口
    (Loader 先建出所有 entry、再逐个 import 插件)已经过去,preset 行照常 spawn。两条订阅都必须在 `apply`
    的第一条语句安装。
33. **对全局行用发布点抑制(`fiber.dispose()`)或别的插件的 detached 子树做抑制** → 全局行的树是 file-backed
    `Include`,fiber 自处置会 `entry.options.disabled = true` + `tree.write()`,**把闸门状态写回用户的
    `cordis.yml`**;全局行只能走内存拦截(遮蔽 + 拦截首次 `update`),只抑制本插件管理的 preset tree 与全局 Include。
34. **把 `env`/`headers` 的值写进池键或日志** → 池的指纹只用连接相关字段的 SHA-256;凭据纪律见第 12 条。
35. **把"常驻"理解成跨宿主重启持久化**(守护进程 / 开机自启) → 边界是宿主进程生命周期内;宿主重启后必须重新
    `mcp_load`,而"启动与声明重建永不 spawn"与之前是否加载过无关。
36. **让模式切换保留旧模式的工具注册** → 旧模式的 claim 不释放,连接会一直挂着;模式切换必须重建工具面并释放
    该模式的 claim(见「按需连接池」的存活语义)。
37. **模式切回 `eager` 时只还原 `entry.disabled`、忘了撤销挂载前拦截的遮蔽与 `update` 拦截** → 该行
    `entry.disabled` 恒为 true,静默死亡直到宿主重启。恢复路径必须先 `releasePreHeldRow(leaf)` 再
    `entry.update({disabled:false})`(见「预加载闸门」性质 4,harness 用例已覆盖)。
38. **判定 preset tree 时只走 entry 祖先链** → preset tree 的 `ctx` 不是由 Loader entry 建成的(它的 fiber 没有
    `entry`),这一层走不到,抑制整体失效(第一次隔离实例实测的真因)。必须用三层判定:reader 快照 / 祖先链 /
    standing preset scope(见「预加载闸门」)。
39. **靠 fiber 状态事件驱动按需清单刷新** → 被 hold 的行**没有 fiber**,`internal/status` 这类事件根本不会发生,
    系统提示里的 MCP 清单会**一直为空**。取行集合变化必须由 `onRowTaken`(gate 接管一行)与 `onCaptured`
    (preset 代次可读)自己上报,再 `queueMicrotask(resync)`(见「预加载闸门」性质 2,真实回归)。
40. **读全局行 `enabled` 时用实例上的 getter(`entry.disabled`)** → gate 遮蔽的正是这一个实例属性,会把"闸门
    hold"读成"用户禁用",于是被 hold 的全局行连 `mcp_load` 都拒绝(verify-instance 实测到的 G2 缺陷)。
    必须读声明 `entry.options.disabled !== true`。
41. **给全局行换 `EntryTree` 写路径(create/update/remove)去改它的挂载状态** → 那是唯一会落盘的路径,会把闸门
    状态写进用户的 `cordis.yml`;全局行的模式切换只能 `releaseGlobalHold` + `entry.update({disabled:false}, false, true)`。
42. **late hold 顺序反了(先 `fiber.dispose()` 再遮蔽)** → Loader 的自处置分支看到 entry 还没读作 disabled,就会
    `entry.options.disabled = true` + `tree.write()`,**把闸门状态写回用户的组合文件**。硬要求是
    **先 `Object.defineProperty` 遮蔽、后 dispose**(见「预加载闸门」(c);`global-zero-launch` 的
    `holds a global row the composition mounted before this plugin was imported` 与"文件完好"断言固定了这条)。
43. **把 `suppressed` 兜底标志当成用户意图**(客户端拿 `gate.suppressedKeys()` 的结果直接当"行开着")→ 运行中停用
    一行后,开关仍显示"已启用",再点只是把 `disabled: true` 重复写一次(幂等 no-op),只有重启实例才显示正确;
    根因是闸门 `states` 里那条陈旧的 `suppressed`。规则:**用户明确 `enabled: false` 优先于 `suppressed`**
    (`rowAllowed`,见「设置页分区」第 6 条),被用户停用的行也必须退出 `suppressedKeys()`。
44. **给全局行写入路径只认 Include 的文件行却不做前置校验** → 补丁层/组合声明的行会先撞上误导性的 `mcp/not-found`
    (消息还错写成 "preset row");必须写前校验"该行 id 在可写 Include 的文件行里",命中不了就抛平面准确的
    **`mcp/read-only`**(见「名册读取」的行级可写判据)。
`parseMcpLoadingMode` 收敛回 `dynamic`(见「延迟加载」)。`descriptions` 与 `tools` 归用户设置文档,见「设置命名空间」。

## 安装

[部署](#部署)一节给的是本地目录与 `github:` 两种源;其余安装变体:

```sh
# npm 官方源
npx @deepseek-ai/dsh plugin --profile web add @guowenzhang/dsh-mcp-manager

# HTTPS
npx @deepseek-ai/dsh plugin --profile web add git+https://github.com/zhang-guo-wen/dsh-mcp-manager.git

# SSH
npx @deepseek-ai/dsh plugin --profile web add git+ssh://git@github.com/zhang-guo-wen/dsh-mcp-manager.git

# 固定发布 tag:默认分支上后续的临时提交不会被拿到
npx @deepseek-ai/dsh plugin --profile web add "git+ssh://git@github.com/zhang-guo-wen/dsh-mcp-manager.git#v1.0.0"
```

卸载(命令转发给 profile 目录里的 pnpm `remove`,并从 profile 清单里摘掉该依赖):

```sh
npx @deepseek-ai/dsh plugin --profile web remove @guowenzhang/dsh-mcp-manager
```

## 组合接线

`cordis.patch.yml` 是 bundle 层补丁,把插件行插进任何引用了本 bundle 的 profile:

```yaml
- insert:
    - id: mcp-manager
      name: '@guowenzhang/dsh-mcp-manager'
```

`package.json` 的 `dsh` 字段声明其余接线:`dsh.bundle.patch` 指向 `./cordis.patch.yml`;`dsh.client.inject` 列出
浏览器半边依赖的宿主包 —— `@deepseek-ai/dsh-api-gateway`、`@deepseek-ai/dsh-api-remotes`、
`@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-renderer`、
`@deepseek-ai/dsh-client-ui-settings`、`@deepseek-ai/dsh-client-ui-slots`,`platform` 为 `web`。入口是
`main` → `lib/index.mjs`、`./client` → `lib/client.js`,`./cordis.patch.yml` 也作为导出发布。

全局平面的 MCP 行由 file-backed `cordis.yml` 的 Include 提供;preset 平面的行写在 profile patch 里那条 preset
声明行的 `config.plugins`(见「MCP 行编写」)。

## 生效语义

- **host 半边是进程内模块**:插件代码在 host 启动时被 import,重建 `lib/` 不会替换运行中的代码 —— 必须重启宿主。
- **client 半边按内容 revision 提供**:Host 用 `lib/client.js` 的内容 revision 更新 bundle URL,改了 client 刷新页面
  即可;`HANDOFF_ID` 必须等于 `package.json` 的包名,改它会让 Web 启动图找不到该插件。
- **模式与规则是活设置**:加载模式、行描述、工具过滤提交后对所有会话的**下一次请求**生效,不需要重启。
  提交不同的加载模式会重建工具面并释放该模式的会话引用,无人再持有的按需连接随之停止(池对象本身只在插件卸载时关闭,
  见「按需连接池」)。
- **按需连接在宿主进程内常驻**:首次 `mcp_load` 起,活到最后一个会话释放引用、模式切换或插件卸载;
  **不跨宿主重启**(重启后需要重新 `mcp_load`);而"启动与声明重建永不 spawn"是无条件的,与之前是否加载过无关。

## 类型检查

```sh
npm run typecheck   # tsc --noEmit -p tsconfig.json
```

## 技术决策

加载相关的每条决策(结论、理由、被否决的替代方案、已知代价)归
[docs/design-decisions.md](docs/design-decisions.md),本仓不维护第二份:

| 编号 | 决策 | 一句话理由 |
|---|---|---|
| D1 | 「允不允许用」与「什么时候进上下文」是两个开关 | 两件正交的事用一个枚举表达不了 |
| D2 | 三种加载模式,默认 `dynamic` | 省 token 与工具绑定质量之间取默认值 |
| D3 | 按需工具的注册落在 host 平面 | 放 preset 作用域会让 preset 反复重挂 |
| D4 | 连接进宿主级常驻池,按 claim 引用计数释放 | 一台服务器在宿主进程内只起一次、跨会话复用,没有会话再用时才停 |
| D5 | 预加载靠「发布点抑制 + 挂载前拦截 + late hold」三条路径 | 行在 `apply` 后发布就处置 fiber、在 `apply` 前建好就拦截首次 `update`；全局行已随组合挂载时先遮蔽再 dispose（不写文件） |
| D6 | 工具过滤在返回与调用两点强制 | 只挡一处挡不住模型凭记忆直呼工具名 |
| D7 | `mcp_load` 结果带 `hidden` 计数 | 模型必须知道"还有工具但不可调用" |
| D8 | 载体由加载模式决定,规则只决定可见集合 | 模式才是「绑定 vs 缓存」的取舍,规则不该替用户改代价 |
| D9 | 服务器清单进系统提示,不做成列目录工具 | 模型看不到名字就加载不了,而这段常驻成本可用预算封顶 |
| D10 | 名册读声明 + live fiber,不等任何行的激活 | 等激活等于把 MCP 子进程启动时间(实测 7.5–23s)算进设置页 |
| D11 | 全局行写 Include 的文件 + `refresh()`,不走 Loader 写回 | Loader 写回会把带补丁的树拍平进用户的 `cordis.yml` |
| D12 | 批量新增一次提交(`addMcps`) | 一次 preset 写入 = 该 preset 每台 MCP 重启一轮 |
| D13 | 资源仓库 MCP 经内存接口交给管理器 | 保留资源管理器的数据所有权,同时让加载模式统一生效 |
| D14 | 预设读取经公开 Loader/scope 接口,按代次保存声明 | 不依赖已移除导出,不等待激活,不把旧会话改成新声明 |
| D15 | 配置不完整是独立状态,与加载模式分开 | 「按需可用」是模式的结果,不是用户要处理的状态 |
| D16 | 优化策略独立成页,粒度分选择/列表/形态三层 | 规范只给分页与 `ttlMs`,检索与只带名称只能在宿主侧做 |
| D17 | 「零拉起 + 宿主级常驻 + 引用计数」是一组取舍(2026-10-15) | 不用就不起、用过就留着、没人用才停(见 design-decisions.md) |

实现侧的理由与踩坑在本文各节(「延迟加载」「载体选择」「按需清单」「预加载闸门」「工具过滤」「优化策略」);同类插件对比与
功能路线图归 [docs/competitive-landscape.md](docs/competitive-landscape.md)。