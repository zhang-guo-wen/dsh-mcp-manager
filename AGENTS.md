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

**两件事分两个开关:** composition 行上的 `disabled` = 用户**允不允许用**(禁用 = 完全不用:不进系统提示里的清单,
`mcp_load` 拒绝);`loading` 模式 = 允许的服务器**什么时候进上下文**。后者是
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

`mcp_load` / `mcp_unload`(+ `lazy` 下的 `mcp_call`)让一个会话**按需启动**某台 MCP,省掉工具 schema 的 token。
**服务器清单不做成工具,而是进系统提示**(见下面的「按需清单」),所以工具面只有三个:

- `mcp_load` / `mcp_unload`:两种按需模式下都注册;
- `mcp_call`:**只在 `lazy` 下注册** —— 那个模式不注册任何工具,它是唯一的调用通道;`dynamic` 下加载进来的工具
  按 `mcp__<server>__<tool>` 名字直接调;
- `eager`:一个按需工具都不注册,也没有清单段(那时工具本来就在请求里)。

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

### 按需清单(src/mcp-inventory.ts)

`dynamic`/`lazy` 下请求里没有任何 MCP 工具 schema,所以**服务器名单必须主动出版**:`registerMcpTools` 在
`systemPrompt.section` 上注册 `mcp-manager:on-demand`,位置用 harness 预留的 `MCP_SERVERS`(与 mcp-client 放
server instructions 同一个位置)。四条契约:

1. **渲染是纯函数。** `renderMcpInventory(rows, mode)` 只吃「名字 + 描述」,不碰 Loader/preset,所以 vitest 能直接跑。
2. **段文本是快照,装配时不能 await。** 系统提示装配是同步的,所以注册句柄持有 `inventory` 字符串,由返回的
   `refresh()` 重读 allowed rows 再渲染;`index.ts` 在 `gate.reconcile()` 之后、以及模式提交后各调一次。
   漏调的表现是模型看到上一版名单 —— 新增的行它永远加载不了。
3. **绝不写"是否已加载"。** 那会让每次 `mcp_load` 都重写系统提示 → 整个前缀(系统 + 工具 + 历史)失效,
   比工具列表变化贵得多。加载状态本来就在会话历史里。
4. **预算只削描述,不删名字。** 单条 80 字符、整段描述预算 900 字符;超预算先丢描述,**服务器名永远列全**
   (模型看不到名字的服务器就加载不了)。`interpolate: false` —— 描述是用户文本,`{{...}}` 必须原样保留。

`registerMcpTools` 因此返回 `{ dispose, refresh }` 而不是一个 disposer,第四参数也从单个 `filterFor` 变成
`{ filterFor, descriptionFor }` 两个活闭包。

清单段的原文(每行 `名字 — 描述`,描述取自该行的设置;这段是模型可见文本,改动要同步快照):

```
MCP servers available on demand: call `mcp_load` with one of these names to add that server's
tools to this session, and `mcp_unload` with the same name to release it again.

- alibaba-devops-mcp — 云效MCP，任务管理工具，可以操作
- playwright
```

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
3. **规则 reader 是活闭包而不是快照**:`registerMcpTools(ctx, mode, gate, { filterFor, descriptionFor })` 收的是读者,
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
17. **在清单段里写"是否已加载"** → 每次 `mcp_load` 都重写系统提示,整个缓存前缀(系统 + 工具 + 历史)失效一次,
    比工具列表变化贵得多。加载状态本来就在会话历史里。
18. **忘了调 `refresh()`**(新注册、模式提交、reconcile 之后) → 模型看到上一版名单:新增的 MCP 行它永远加载不了。

## 配置

插件行 `config:` 里的 `loading` 给出**允许的服务器默认怎么进上下文**;设置页的选择覆盖它。设置命名空间就是插件行
的 Config,命名空间名即行 id `mcp-manager`,所以字段名以 `src/settings.ts` 的 `McpSettingsConfig` 为准,写错的名字
会被 schema 忽略。

| 字段 | 默认 | 含义 |
|---|---|---|
| `loading` | `dynamic` | 允许的服务器默认怎么进上下文;设置页的选择覆盖它 |

```yaml
- name: '@guowenzhang/dsh-mcp-manager'
  config:
    loading: lazy
```

schema 默认值来自同文件的 `Config`(`loading: z.string().default('dynamic').volatile()`);无法识别的存量值由
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
npx @deepseek-ai/dsh plugin --profile web add "git+ssh://git@github.com/zhang-guo-wen/dsh-mcp-manager.git#v0.1.0"
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
| D4 | 连接按会话隔离,随会话回收 | 一个会话加载的服务器不能漏给别的会话,也不能活过它 |
| D5 | 预加载靠运行时摘行(gate),不写文件 | preset 是输入不是持久化目标 |
| D6 | 工具过滤在返回与调用两点强制 | 只挡一处挡不住模型凭记忆直呼工具名 |
| D7 | `mcp_load` 结果带 `hidden` 计数 | 模型必须知道"还有工具但不可调用" |
| D8 | 载体由加载模式决定,规则只决定可见集合 | 模式才是「绑定 vs 缓存」的取舍,规则不该替用户改代价 |
| D9 | 服务器清单进系统提示,不做成列目录工具 | 模型看不到名字就加载不了,而这段常驻成本可用预算封顶 |

实现侧的理由与踩坑在本文各节(「延迟加载」「载体选择」「按需清单」「预加载闸门」「工具过滤」);同类插件对比与
功能路线图归 [docs/competitive-landscape.md](docs/competitive-landscape.md)。
