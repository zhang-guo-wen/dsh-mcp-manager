---
paths:
  - "tests/**"
  - "vitest.config.ts"
  - "vitest.harness.config.ts"
  - "docs/testing.md"
---

> 覆盖：测试命令与覆盖矩阵、隔离实例的测量数据（启动零拉起 / 常驻复用 / `eager` 对照）与未覆盖项（自原「工程契约与历史台账」拆出）。何时读：跑 `npm test` / `npm run test:harness`、复现实测读数，或更新验证记录时。

# 测试与测量数据

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
