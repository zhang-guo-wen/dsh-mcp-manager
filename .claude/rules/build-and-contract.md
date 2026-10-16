---
paths:
  - "package.json"
  - "package-lock.json"
  - "cordis.patch.yml"
  - "tsconfig.json"
  - "tsdown.config.ts"
  - "build-client.mjs"
  - "README.md"
  - "README.zh.md"
  - "LICENSE"
  - "NOTICE"
  - ".gitignore"
  - "locale/**"
  - "src/remote.ts"
  - "src/client/index.ts"
---

> 覆盖：目录与文档分工、构建细节（tsdown / build-client.mjs / 装饰器降级）、Cordis 插件契约、Typert Remote、类型检查、部署/安装/组合接线、发版流程（自原「工程契约与历史台账」拆出）。何时读：动构建、打包、manifest、前后端通信契约或发版时。

# 构建、契约与发版

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
