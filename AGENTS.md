# AGENTS.md

本仓 `dsh-mcp-manager` 是**独立于 harness monorepo** 的 DeepSeek Harness (DSH) 插件：管理 MCP 服务器行
(全局平面 + 各 agent preset)、决定允许的服务器何时进上下文、按行过滤工具，并提供设置页的「MCP 管理」区块。
它不打包 `@deepseek-ai/*`，运行时从宿主 harness 解析这些包。

**本文是导航页，不是全文。** 只放定位、命令、红线与索引；明细按主题放在包根 `.claude/rules/<topic>.md`，做到
对应的事时再读那一份。机制：每个规则文件带非空 `paths:` frontmatter（项目根相对、正斜杠、gitignore 风格 glob），
`dsh-claude-compat` 在 agent **读到匹配 glob 的文件之后**、于下一次请求把它注入（每会话至多一次）；也可以直接
`read .claude/rules/<topic>.md` 主动加载。一次 `read` 会把命中的**所有**规则一起注入，所以大文件各挂窄 glob、
不共用宽 glob。`.claude/` 不在 `package.json` 的 `files` 里，不进 npm 包。原文每条规范性要求都落在本文或
`.claude/rules/` 里。

## 目录

仓库根**就是**包：`package.json` 即 `@guowenzhang/dsh-mcp-manager`。`dsh plugin add <git-url>` 取的是仓库根，
包放在 `packages/*` 下会被装成错误的东西。

- `src/` —— host 入口 `index.ts`；浏览器半边在 `src/client/`（`McpSection.tsx`、`McpEditor.tsx`、
  `McpTargetSelect.tsx`、`McpOptimizeSection.tsx`、`locales.ts`，纯规则 `agent-filter.ts`、`mcp-row-state.ts`）。
  过滤规则放 `agent-filter.ts`，**不要挪回 controller**（`settings-controller.ts` 会经
  `@deepseek-ai/dsh-client-store` 拉进 `zustand`，在 Node 里加载即报 `Cannot find package 'zustand'`）。
- 纯逻辑模块（只 import `node:crypto` 与同仓纯模块，不碰 harness 运行时，vitest 直接跑）：`mcp-carrier.ts`、
  `mcp-pool.ts`、`mcp-inventory.ts`、`mcp-tool-filter.ts`、`mcp-optimize.ts`、`mcp-spec.ts`、
  `mcp-diagnostics.ts`、`mcp-variable-refs.ts`、`mcp-tool-name.ts`。
- 宿主侧其余：`mcp-gate.ts`（预加载闸门）、`mcp-authoring.ts`（行写入）、`mcp-roster.ts`（名册）、
  `mcp-global-include.ts`（缺可写 Include 时创建 profile 自己的 `mcp.cordis.yml` 并往 patch 层追加
  `cordis:include` 行，再触发热重载）、`preset-mounts.ts` / `preset-source.ts`、`external-mcp.ts`、`mcp-tokens.ts`（工具定义 token 估算）、
  `settings.ts`、
  `remote.ts`（手写的客户端 `TYPERT_REMOTE` 贡献对象）、`mcp-modules.ts`（宿主包名常量，gate 与组合读取共用一份拼写）。
- `lib/` —— 构建产物**已提交进仓库**（`index.mjs` host + `client.js` 浏览器 handoff），别人可直接从 git 安装。
- `cordis.patch.yml` —— 把插件行插入组合的 bundle 层。
- `docs/design-decisions.md`（加载决策 D1 起）、`docs/competitive-landscape.md`（同类对比与路线图）、
  `docs/testing.md`（行为验证记录）是参考页：改加载模式、闸门、工具过滤的语义前先读第一份并把新决策补进去；
  决定"下一步做什么"前读第二份，做完一条就地更新；改加载行为后按第三份复跑并把新结果写回去。

## 构建与测试

```sh
npm run build          # host:tsdown 打 src/index.ts → lib/index.mjs（@deepseek-ai/* 与 @modelcontextprotocol/* 保持 external）
                       # client:build-client.mjs(rolldown) → lib/client.js，包成 window.__ModuleLoader__.load({ id, factory })
npm run typecheck      # tsc --noEmit -p tsconfig.json
npm test               # vitest run，配置在仓根 vitest.config.ts，排除需要真实源码的 *.harness.spec.ts
npm run test:harness   # 先重建分发产物，再跑真实 Loader/registry/scope 兼容测试；默认宿主 ../../deepseek-harness，
                       # 可用 DSH_HARNESS_ROOT 指定其它 checkout
```

- **改完源码必须 `npm run build`，并把 `lib/` 与源码一起提交** —— `lib/` 落在工作区外面就等于没交付。
- **Node 不解析 TC39 装饰器**：`tsdown.config.ts` 的 `lowerDecorators` transform（用 `typescript` 的
  `transpileModule`）负责降级含 `@装饰器` 的文件；少了它 `McpManager` 的 `@Remote` 会以原始语法留在
  `lib/index.mjs`，host 加载即崩。
- 改 client 半边必须重建 `lib/client.js`：Host 用内容 revision 更新 bundle URL，
  **`HANDOFF_ID` 必须始终等于 `package.json` 的包名**，不要通过修改它做缓存失效。
- 本仓是 harness checkout 的**兄弟目录**而不是它的 workspace：裸 `vitest run` 会继承 harness 根配置，
  一个 spec 都收不到（`No test files found`）。
- 构建细节、测试快照与隔离实例读数见 [.claude/rules/testing-and-measurements.md](.claude/rules/testing-and-measurements.md)。

## 关键硬约束

1. **日常 Harness 实例不动**：不得停止、重启、升级或修改日常使用的实例，也不得向它安装测试插件或改动其配置、
   凭据、数据。测试实例用 npm 发布版 + 随机高位端口 + 独立 `DSH_HOME` 命名空间。
2. **两个平面都不写声明。** 闸门只在内存里拦截：全局行**绝不能用 `loader.create`/`loader.update`**
   （`Include.write()` 会把带补丁的整棵树写回用户文件），也**绝不能用发布点 `fiber.dispose()`**
   （`entry.options.disabled = true` + `tree.write()` 会把闸门状态写回用户的 `cordis.yml`）；全局行只能
   "改 Include 文件 + `Include.refresh()`"，或遮蔽 + `entry.update`（`Entry.update` 不写文件）。
3. **连接属于宿主，不属于加载它的会话**：池按「行身份 + 连接配置指纹」去重、按 claim 引用计数释放，
   **最后一个 claim 释放时才关闭连接**；指纹只进键与日志，`env`/`headers` 的值不落日志、不进错误消息。
4. **注册落点不可错**：按需工具必须注册进**调用方 agent 作用域**（`agent.ctx.get('tools')`，用插件 root ctx
   那份会变成全局注册、漏给所有会话）；按需工具本身的注册落 host 平面（`apply` 时的 root ctx + `ctx.effect`），
   **不要放 preset 作用域**（实测会让 preset 每 ~5 秒重挂一次）。
5. **`@Remote` 服务无条件注册**（用前置守卫挡住时服务根本不注册，客户端 RPC 收到 404）；新增 Remote 方法要
   **三处齐**（`@Remote('x')` 方法 + `src/remote.ts` 的 descriptor + `src/client/index.ts` 的接口），
   **形参必须叫 `request`**，strict codec 两种 schema 座位都要带。
6. **不依赖已移除的契约**：`livePresetMounts` 已删；不要再写 `agent.cordis.yml`，不要再调
   `tree.refresh()`/`standingKeyFor`；preset 行只能经 `configEditor.edit` 写。
7. **规则只实现一份**：`mcp-spec.ts`（JSON 推断）、`mcp-optimize.ts`（策略默认值与收敛）、`mcp-tool-name.ts`
   （工具名契约）、`createMcpToolDefinition`（工具定义）、`rowAllowed`（客户端开关判据）都不许有第二份实现。
8. **凭据纪律**：不要把 spec / `env` / `headers` 的值打进日志、错误消息或诊断。
9. **活设置不要靠重建注册**：除加载模式与 `search` 开关外，策略字段一律在调用点读活值。
10. **没跑过的项不要写成已通过**；改加载、池或闸门行为后按 `docs/testing.md` 复跑并把新结果写回去。
11. **45 条易崩清单**在 [.claude/rules/pitfalls-and-decisions.md](.claude/rules/pitfalls-and-decisions.md)，动相关代码前先扫一遍。

## 详细规则

明细在 `.claude/rules/`，每条自带 `paths:`（触发 glob）；编辑对应文件时会自动注入，也可直接 `read` 主动加载。

- [loading-modes-and-carrier.md](.claude/rules/loading-modes-and-carrier.md)：`loading` 三模式、载体选择、`native` 注册契约与作用域语义、模式切换生效；改加载模式/载体/工具面时读。
- [preload-gate.md](.claude/rules/preload-gate.md)：三条抑制路径、归属判据、`reconcile` 与「不写声明」红线；改闸门或排查「启动被拉起 / 切回 `eager` 不恢复」时读。
- [connection-pool.md](.claude/rules/connection-pool.md)：常驻池去重键、claim 引用计数、`mcp_unload` 三分支、存活语义与凭据纪律；改池或释放语义时读。
- [tool-filtering.md](.claude/rules/tool-filtering.md)：`tools` 规则语法、四个实现约束、`global:` 为何不生效、`hidden` 计数与编辑弹窗工具列表；改过滤或工具选择 UI 时读。
- [context-budget.md](.claude/rules/context-budget.md)：按需清单（预算/截断/原文）、`optimize` 三层粒度、游标分页、目录缓存、`mcp_search` 纪律；改清单或优化策略时读。
- [settings-and-roster.md](.claude/rules/settings-and-roster.md)：设置命名空间与收敛、两条行写入路径、配置诊断、名册读取与可写判据；改设置/写入/名册时读。
- [settings-ui-and-spec.md](.claude/rules/settings-ui-and-spec.md)：设置页分区与行级只读、行内布局与工具列表 token 估算、MCP JSON 推断；改设置页交互、工具列表或 spec 解析时读。
- [build-and-contract.md](.claude/rules/build-and-contract.md)：目录与文档分工、构建细节、Cordis 契约、Typert Remote、部署/安装/接线、发版；动构建或通信契约时读。
- [testing-and-measurements.md](.claude/rules/testing-and-measurements.md)：测试命令与覆盖矩阵、隔离实例测量数据与未覆盖项；跑测试或更新验证记录时读。
- [pitfalls-and-decisions.md](.claude/rules/pitfalls-and-decisions.md)：45 条易崩清单与 D1–D33 决策表；动相关代码前扫一遍或查决策理由时读。
