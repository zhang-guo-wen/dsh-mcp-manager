# AGENTS.md

本仓 `dsh-mcp-manager` 是**独立于 harness monorepo** 的 DeepSeek Harness (DSH) 插件：
管理 MCP 服务器行(全局平面 + 各 agent preset)、决定允许的服务器何时进上下文、按行过滤工具,
并提供设置页的「MCP 管理」区块。

它与姊妹插件 `@zhang-guo-wen/dsh-claude-compat` 是**两个仓、两个包**:那边负责 Claude Code /
Codex 兼容与 `/btw`,这边负责 MCP。两者各有自己的设置命名空间(`context-injection` / `mcp-manager`)、
自己的设置页区块、自己的 Remote 命名空间,互不 import、互不依赖,可以单独安装与卸载。

它不打包 `@deepseek-ai/*`,运行时从宿主 harness 解析这些包。

## 目录

仓库根**就是**包:`package.json` 即 `@zhang-guo-wen/dsh-mcp-manager`。
这不是风格选择——`dsh plugin add <git-url>` 取的是仓库根,包放在 `packages/*` 下会被装成错误的东西。

- `src/` —— host 入口 `index.ts`;浏览器半边在 `src/client/`。
- `lib/` —— 构建产物:**已提交进仓库**(`index.mjs` host + `client.js` 浏览器 handoff),
  这样别人可以直接从 git 安装。改完源码**记得 `npm run build` 并把 `lib/` 一起提交**。
- `cordis.patch.yml` —— 把插件行插入组合的 bundle 层。
- `src/remote.ts` —— 手写的客户端 `TYPERT_REMOTE` 贡献对象。

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
- client 半边必须打成 `window.__ModuleLoader__.load({ id, factory })` 手接格式;id 与 `build-client.mjs`
  里的 `HANDOFF_ID` 一致。改动 client 后要 bump 它或强刷浏览器,否则浏览器一直跑旧 bundle。

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

**schema 用 `z.dict(z.any())`,不要在设置 schema 里校验规则。** 设置在 `~/.dsh/settings.yaml` 里是用户手写的,
schema 拒绝一个字段会让**整个 `mcp-manager` 命名空间**回退到上一次好的值(warn 后静默失效),
所以畸形值必须在读取时收敛:`parseMcpToolFilter` 跳过无法解析的条目,空规则不过滤任何东西。

旧的 `context-injection` 命名空间曾经同时装着 Claude/Codex 开关与 MCP 字段;拆分时把 MCP 三项搬到了这里,
字段名去掉了 `mcp` 前缀(命名空间已经表明归属)。

## MCP 行编写(src/mcp-authoring.ts)

MCP 行有两种来源,更新路径不同:

- **全局**:改 file-backed Include;新增走 `loader.create`,本身**实时生效**。
- **preset(agent)**:写 preset 的 `agent.cordis.yml`。写完必须让**正在运行的 preset** 感知:
  - 首选:拿 standing mount 的 `Include` 树调 **`tree.refresh()`** —— 按差异增量增删,只动改动那一行,亚秒级。
  - 兜底:`agentPresets.standingKeyFor(id)` —— 整棵重组,会把 preset 里**所有** MCP 子进程重启,3-4 秒。

开关 MCP 时 UI 用**行级乐观状态**(`启动中`/`停止中`)+ 后台异步,不要锁整列表。
启用本质要等 MCP 子进程启动(`npx -y …` / `uvx …` 通常 1-3 秒),那是进程启动耗时,不是插件开销;
用直接可执行文件替代 `npx -y` 能显著缩短。

**关键坑:模块实例不共享。** 插件里 `import { livePresetMounts } from '@deepseek-ai/dsh-agent-presets'`
可能解析到**与 harness 使用的不一样的副本**(harness 从源码经 tsx 加载,插件拿到构建版 `lib/index.js`),
导致模块级状态为空(`livePresetMounts()` 返回 0),`refresh()` 形同虚设。要经 loader 的内部解析器取同一实例:

```ts
const mod = await ctx.loader.internal.import('@deepseek-ai/dsh-agent-presets', ctx.baseUrl, {}) as {
  livePresetMounts(): readonly { presetId: string; tree: { refresh?(): Promise<void> } }[]
}
const mount = mod.livePresetMounts().filter(m => m.presetId === id).at(-1)
await mount?.tree.refresh?.()
```

### 延迟加载(src/lazy-mcp.ts)

**两件事分两个开关:** composition 行上的 `disabled` = 用户**允不允许用**(禁用 = 完全不用:不进
`mcp_list`,`mcp_load` 拒绝);`loading` 模式 = 允许的服务器**什么时候进上下文**。后者是
`mcp-manager` 用户设置(默认值取自 host 插件的 `Config`)**+ UI 三选一**。三种取值:

- `eager`:允许的行照常挂载;不注册按需工具。
- `dynamic`(默认):允许的行**默认不挂载**(见下面的 gate);`mcp_load` 把 mcp-client 挂进**调用方 agent
  的作用域**,原生注册工具。
- `lazy`:允许的行**默认不挂载**;**用 MCP SDK 直连、完全不注册工具**;`mcp_load` 把工具 schema 作为结果
  返回,模型用固定的 `mcp_call` 代理调用 → **工具列表永不变,请求缓存前缀零失效**。

`mcp_list` / `mcp_load` / `mcp_unload` / `mcp_call` 让一个会话**按需启动**某台 MCP,省掉工具 schema 的 token
(`mcp_call` 在 `dynamic` 与 `lazy` 下都注册,见"工具过滤";`eager` 下一个按需工具都不注册):

- 被**禁用**的 composition 行完全不参与:工具不进目录,也不能 `mcp_load`。
- `mcp_load` 走 **agent 作用域**:`exec.agent.ctx.plugin(mcpClientPlugin, config)`,实例随该会话销毁,
  注册的工具只进这个 agent 的层(所以一个会话加载的服务器不会漏到别的会话)。
- **连接按会话隔离,也按会话回收。** `mounted` 是 `Map<agentId, Map<serverName, MountedServer>>`:同一会话重复
  `mcp_load` 复用一份,不同会话各起一份(stdio 就是各一个子进程),子 agent / fork 出的会话都算独立 agent。
  `eager` 相反 —— preset 是 standing mount,全局共享一个实例。**native 载体**(dynamic 的原生注册)挂在 agent
  ctx 上,会话销毁时 Cordis 连它一起回收;但 **proxy 载体**是一个裸 SDK client,不绑定任何作用域,会话结束不会
  自动关 —— 所以 `bindAgentScope` 在某个会话第一次 load 时用 `agent.ctx.effect` 注册一次清理
  (`Agent.ctx` 的契约是 agent-local contributions "unwind on disposal"),会话销毁时 `releaseAgent` 收掉该
  会话的全部 mount。注意 `releaseAgent` **只 dispose proxy 载体**:native 的 handle 属于同一个正在销毁的 ctx,
  在那里再调一次它的 disposer 是多余的。
- 工具定义用 `@deepseek-ai/dsh-tools` 的 `defineTool` + `ctx.tools.register(def)`;`register` 返回 disposer,
  注册必须包在 `ctx.effect` 里。`exec.agent` 是拿到当前 agent 的唯一途径(无 agent 时要拒绝执行)。
- mcp-client 的插件对象**经 loader 内部解析**取得(`ctx.loader.internal.import`),与组合用的是同一个模块实例,
  否则 `serverName` 预留(模块级状态)不共享,可能挂出重复实例。

**坑(实测):不要把注册放在 preset 作用域。** 曾把按需工具做成 preset 行(`inject: ['tools']`,在 preset 的
standing 作用域里 `ctx.tools.register`),结果 **preset 每 ~5 秒被重挂一次**(MCP 子进程反复重启)。
撤掉该行即恢复。所以注册落在 **host 平面**(插件 `apply` 时的 root ctx):`ctx.effect` 收口。

模式是**活的用户设置**:`registerMcpSettings(ctx, config, onCommitted)` 把提交后的 flags 交给 host,
`onCommitted` 里先 `dispose()` 掉旧注册(连带停掉它启动的服务器)再按新模式注册 —— 交换对**所有会话的下一次
请求**生效。`parseMcpLoadingMode` 把无法识别的存量值收敛回 `dynamic`(设置文档是用户可编辑的,不能因为一个
拼错的值让提交失败)。UI 侧是 `McpSection.tsx` 的 `McpLoadingPicker`(三个 radio),读写 `loading` 字段。

### 预加载闸门(src/mcp-gate.ts)

`dynamic`/`lazy` 下"允许但不预加载"靠 **运行时摘行**实现:gate 读每个 preset 的**文件真值**(行 `disabled`)
得到 allowed,再让 live 行满足 `mounted === (allowed && mode === 'eager')`,用 `entry.update({disabled})`
驱动挂载/卸载。四条必须记住的性质:

1. **不写文件。** preset 树是 `PresetTree`,`write()` 是空实现(`agent-presets` 的契约:preset 是输入不是
   持久化目标),所以内存里摘行不会碰用户的 `agent.cordis.yml`。**全局平面的行绝不动** —— 它们的树是
   file-backed `Include`,`write()` 会把闸门的状态写回配置,所以全局行永远是"常驻挂载",不受加载模式影响。
2. **触发点。** 插件 `apply` 时 preset 还没挂载(`mounts=0`),所以主触发是 `tools/change`(**无过滤广播**),
   另订阅 `loader/entry-init` / `agent-preset/selected`。`reconcile()` 内部串行化,幂等,可重放。
3. **一次 reconcile 会真的 kill 掉 MCP 子进程**(`entry.update` 走 `Entry._dispose`),所以设置页先等
   `gateState`(它内部 await reconcile)再读名册,否则会看到"摘到一半"的名册。
4. **行是"先挂载、再被摘掉"的,所以每次 preset 首次挂载会有一次真实的启动+杀掉。** gate 是事件驱动的事后
   纠正,而 stdio 的 spawn 在 `mcp-client.apply` 里立刻发生,reconcile 还要读 preset 文件(IO),抢不过。
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

1. **过滤点有两处,不能只做一处。** `mcp_load` 的返回(模型看不到被隐藏的工具名)和 `mcp_call` 的入参校验
   (拿旧名字调用会被拒绝)。只做前者挡不住模型凭历史记忆直呼工具名。
2. **配了规则的行强制走代理通道**(`mode === 'lazy' || filterHidesAnything(filter)`)。`dynamic` 的原生注册由
   harness 的 `mcp-client` 全量挂载,`ctx.tools.register` 返回的 disposer 只在该包内部,插件拿不到单个工具的撤销权;
   `eager` 同理,所以 `eager` 下规则不生效 —— `index.ts` 的 `warnFiltersWithoutEffect` 会在启动和每次提交时警告。
   因为这条,**`mcp_call` 在动态/惰性两种模式下都注册**(只注册 lazy 是不够的)。
3. **规则 reader 是活闭包而不是快照**:`registerMcpTools(..., key => readToolFilter(key))`,`index.ts` 在
   `registerMcpSettings` 返回后把它指向 `flags().tools`。所以改规则不需要重建注册,下一次 `mcp_load` 就读到新值;
   已经加载的服务器保持加载时那套工具(不追溯)。

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
- **改 client 后必须重建 `lib/client.js` 并在浏览器强刷**(`HANDOFF_ID` 没 bump,浏览器会继续跑旧 bundle)。
  改了 CSS module 要核对类名两边都在:JSX 引用了 CSS 里没有的类只得到 `undefined`,静默无样式。

## MCP JSON 兼容

编辑器的 JSON 框接受多种写法,缺省要能推断:

- 省略 `type`:有 `command` → stdio;有 `url` → streamable-http。
- `{ "<name>": { … } }` 单键映射、`{ "mcpServers": { … } }` 包装 → 用 key 当 `serverName`(标题字段为空时)。
- 裸 spec `{ type, command, args }` → 从参数推断 `serverName`(如 `@upstash/context7-mcp` → `context7-mcp`)。

## 部署

用官方命令安装,它把参数转发给 profile 目录里的 pnpm,**并自行维护 profile 清单**(依赖与 `dsh.profile.bundles` 一起加):

```sh
dsh plugin --profile web add C:/02-codespace/deepseek-harness/dsh-mcp-manager   # 本地开发
dsh plugin --profile web add github:zhang-guo-wen/dsh-mcp-manager               # git 源
```

本地目录安装时 pnpm 建的是 **symlink(记作 `link:`)** —— 所以重建 `lib/` 后**重启即生效,无需重装**。
`file:` 依赖则可能退化成物理拷贝,那时改源码不会影响正在跑的 dsh,要重装或手动同步 `lib/`。
client 产物变了还要强刷浏览器(或 bump `HANDOFF_ID`)。

它与 `@zhang-guo-wen/dsh-claude-compat` 互相独立:可以只装其中一个。两个都装时,设置页会出现
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
7. 改 client 不 bump `HANDOFF_ID` / 不硬刷新 → 浏览器跑旧 bundle(表现为"改动没生效/开关不变")。
8. 用 `standingKeyFor` 做实时更新 → 每次整棵重组、重启所有 MCP、3-4 秒。
9. 直接用模块级 `livePresetMounts` 而不经 loader 解析 → 模块实例不同、返回空、更新无效。
10. 编辑 preset 后不调 `tree.refresh()` → 文件写了但运行态不变、UI 开关不动。
11. **在设置 schema 里校验 `tools` 值** → 一个写错的规则让整个命名空间回退,用户所有 MCP 设置静默失效。
