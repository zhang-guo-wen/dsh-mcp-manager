# AGENTS.md

本仓 `dsh-mcp-manager` 是**独立于 harness monorepo** 的 DeepSeek Harness (DSH) 插件：
管理 MCP 服务器行(全局平面 + 各 agent preset)、决定允许的服务器何时进上下文、按行过滤工具,
并提供设置页的「MCP 管理」区块。

它与姊妹插件 `@guowenzhang/dsh-claude-compat` 是**两个仓、两个包**:那边负责 Claude Code /
Codex 兼容与 `/btw`,这边负责 MCP。两者各有自己的设置命名空间(`context-injection` / `mcp-manager`)、
自己的设置页区块、自己的 Remote 命名空间,互不 import、互不依赖,可以单独安装与卸载。

它不打包 `@deepseek-ai/*`,运行时从宿主 harness 解析这些包。

## 目录

仓库根**就是**包:`package.json` 即 `@guowenzhang/dsh-mcp-manager`。
这不是风格选择——`dsh plugin add <git-url>` 取的是仓库根,包放在 `packages/*` 下会被装成错误的东西。

- `src/` —— host 入口 `index.ts`;浏览器半边在 `src/client/`。
- `src/mcp-carrier.ts` —— 载体选择(`carrierFor`)与原生注册原语(`nativeDefinitions` / `swapNativeTools`)。
  纯逻辑:只 import `node:crypto` 与同仓纯模块,不碰 harness 运行时包,所以 vitest 能直接跑到。
  `src/mcp-tool-name.ts` —— 公开工具名契约,镜像 mcp-client 的 `publicToolName`。
- `lib/` —— 构建产物:**已提交进仓库**(`index.mjs` host + `client.js` 浏览器 handoff),
  这样别人可以直接从 git 安装。改完源码**记得 `npm run build` 并把 `lib/` 一起提交**。
- `cordis.patch.yml` —— 把插件行插入组合的 bundle 层。
- `src/remote.ts` —— 手写的客户端 `TYPERT_REMOTE` 贡献对象。
- `docs/design-decisions.md` —— 加载相关决策的参考页(为什么这样设计、否决过什么、Claude 先例对照)。
  改加载模式、闸门、工具过滤的语义时先读它,并把新决策补进去。
- `docs/competitive-landscape.md` —— 同类插件对比与功能路线图(社区三簇做法、逐维度差距、P0-P3 待办)。
  决定"下一步做什么"前先读它,做完一条就地更新。

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

`mcp-manager` 命名空间属于本插件,字段三个:`loading`(加载模式)、`descriptions`(行描述)、
`tools`(每行工具过滤规则)。键统一是 `mcpRowKey(target, serverName)`(`preset:<id>:<name>` / `global:<name>`)。

**schema 用 `z.dict(z.any())`,不要在设置 schema 里校验规则。** 设置由用户手写在 active profile 的 `cordis.patch.yml` 里,
schema 拒绝一个字段会让**整个 `mcp-manager` 命名空间**回退到上一次好的值(warn 后静默失效),
所以畸形值必须在读取时收敛:`parseMcpToolFilter` 跳过无法解析的条目,空规则不过滤任何东西。

旧的 `context-injection` 命名空间曾经同时装着 Claude/Codex 开关与 MCP 字段;拆分时把 MCP 三项搬到了这里,
字段名去掉了 `mcp` 前缀(命名空间已经表明归属)。

## MCP 行编写(src/mcp-authoring.ts)

MCP 行有两种来源,更新路径不同:

- **全局**:改 file-backed Include;新增走 `loader.create`,本身**实时生效**。
- **preset(agent)**:改 **profile patch 里那条 preset 声明行**的 `config.plugins`,经 `configEditor.edit` 写。
  写入本身就是生效:editor 落盘后 reconcile 该 entry,声明行重建、按 diff 挂/摘改动的那一行。
  **不要再写 `agent.cordis.yml`,也不要再调 `tree.refresh()`/`standingKeyFor`** —— 目录预设与增量 refresh
  的契约在 0.1.7 已随 "declare Agent compositions in profile YAML" 一起移除。

开关 MCP 时 UI 用**行级乐观状态**(`启动中`/`停止中`)+ 后台异步,不要锁整列表。
启用本质要等 MCP 子进程启动(`npx -y …` / `uvx …` 通常 1-3 秒),那是进程启动耗时,不是插件开销;
用直接可执行文件替代 `npx -y` 能显著缩短。

**关键坑:模块实例不共享。** 插件里 `import { livePresetMounts } from '@deepseek-ai/dsh-agent-preset-registry'`
可能解析到**与 harness 使用的不一样的副本**(harness 从源码经 tsx 加载,插件拿到构建版 `lib/index.js`),
导致模块级状态为空(`livePresetMounts()` 返回 0)。要经 loader 的内部解析器取同一实例:

```ts
const mod = await ctx.loader.internal.import('@deepseek-ai/dsh-agent-preset-registry', ctx.baseUrl, {}) as {
  livePresetMounts(within?: unknown): readonly { presetId: string; tree: { entries(): Iterable<unknown> } }[]
}
```

声明真值不走这个模块:它由 `configEditor`(`ctx.get('configEditor')`)提供,见 `src/preset-source.ts`。

### 延迟加载(src/lazy-mcp.ts)

**两件事分两个开关:** composition 行上的 `disabled` = 用户**允不允许用**(禁用 = 完全不用:不进
`mcp_list`,`mcp_load` 拒绝);`loading` 模式 = 允许的服务器**什么时候进上下文**。后者是
`mcp-manager` 用户设置(默认值取自 host 插件的 `Config`)**+ UI 三选一**。三种取值:

- `eager`:允许的行照常挂载;不注册按需工具。
- `dynamic`(默认):允许的行**默认不挂载**(见下面的 gate);`mcp_load` 把 mcp-client 挂进**调用方 agent
  的作用域**,原生注册工具。**配了工具过滤规则的行**改走下面「载体选择」里的原生式注册:只注册可见工具。
- `lazy`:允许的行**默认不挂载**;**用 MCP SDK 直连、完全不注册工具**;`mcp_load` 把工具 schema 作为结果
  返回,模型用固定的 `mcp_call` 代理调用 → **工具列表永不变,请求缓存前缀零失效**。

三种模式的取舍、否决过的替代方案,以及 Claude Code / Messages API 的延迟加载先例对照,见
[docs/design-decisions.md](docs/design-decisions.md);本节只讲实现契约。

### 载体选择(src/mcp-carrier.ts)

**载体由模式决定,规则只决定可见集合**(决策 D8)。`carrierFor(mode, filter)`:

| 模式 | 无规则 | 有规则 |
|---|---|---|
| `lazy` | `proxy` | `proxy` |
| `dynamic` | `mount`(整台交给 mcp-client) | `native`(插件只注册可见工具) |
| `eager` | `undefined`(不注册按需工具) | `undefined`(规则不生效并 warn) |

**`native` 载体怎么工作:** SDK 直连 → `listTools` → `filterMcpTools` 只留可见的 → `nativeDefinitions` 用
harness 自己的 `createMcpToolDefinition`(`@deepseek-ai/dsh-mcp-client` 的公开根导出,经 loader 取同一实例)造定义 →
`swapNativeTools` 注册进 **`agent.ctx.get('tools')`**。三条必须记住的事:

1. **注册必须落在调用方 agent 作用域。** 用 `agent.ctx.get('tools')`,不要用插件 root ctx 上那份 —— Cordis 的
   `ctx.get` 返回 scope 绑定的可追踪代理(`reflect.get` → `getTraceable`),`this.ctx` 因此是该 agent 的 ctx,
   `register` 才落进那个层。用 root 那份会变成全局注册,工具漏给所有会话。
2. **注册代次按名字 diff 替换**(`swapNativeTools`):新增的先注册、消失的最后撤销、存活的名字保持原注册 ——
   工具列表只在服务器真的改动处变化,前缀不会因为无关工具重建而失效。任一注册失败要把本次新增的全部撤销再抛,
   与 mcp-client 的「整代或零代」一致。
3. **`tools/list_changed` 要重新同步**:SDK 没有该通知的专用 handler,它走 `client.fallbackNotificationHandler`;
   重新列目录后按**加载时那套规则**重算可见集合,再换一代注册。同一个 mount 上的重同步串行化(`mount.resyncing`),
   因为服务器可能在上一次交换还没完成时再报一次变化。

**`mcp_call` 只服务 `proxy`**:其余载体的行调用它会直接报错让模型按名字调。它在每种按需模式下都注册,因为它服务的
是 `lazy`,而模式是活设置,注册不能跟着某个模式走。

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

`mcp_list` / `mcp_load` / `mcp_unload` / `mcp_call` 让一个会话**按需启动**某台 MCP,省掉工具 schema 的 token
(`mcp_call` 在每种按需模式下都注册 —— 它服务 `lazy`,而模式是活设置;`eager` 下一个按需工具都不注册):

- 被**禁用**的 composition 行完全不参与:工具不进目录,也不能 `mcp_load`。
- `mcp_load` 走 **agent 作用域**:无规则时 `exec.agent.ctx.plugin(mcpClientPlugin, config)`,实例随该会话销毁,
  注册的工具只进这个 agent 的层(所以一个会话加载的服务器不会漏到别的会话);有规则时插件自己
  `agent.ctx.get('tools').register(...)`(见「载体选择」)。
- **连接按会话隔离,也按会话回收。** `mounted` 是 `Map<agentId, Map<serverName, MountedServer>>`:同一会话重复
  `mcp_load` 复用一份,不同会话各起一份(stdio 就是各一个子进程),子 agent / fork 出的会话都算独立 agent。
  `eager` 相反 —— preset 是 standing mount,全局共享一个实例。**`mount` 载体**的 handle 挂在 agent ctx 上,
  会话销毁时 Cordis 连它一起回收,`releaseAgent` 不必再动它;但 **`proxy` 与 `native` 载体**是裸 SDK client
  (native 还额外持有注册),不绑定任何作用域,会话结束不会自动关 —— 所以 `bindAgentScope` 在某个会话第一次
  load 时用 `agent.ctx.effect` 注册一次清理(`Agent.ctx` 的契约是 agent-local contributions "unwind on
  disposal"),会话销毁时 `releaseAgent` 收掉该会话剩下的全部 mount。`dispose` 包了 `once`,因为 native 的注册
  本来也会随同一个 ctx 销毁,两条路径都可能到达它。
- 工具定义用 `@deepseek-ai/dsh-tools` 的 `defineTool` + `ctx.tools.register(def)`;`register` 返回 disposer,
  注册必须包在 `ctx.effect` 里。`exec.agent` 是拿到当前 agent 的唯一途径(无 agent 时要拒绝执行)。
- mcp-client 的插件对象**经 loader 内部解析**取得(`ctx.loader.internal.import`),与组合用的是同一个模块实例,
  否则 `serverName` 预留(模块级状态)不共享,可能挂出重复实例。

**坑(实测):不要把注册放在 preset 作用域。** 曾把按需工具做成 preset 行(`inject: ['tools']`,在 preset 的
standing 作用域里 `ctx.tools.register`),结果 **preset 每 ~5 秒被重挂一次**(MCP 子进程反复重启)。
撤掉该行即恢复。所以注册落在 **host 平面**(插件 `apply` 时的 root ctx):`ctx.effect` 收口。

模式是**活的用户设置**:`readMcpSettings(config)` 读 Config 的 volatile 字段,`index.ts` 在
`loader/volatile-update` 上先 `dispose()` 掉旧注册(连带停掉它启动的服务器)再按新模式注册 —— 交换对
**所有会话的下一次请求**生效。`parseMcpLoadingMode` 把无法识别的存量值收敛回 `dynamic`(设置文档是用户可编辑的,不能因为一个
拼错的值让提交失败)。UI 侧是 `McpSection.tsx` 的 `McpLoadingPicker`(三个 radio),读写 `loading` 字段。

### 预加载闸门(src/mcp-gate.ts)

`dynamic`/`lazy` 下"允许但不预加载"靠 **运行时摘行**实现:gate 读每个 preset 的**声明真值**(声明行
`config.plugins` 里那一行的 `disabled`)得到 allowed,再让 live 行满足
`mounted === (allowed && mode === 'eager')`,用 `entry.update({disabled})` 驱动挂载/卸载。
**必须读声明,不能读 live 行** —— live 行正是 gate 自己摘掉的,读回来会把摘过的行永久锁死。
四条必须记住的性质:

1. **不写声明。** preset 树是 registry 的内存树(`PresetTree`),`write()` 是空实现,所以内存里摘行不会
   碰用户的 profile patch。**全局平面的行绝不动** —— 它们的树是 file-backed `Include`,`write()` 会把
   闸门的状态写回配置,所以全局行永远是"常驻挂载",不受加载模式影响。
2. **触发点。** 插件 `apply` 时 preset 还没挂载(`mounts=0`),所以主触发是 `tools/change`(**无过滤广播**),
   另订阅 `loader/entry-init` / `agent-preset/selected`。`reconcile()` 内部串行化,幂等,可重放。
3. **一次 reconcile 会真的 kill 掉 MCP 子进程**(`entry.update` 走 `Entry._dispose`),所以设置页先等
   `gateState`(它内部 await reconcile)再读名册,否则会看到"摘到一半"的名册。
4. **行是"先挂载、再被摘掉"的,所以每次 preset 首次挂载会有一次真实的启动+杀掉。** gate 是事件驱动的事后
   纠正,而 stdio 的 spawn 在 `mcp-client.apply` 里立刻发生,reconcile 还要读声明,抢不过。
   宿主启动时不会启动(那时 preset 未挂载);第一个使用该 preset 的会话会触发这一次,因为 preset 是
   standing mount,每个 host 生命周期只发生一次。要消除它需要 harness 侧让 `mcp-client` 在 apply 早期
   就知道自己被抑制,插件做不到。

同名坑:**`@Remote` 方法的形参名必须是 `request`**。网关按方法签名推导描述符,写成 `_request` 会让调用方收到
`args fields do not match the descriptor: unexpected "request"`,而客户端如果吞掉这个错误,表现就是"开关没反应"。

### 工具过滤(src/mcp-tool-filter.ts)

一台服务器几十个工具、常用只有几个时,`mcp_load` 一次就把全部 schema 倒进会话历史。过滤规则存在
`mcp-manager` 设置的 `tools` 字段里,键是 `mcpRowKey(target, serverName)`,值是一个字符串数组:

- 不带 `!` 的条目 = 保留(allow);只要有一个 allow 条目,这台服务器就是**白名单**;
- `!` 开头的条目 = 隐藏(deny);只有 deny 条目时是**黑名单**;
- `*` / `?` 通配,其余正则元字符都转义,大小写敏感。

三条实现约束:

1. **过滤点跟着载体走。** `proxy` 载体两个点都要:`mcp_load` 的返回(模型看不到被隐藏的工具名)与 `mcp_call`
   的入参校验(拿旧名字调用会被拒绝)。`native` 载体只需要前者 —— 被隐藏的工具根本没有注册,模型照历史名字调用
   直接得到未知工具;`mcp_call` 对这类行也拒绝(它只服务 `proxy`)。
2. **过滤不切换载体**(见「载体选择」)。`eager` 下规则不生效 —— 该模式由 harness 的 mcp-client 整台挂载,插件没有
   插手的点 —— `index.ts` 的 `warnFiltersWithoutEffect` 会在启动和每次提交时警告。
3. **规则 reader 是活闭包而不是快照**:`registerMcpTools(..., key => readToolFilter(key))`,`index.ts` 在
   `apply` 里把它指向 `readSettings().tools`。所以改规则不需要重建注册,下一次 `mcp_load` 就读到新值;
   已经加载的服务器保持加载时那套工具(不追溯),服务器自己发 `tools/list_changed` 时也按加载时那套规则重算。

`mcp_load` 的结果带 `hidden` 字段(被隐藏的数量),render 里有一行提示 —— 模型需要知道"还有工具但不可调用",
否则会照历史里的名字硬调。

### 工具选择 UI(src/client/McpEditor.tsx)

编辑弹窗底部的"工具"区块是规则的可视化入口:勾选 = 可见,取消勾选 = 隐藏,默认全勾。

- **数据来自 `mcpManager.listMcpTools`**(`mcp-remote.ts`),它按**表单当前的 spec** 连一次服务器并
  `listTools`,返回 `{name, description}[]`,完成后 close。之所以传 spec 而不是 `entryId`:新增行还没有 entryId,
  而且用户在弹窗里改了 command/url 后点"加载工具列表"应该按新配置拉。连接有 30 秒超时(`withTimeout`)。
- **默认全勾 = 没有规则。** 勾选状态由 `admits(parseMcpToolFilter(toolRulesInitial), name)` 算出,所以手写的
  allow/通配规则在 UI 里也显示正确;保存时展开成 `!<name>` 的 deny 列表,全勾则写空数组 → 删掉该键。
- **连不上就不动规则。** `tools === null` 时保存只提交连接配置 —— 否则一次连接抖动会清掉用户已有的过滤。
- **每次打开弹窗会真起一个 MCP 连接**(stdio 是新的子进程,`npx -y` 那种 1-3 秒)。edit 模式自动拉,add 模式靠按钮,
  因为新增时表单里的 spec 常常还是空的。
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

六条实现约束:

1. **只读,且只写全局。** 扫描不挂载任何东西、不碰任何 composition;导入逐条调**现有的 `addMcp`**
   (`target: { scope: 'global' }`),因此校验、冲突检测、原子写与手工新增完全同一条路径。
   **不要为导入新写一条写入路径** —— 那会绕开上面的每一项。
2. **一个来源坏掉不能拖垮其它来源。** 文件不存在 → 整个来源不出现;存在但读不出/不是 JSON → 该来源带
   `problem` 返回(`missing`/`unreadable`/`malformed`/`too-large`),其余来源照常导入。
3. **名称先按 composition 规范预检。** `mcp-client` 的 `serverName` 必须匹配 `/^[A-Za-z0-9_-]{1,32}$/`,
   所以带空格或超长的名字标成 `problem: 'unsupported-name'` 并**预先不勾选**,而不是等导入时报一句
   "serverName must match …"。实测真实 `~/.claude.json` 里 `MiniMax` 合法、`my server` 不合法。
4. **分批导入,单条失败不中断。** 每台各调一次 `addMcp`,失败记在自己名下,结束时汇总
   「已导入 N 台,M 台失败」。一台重名不能让其余全部白导。
5. **`env`/`headers` 的值必须跟着 `spec` 走**(否则导进去的服务器连不上),但 UI 只显示键名
   (`envKeys`)。所以**不要往诊断里打 spec** —— 它带着明文凭据。
6. **导入只写全局是有意为之**(用户选定的范围)。要导入到 preset 需要在弹窗里加 scope 选择并复用
   `addMcp` 的 preset 分支,`writePresetRows`(`configEditor.edit`)那套已经就绪。

`scanClaudeMcp(cwd, home?)` 的 `home` 可注入,`tests/claude-import.spec.ts` 就是靠它跑临时 fixtures;
默认取真实 `homedir()`。

## 测试

`npm test` 跑 `vitest run`,配置在仓根 `vitest.config.ts`。**必须带这份本地配置**:本仓是 harness checkout
的**兄弟目录**而不是它的 workspace,裸 `vitest run` 会继承 harness 根配置,一个 spec 都收不到
(`No test files found`)。配置把 `root` 钉在本仓、只收 `tests/**/*.spec.ts`。

## 部署

用官方命令安装,它把参数转发给 profile 目录里的 pnpm,**并自行维护 profile 清单**(依赖与 `dsh.profile.bundles` 一起加):

```sh
dsh plugin --profile web add C:/02-codespace/deepseek-harness/dsh-mcp-manager   # 本地开发
dsh plugin --profile web add github:zhang-guo-wen/dsh-mcp-manager               # git 源
```

本地目录安装时 pnpm 建的是 **symlink(记作 `link:`)** —— 所以重建 `lib/` 后**重启即生效,无需重装**。
`file:` 依赖则可能退化成物理拷贝,那时改源码不会影响正在跑的 dsh,要重装或手动同步 `lib/`。
client 产物变了由 Host 的内容 revision 切换 bundle;必要时刷新浏览器,不要修改 `HANDOFF_ID`。

它与 `@guowenzhang/dsh-claude-compat` 互相独立:可以只装其中一个。两个都装时,设置页会出现
「Claude 兼容」与「MCP 管理」两个独立区块。

## 发版(Release)

`lib/` 是提交进仓库的,所以**发版 = 改版本号 + 构建 + 提交产物 + 打 tag**。别人按 tag 安装,
`master` 上的临时提交不会被他们拿到。

1. 改根 `package.json` 的 `version`。
2. `npm run build`,确认 `lib/index.mjs` 与 `lib/client.js` 是最新的。
3. 提交源码与 `lib/`(不要把 `lib/` 落在外面的工作区)。
4. 打带注释的 tag 并推送:

   ```sh
   git tag -a v<version> -m "dsh-mcp-manager <version>"
   git push origin master --follow-tags
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
9. 直接用模块级 `livePresetMounts` 而不经 loader 解析 → 模块实例不同、返回空、更新无效。
10. **写 preset 行绕过 `configEditor.edit`**(或再去写 `agent.cordis.yml`) → profile patch 没落盘,运行态也不会 reconcile,UI 开关不动。
11. **在设置 schema 里校验 `tools` 值** → 一个写错的规则让整个命名空间回退,用户所有 MCP 设置静默失效。
12. **把 `env`/`headers` 的值打进日志或错误消息** → 明文凭据落进会话与日志文件;导入的服务器恰恰都是带 token 的。
13. **给导入单写一条写入路径** → 绕开 `addMcp` 的冲突检测与原子写,重名会写出重复行。
14. **把原生载体的工具注册到插件 root ctx**(而不是 `agent.ctx.get('tools')`) → 工具变成全局注册,漏给所有会话。
15. **自己拼 MCP 工具定义而不用 `createMcpToolDefinition`** → 丢 canonical 结果校验、`isError`、图片落盘与 PTC 投影。
16. **复刻工具名时漏掉 mcp-client 的规范化与哈希** → 同一个工具在不同载体下拿到两个名字,`mcp__<serverName>__`
    前缀的命名空间与 toolview 失准。
