> 覆盖：目录与文档分工、构建细节、Cordis 插件契约、Typert Remote、类型检查、部署/安装/组合接线、发版流程、测试与隔离实例的测量数据(含未覆盖项)、44 条易崩清单、D1–D17 决策表。何时读：动构建/打包/manifest/前后端通信契约/发版时，或需要历史读数与踩坑台账时。

# 工程契约与历史台账

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

## 测试

`npm test` 跑 `vitest run`,配置在仓根 `vitest.config.ts`。**必须带这份本地配置**:本仓是 harness checkout
的**兄弟目录**而不是它的 workspace,裸 `vitest run` 会继承 harness 根配置,一个 spec 都收不到
(`No test files found`)。配置把 `root` 钉在本仓，排除需要真实源码的 `*.harness.spec.ts`。

`npm run test:harness` 先重建分发产物，再跑真实 Loader/registry/scope 的兼容测试。
默认宿主位置为 `../../deepseek-harness`，可用 `DSH_HARNESS_ROOT` 指定其它 checkout。
覆盖导入/启动、pending Host injection、分组与表达式禁用、旧代/子代理、manager-only 重载和清单隔离。

`npm test` 现在是 **21 个 spec 文件 / 219 项**：合并进来的 UI 规范收敛一侧新增 `tests/client-css.spec.ts`
（TSX↔CSS 类名双向、token/圆角/焦点环/字号成对）与 `tests/config-issues.spec.ts`（诊断文案进字典）；本轮新增
`tests/mcp-pool.spec.ts`、`tests/fiber-publication.spec.ts`、
`tests/mcp-gate.spec.ts` 的 6 项**挂载前拦截**用例（`update` 直接返回、`init` 从未调用、`fiber` 保持 undefined；
非本插件的行与 `eager` 下立即还原；切回 `eager` 能撤销遮蔽并真正挂载）、全局平面的读取/拦截单测，以及
**`tests/mcp-row-state.spec.ts`（`rowAllowed`：明确 `false` 压过 `suppressed` 兜底）与全局写入目标/行级只读的单测**。
`npm run test:harness` 是 **6 个 harness spec / 25 项**（`zero-launch`（4 项）、`global-zero-launch`（**5 项**：
全局行在 `dynamic`/`lazy` 下不被 import、`eager` 下照常挂载、被 hold 的行能按需加载、组合已挂载的行由 late hold 接管、
切回 `eager` 后连用户文件一起完好）、`on-demand-pool`、`plugin-startup`、`preset-compat`、`global-toggle`）。
**2026-10-16 快照(合并 + 全局行开关修复后，最终产物)**：`npm test` **19/204 通过**、`npm run test:harness` **6/25 通过**、
`npm run typecheck` 与 `npm run build` 通过；产物 `lib/index.mjs` = `121B8C0A…`、`lib/client.js` = `E1B1051A…`。
**2026-10-16 合并快照（UI 规范收敛 + 「MCP 优化」设置页，当前工作树）**：`npm test` **21/219 通过**、
`npm run test:harness` **6/25 通过**、`npm run test:metadata` 通过、`npm run typecheck` 与 `npm run build` 通过、
`node _team/audit-ui-standard.mjs dsh-mcp-manager` **0 项**；产物 `lib/index.mjs` = `121B8C0A…`、
`lib/client.js` = `1D0FC432…`（合并后重建）。上一条与 `docs/testing.md` 里的 `E1B1051A…` client 产物是**合并前**
main 侧的历史读数。
**隔离实例实测通过（最终产物 `121B8C0A…`/`E1B1051A…`）**：`dynamic` 启动后四个 marker 全不存在、进程 0、
stderr 为空；`eager` 对照四台长期存活；多次 `mcp_load` 复用同一条子进程（同一 pid）、末位释放才停；全局行的
开关（形状 A：行写在自己的 Include 文件里）在设置页真正可用，被用户停用的行开关立即显示为关。
**两种全局行形状在这套 fixture 上都是"启动零拉起"**（1 秒间隔采样复测：marker 从未创建、进程 0）；
差别只在插件回调层面 —— 形状 B 的 `mcp-client` `apply` 会被调用一次（`applyCalls === 1`）但**没有留下子进程**，
形状 A 连回调都不发生。**推荐把全局行放在它自己的 file-backed Include 文件里**。**未覆盖**：真实 `npx -y` 冷启动路径、
GUI 里由模型决定的调用路径、`tools/list_changed` 跨会话 resync、活动实例内运行中切换加载模式、活动实例里的 `lazy` 池复用、
`mcp_search` 工具本身、新增/导入/删除行与编辑弹窗「保存」的浏览器实测、用户 Include 的注释保留
—— 明细见 [docs/testing.md](../docs/testing.md)。旧产物 `9B5D8D19…` / `D498FEC7…` 的读数保留在 testing.md 里作为历史。

**行为验证记录在 [docs/testing.md](../docs/testing.md)**：harness 回归的覆盖矩阵与结果、隔离实例实测（启动零拉起 /
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

## 类型检查

```sh
npm run typecheck   # tsc --noEmit -p tsconfig.json
```

## 技术决策

加载相关的每条决策(结论、理由、被否决的替代方案、已知代价)归
[docs/design-decisions.md](../docs/design-decisions.md),本仓不维护第二份:

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

实现侧的理由与踩坑在 `rules/` 各文件(「延迟加载」「载体选择」「按需清单」「预加载闸门」「工具过滤」「优化策略」);同类插件对比与
功能路线图归 [docs/competitive-landscape.md](../docs/competitive-landscape.md)。
