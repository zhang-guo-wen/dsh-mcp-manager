---
description: "dsh-mcp-manager 的行为验证记录：harness 真实组合回归的运行方式、覆盖矩阵与结果，以及隔离实例实测的读数、复现命令与未覆盖项。"
kind: "package-reference"
---

# 行为验证记录

本页回答一个问题：**「启动零拉起、按需拉起、宿主级常驻复用」这些结论各自被什么证据支持、怎么复现。**
设计取舍见 [design-decisions.md](design-decisions.md)（D5、D16），实现契约见 [AGENTS.md](../AGENTS.md)。
**没跑过的结论不写成本页的结论**；失败、未覆盖与受阻项如实保留。

本页结果的日期与环境：**2026-10-15**，Windows，Node ≥22.18，插件为本仓工作树构建的 `lib/`。
隔离实例用 npm 发布版 **`@deepseek-ai/dsh@0.2.0-rc.2`**（`npm view @deepseek-ai/dsh dist-tags` 当时
`latest` = `next` = `0.2.0-rc.2`）。

## 一、Harness 真实组合回归（已通过，5 文件 / 22 项）

`npm run test:harness` 先重建 `lib/`，再用仓库根的 `vitest.harness.config.ts` 跑
`tests/**/*.harness.spec.ts`。它需要一份与当前插件匹配的 Harness **源码**检出（该检出本身没有
`node_modules`，所有 `@deepseek-ai/*` 都经其 `tsconfig.base.json` 的 `paths` 别名解析到 `src`）：

```powershell
cd dsh-mcp-manager
$env:DSH_HARNESS_ROOT='C:\02-codespace\DeepSeek\deepseekharness'
npm run test:harness
```

等价写法（配置读 `process.env.DSH_HARNESS_ROOT`）：`DSH_HARNESS_ROOT=<path> npm run test:harness`。
未指定时默认宿主位置为 `../../deepseek-harness`。

**当前结果：5 个文件 / 22 项全部通过。** 同批检查：`npm test` 13 文件 / **121** 项通过，
`npm run typecheck` 通过。

> **合并说明（2026-10-16）**：本文出现的产物哈希（`E1B1051A…` 等）都是**合并 UI 规范收敛与「MCP 优化」设置页之前**
> 在 main 侧测得的历史读数，保留作为当时的依据。合并后的当前工作树产物是 `lib/index.mjs` = `121B8C0A…`、
> `lib/client.js` = `1D0FC432…`；同批结果为 `npm test` **21 文件 / 219 项**、`npm run test:harness` **6/25**、
> `npm run test:metadata` 通过、`npm run typecheck` 与 `npm run build` 通过、
> `_team/audit-ui-standard.mjs dsh-mcp-manager` **0 项**。下面的协议与复现命令不变。
>
> **再合并说明（2026-10-16 晚些）**：同一天又把两条 `settings.section` 注册合并成**一页两页签**，名册页重排；
> 当前产物是 `lib/client.js` = `B7A9BEEA…`，`npm test` **21 文件 / 228 项**。这一轮的环境、读数、缺口与截图
> 见**第六节**；上面文字里提到的 `mcp.plane.global.eager`、`needsPreset`、独立「MCP 优化」页都是**该轮之前**的形态。

### 测试夹具

`tests/fixtures/mcp-client-fixture.ts` 是 `@deepseek-ai/dsh-mcp-client` 的可控替身：
`apply` 计数对应真实插件里 spawn 子进程的那一步；`createMcpToolDefinition` 记录每个定义是用哪个 ctx 造的。
`on-demand-pool.harness.spec.ts` 里的连接计数来自池的 `open`。
`zero-launch.harness.spec.ts` 挂的是**构建产物** `lib/index.mjs`（与 `plugin-startup.harness.spec.ts` 相同），
经 Loader `Entry` 装载。

### 覆盖矩阵

| 验收目标 | spec / 用例 | 断言 |
|---|---|---|
| 行在本插件 `apply` 之前就已建好时也不 import 插件（挂载前拦截的直接证据） | `tests/mcp-gate.spec.ts` > `pre-mount hold (rows built before the plugin applied)` | 标记后 Loader 的 `update` 直接返回、`init` 从未调用、`fiber` 为 undefined；非本插件的行与 `eager` 下立即还原遮蔽 |
| `dynamic` 挂载 preset 时 `mcp-client` 的 `apply` **从未执行**（启动零拉起的直接证据） | `zero-launch` > `never runs the mcp-client callback for a preset row held under dynamic` | 等 `gateState().suppressed` 含 `preset:standard:test-server` 后 `applyCalls === 0` |
| 同一份声明在 `eager` 下正常挂载（证明计数器确实能观测挂载） | `zero-launch` > `mounts the same declaration exactly once under eager` | `applyCalls === 1` 且 `suppressed` 不含该行 |
| 声明重建（一次设置写入 = 一次 preset 重挂）也不 spawn | `zero-launch` > `re-mounts a rebuilt declaration without activating the held row` | 重建前后 `applyCalls` 均为 0 |
| **全局行**同样不被 import（`dynamic`/`lazy`），`eager` 下照常挂载，切回 `eager` 撤销拦截；**组合已挂载的行由 late hold 接管** | `global-zero-launch.harness.spec.ts`（5 项） | 全局 Include 子树里的 `mcp-client` 行在非 `eager` 模式下回调 0 次且 `disabled` 仍读声明；`eager` 下挂载；`mcp_load` 能按需拉起被 hold 的行；「本插件 import 之前就被组合挂载」的行被 late hold（先遮蔽再 `fiber.dispose()`），切回 `eager` 后连同文件一起完好 |
| 会话 `mcp_load` 恰好连接 1 次 | `on-demand-pool` > `opens one connection for the first session and reuses it for a second` | `opened === 1`、`applyCalls === 0`、返回工具名 `mcp__test-server__echo`、`hidden === 0` |
| 第二个会话再 load 同一台仍为 1 次（常驻复用直接证据） | 同上 | 第二个会话 load 后 `opened` 仍为 1；两个会话各得一代注册，且定义是用各自会话的 ctx 造的 |
| 第一个会话销毁后连接仍存活；最后一个引用释放才关闭 | `on-demand-pool` > `keeps the connection after the loading session ends and closes it on the last release` | 销毁 A 后 `closed === 0`、A 的注册被撤销而 B 的保留；B `mcp_unload` 得 `{released:true, stopped:true}` 且 `closed === 1` |
| `mcp_unload` 只释放调用方那个会话的引用 | `on-demand-pool` > `releases only the calling session's claim and reports the server as still in use` | A 释放得 `{released:true, stopped:false}`、`closed === 0`，B 仍能经共享连接调通工具 |
| 切回 `eager` 后行能正常挂载（恢复路径，不是闩锁） | `on-demand-pool` > `mounts the row under eager and mounts it again after suppression` | `dynamic` 下 `rowEntry().disabled === true`、`applyCalls === 0`、`stateFor = {allowed:true, suppressed:true}`；切 `eager` + reconcile 后 `disabled === false`、`applyCalls === 1`、`stateFor = {allowed:true, suppressed:false}` |

**边界条件**：`zero-launch` 的
`holds a row that was declared before the plugin activated, after one activation` 覆盖唯一会留下一次真实启动的
顺序 —— 行的 entry 在本插件被 Loader 导入**之前**就已创建（挂载前拦截路径，见 design-decisions.md D5）。
真实 profile 里 `mcp-manager` 行声明在 preset 之前（bundle 层补丁即如此），所以正常启动与声明重建都满足零拉起。

**它证明了什么、没证明什么**：这些用例跑在真实 Loader / registry / scope 上，且 `zero-launch` 挂的是构建产物，
足以证明「抑制让 `mcp-client` 的 `apply` 不被执行」「同一台服务器的跨会话复用只开一次连接」「引用计数在最后一个
引用时才关闭」在**框架层**成立；它**不**覆盖真实宿主的进程表、真实 `npx` 冷启动与 GUI 会话路径 —— 那一层由下面的
隔离实例实测覆盖。

### 运行环境修复（不是被测行为）

Harness 源码检出没有自己的 `node_modules`，Vite 无法从它解析裸 `semver`，CJS 入口以伪造的无扩展名 id 加载并报
`Cannot find module './internal/re'`，收集阶段整体失败。`tests/fixtures/semver-esm.ts` 用 `createRequire`
从**本包**加载真实包，`vitest.harness.config.ts` 用 `resolve.alias` 把裸 `semver` 指过去。
这是测试环境适配，不是产物代码。

### 本轮未覆盖

1. **真实插件层的运行中模式切换**（设置从 `dynamic` 改到 `eager` 的端到端流程）：harness 拿不到被 Cordis 解析后的
   volatile settings；恢复路径由 `on-demand-pool` 在真实 gate + Loader 上覆盖，真实实例侧归下面的隔离实测一节。
2. **`lazy` 模式的池复用**（`proxy` 载体按会话保留 `tools`/`hidden`）与 `tools/list_changed` 的跨会话 resync：
   单元层已覆盖（`tests/mcp-pool.spec.ts`、`tests/lazy-carrier.spec.ts`），harness 层本轮没有。

## 二、隔离实例实测（已通过，2026-10-15）

> ⚠️ **本节所有读数都来自合并前的产物**：第一轮（preset 平面）绑 `7A37D75C…`；第二轮全局平面分 2a `140B228B…`、
> 2b `9572ADC1…`、2c `611F4678…`、**2d `9B5D8D19…`**。两条线合并后的产物是 `D498FEC7…`，
> 它的全量复测在**第四节**；本节保留原样作为历史记录，**不要把这里的结论平移到新产物上**。

这一节是**真实宿主上的端到端观察**：真实 `npx` 启动的 Web 实例、真实 Cordis Loader、真实子进程、真实
`mcp_load` / `mcp_unload` 返回值。它补上第一节之外的那一层 —— 进程表、`npx` 启动、以及插件在完整组合里的行为。

隔离规则（与仓库 `AGENTS.md`「Harness Web 测试实例隔离」一致）：独立 `DSH_HOME`、显式随机高位端口、
`--no-open`；**不动日常实例**（端口 59495、`~/.dsh`）。测试结束只停止本次创建的进程：停止前先用监听端口反查
PID，核对命令行确实是本场景启动的 `dsh ... web --port <port>` 才终止。

```powershell
# 1) 装本仓（link 安装，重建 lib/ 后重启即生效，无需重装）
$env:DSH_HOME='C:\02-codespace\DeepSeek\.scratch\harness-tests\mcp-lazy-20261015-222208-05869b\dsh-home'
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add C:\02-codespace\DeepSeek\dsh-mcp-manager

# 2) 场景（端口每次随机取一个未被监听的高位端口；脚本只停自己启动的进程）
.\scripts\run-scenario.ps1 -Scenario D6-final2 -Port <p> -PatchFile .\scenarios\patch-L1-ondemand.yml `
  -StartupObserveSeconds 45 -StartupSampleIntervalSeconds 9 -ResetMarkers
.\scripts\run-scenario.ps1 -Scenario E4-final2 -Port <p> -PatchFile .\scenarios\patch-E2-eager.yml `
  -StartupObserveSeconds 30 -StartupSampleIntervalSeconds 10 -ResetMarkers
.\scripts\run-scenario.ps1 -Scenario L8-final2 -Port <p> -PatchFile .\scenarios\patch-L1-ondemand.yml `
  -PlanFile .\scenarios\plan-L4.json -StartupObserveSeconds 8 -StartupSampleIntervalSeconds 4 -ResetMarkers
```

### 环境与产物绑定

| 项 | 值 |
|---|---|
| 宿主 | npm 发布版 `@deepseek-ai/dsh@0.2.0-rc.2`（当时 `dist-tags` 的 `latest` = `next` = `0.2.0-rc.2`） |
| `DSH_HOME` | `.scratch/harness-tests/mcp-lazy-20261015-222208-05869b/dsh-home`（profile 名 `web`，模板 `dsh-web-app`） |
| Node | v24.12.0 |
| 第一轮产物（preset 平面） | `lib/index.mjs` = `7A37D75CC85C5A125494A0A62EE5898DF3E374BCCDF780669FCF49CC629D4BB0`（145670 字节，mtime 22:48:22）；`lib/client.js` = `79129457B67B5218BF5DEF248AE84E75641007554FA4D5C21033C6DC779E0A0C` |
| 第二轮产物（全局平面，2a） | `lib/index.mjs` = `140B228B8F464846B0F13933A65CD5CDBDEEA19B466FAE7AC8E542DF6BECF701`（150661 字节，mtime 23:33:06）；`lib/client.js` = `E3B9086BAFB2358B029329544EB8F556E849A121B286445356745FFEB33D3530` |
| 第二轮产物（全局平面，2b） | `lib/index.mjs` = `9572ADC193D9EDD8D23A372AE49420AF29F241B1B17968AA06E9F938A622C61C`（152883 字节，mtime 23:49:45）；`lib/client.js` 仍是上一个哈希（未重建） |
| 第二轮产物（全局平面，2c） | `lib/index.mjs` = `611F4678916D56AF06D263F82B73F14314790FD4DC9460378A72E6B5FF4AD6BD`（154516 字节，mtime 23:58:07）；`lib/client.js` = `CF47E7B1315AABC18ED918C224D00869772EB39B5D0C039FA0785D13626E3689` |
| 第二轮产物（全局平面，2d 最终） | `lib/index.mjs` = `9B5D8D19D22401F52AAC69E2A5646FE65FB1D72EC57B808EF05800D2A6092548`（157102 字节，mtime 00:10:11）；`lib/client.js` = `CF47E7B1315AABC18ED918C224D00869772EB39B5D0C039FA0785D13626E3689` |
| 本节主要读数 | 第一轮（preset 平面）：`D6-final2`、`E4-final2`、`L8-final2`；第二轮 2a：`D7-global-zero-launch`、`E5-global-eager`、`L9-global-reuse`、`L10-contrast`；第二轮 2b：`D8-global-zero-launch`、`L11-global-reuse`、`L12-globalpatch-reuse`、`E6-global-eager`；第二轮 2c：`D9-global-zero-launch`、`L13-global-reuse`、`L14-globalpatch-reuse`、`E7-global-eager`；第二轮 2d（最终）：`D10-global-zero-launch`、`L15-global-reuse`、`L16-globalpatch-reuse`、`E8-global-eager` |
| 收敛过程中的产物 | `22AADE6ADF836EB6…`（与最终产物仅注释差异、行为相同；`D5`/`E3`/`L7` 跑在它上面）、`33845FBEF53A46CE…`、`CEC6CA8036CEF874…`、`72C70F983A0A39C1…`、`B0C0246531A2B934…`、未改动基线 `39662C0C…`（v1.3.0 发布版） |

`lib/` 在本轮收敛过程中重建过多次，所以**每次运行的产物哈希都写进 `evidence/run-<scenario>.meta.json` 的
`libIndexSha256`**；本文所有读数都绑定到具体哈希，没有哈希的读数不作为结论。上表最后一行是复现时的对照锚点。

### 观察方法

fixture 是 `fixtures/fixture-mcp.mjs`（纯 Node stdlib，无依赖）：被 spawn 时**立刻**把一行 JSON 追加到自己
`--marker <path>` 指定的文件（`event: "spawn"` + pid + 时间 + argv），随后实现最小 MCP stdio 协议
（`initialize` / `initialized` / `tools/list` 返回 2 个工具 / `tools/call` / `ping`），并在 `stdin` 结束与进程退出时
各追加一行。因此 **marker 文件是子进程真实启动与停止的原始记录**，不依赖插件的任何自述。

子进程计数用命令行匹配，而不是按端口或进程名：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*fixture-mcp.mjs*' }
```

场景组合固定为：`mcp-manager` 行给 `loading`，一个 `@deepseek-ai/dsh-agent-preset` 声明的 preset 里放 2 台
fixture MCP（`fixture-a` / `fixture-b`，preset 平面），另有一个只在测试 profile 里挂的最小自动化入口
`driver/t5-driver.mjs`，它用 harness 自己的服务驱动真实工具调用。**第二轮另加了全局平面**：一条用户拥有的
`cordis:include` 文件里放 2 台全局 fixture（`gfixture-a` / `gfixture-b`，marker `marker-global-{a,b}.jsonl`），
详见下面「全局平面」小节。

- `agents.create({ sessionId, meta: { agentPreset }, setup: (agentCtx) => agentPresets.mount(agentCtx, id) })`
  开**真实会话**（与会话控制器同款入组方式）；
- `tools.execute({ name: 'mcp_load' | 'mcp_unload', arguments, agent })` 走**真实工具执行路径**；
- 每一步之间用 ack 文件停住，让 Windows 侧在两个会话操作之间采样 marker 与进程数。

**这条触发路径没有模型参与**（隔离 `DSH_HOME` 里没有凭据，也不应复制日常凭据）：它绕开"模型决定调用"
这一层，直接驱动 `mcp_load`/`mcp_unload` 的处理器。未覆盖项见本节末尾。

### 启动零拉起

最终产物（`7A37D75C…`）上，`loading: dynamic` + 2 台 fixture，启动后观察 **45 秒**：

| 场景 | 端口 / hostPid | 采样 | marker-a / marker-b | 存活 fixture 进程 |
|---|---|---|---|---|
| `D6-final2`（**最终产物**） | 44648 / 43032 | 5 点，T+3s…T+41s | **均 `exists=false`**（文件从未创建） | 全程 `0` |
| `D5-final`（`22AADE6A…`） | 43620 / 17884 | 5 点，T+4s…T+41s | **均 `exists=false`** | 全程 `0` |
| `D4-zero-launch`（`33845FBE…`） | 40524 / 45344 | 9 点，T+3s…T+46s | **均 `exists=false`** | 全程 `0` |

实例 stderr 里**没有任何 `mcp-manager:` 行**（三个场景均如此）；除了一条与本插件无关的宿主告警
`directory-picker-auto: failed to load @deepseek-ai/dsh-host-directory-picker-native` 之外没有其它输出。
认证后的页面为 200 且标题 `DeepSeek Harness`（基线场景实测，端口 42265）。

**对照：未改动基线（v1.3.0 发布版 `39662C0C…`）在同一组合下启动即拉起。** 两台 fixture 各产生 2 条 spawn /
8 行，随后被事后摘行杀掉、无存活进程；`T+30s` 与 `T+90s` 两次读数一致，说明这是启动期的固定行为而非抖动。
**这正是本次改动要消除的行为，也是"零拉起"这条结论的反证基线。**

### 按需拉起与宿主级常驻复用

最终产物（`7A37D75C…`）上，`L8-final2`（端口 39607 / hostPid 43072）按 17 步计划驱动两个真实会话：

| gate | marker-a spawn 行数 | 存活 fixture 进程数 | 该步动作 |
|---|---|---|---|
| `boot-settled` | 0 | 0 | 启动后静置 —— 零拉起 |
| `after-load-a-1` | **1** | **1** | 会话 A 首次 `mcp_load(fixture-a)` |
| `after-load-a-2` | 1 | 1 | **同会话**再次 `mcp_load` |
| `after-load-b-1` | 1 | 1 | **新会话 B** `mcp_load` 同一台 ★ |
| `after-unload-a` | 1 | 1 | A 释放，B 仍持有 |
| `after-unload-b` | 1 | **0** | B 释放（最后一个引用） |
| `after-dispose` / `final` | 1 | 0 | 两个会话销毁 |

- 三次 load 的返回里，服务端自述工具 `mcp__fixture-a__fixture_info` **三次都报同一个 pid `33644`**
  （`driver-L8-final2.jsonl`），即跨会话拿到的是**同一个子进程**、同一条连接。
- marker 全文只有 **1 条 spawn**（`33644`，ppid = 本实例 hostPid），共 6 行：
  `spawn → initialize → initialized → tools/list → stdin-end → exit`；`stdin-end` 出现在 `unload-b` 之后，
  证明进程活到最后一个引用释放才停。
- **marker-b 文件从未创建** —— 只 load 了 `fixture-a`，另一台没有被顺带拉起。
- 同一个读数在另外两轮上重复出现：`L7-final`（`22AADE6A…`，端口 34651 / hostPid 47716，pid `38052`）与
  `L6-reuse`（`33845FBE…`，端口 42442 / hostPid 34280，pid `31624`），逐点读数见各自的 `samples-*.jsonl`，
  `mcp_load` 返回值全文见各自的 `driver-*.jsonl`。
- driver 的 `probe` 步同时确认了作用域链路：驱动会话的 `composedPreset = t5-fixture`，插件名册里两行都是
  `enabled = true` / `fiberPhase = held`（即"被抑制但仍允许加载"），说明抑制没有把行从按需可用集合里去掉。

**`mcp_unload` 的三分支逐条命中**（返回 `value` 字段，直接取自 `driver-*.jsonl`）：

| 情形 | 返回 | 同批的进程数 |
|---|---|---|
| 还有别的会话在用 | `{"released":true,"stopped":false}`，文案 `…it stays running for the sessions still using it.` | 仍为 1 |
| 本会话释放且无人再用 | `{"released":true,"stopped":true}`，文案 `…no session is using it any more, so it stopped.` | 变 0 |
| 本会话根本没加载过 | `{"released":false,"stopped":false}`，文案 `MCP server "…" was not loaded for this session.` | 不变 |

### 对照组：观察方法本身能看见 spawn

| 场景（`eager`） | 产物 | 结果 |
|---|---|---|
| `E4-final2`（**最终产物**） | `7A37D75C…` | 两台各 2 条 spawn / 6 行，**2 个进程存活**（pid 24724=a、34280=b），30 秒内 3 个采样点稳定 |
| `E3-final` | `22AADE6A…` | 同上：2 条 spawn / 6 行，2 个进程（pid 728=a、46708=b）稳定 |
| `E2-eager` | `33845FBEF53A46CE` | 同上：2 条 spawn / 6 行，2 个进程（pid 47172=a、21500=b）稳定 |
| `E0-eager`（未改动基线） | `39662C0C…` | 两台各 2 条 spawn / 6 行，**2 个进程存活且 T+150s 稳定** |

`eager` 组**不因抑制改动而回归**：行照常挂载并长期存活。同时它证明观测链路有效 —— 同一条 marker/进程计数
路径在 `eager` 下看得见 spawn，在 `dynamic` 下（最终产物）看不到，两组差异是行为差异而不是观测失灵。

### 两个校准常数（避免后人误判"spawn 行数"）

1. **插件自己的按需连接 = 1 次连接 / 1 次 spawn / 4 行握手前段**
   （`spawn → initialize → initialized → tools/list`）。`mcp_load` 走的是插件内 `connectLazy`（MCP SDK 直连），
   抓包可见它**不做** `server/discover` 探测。
2. **harness `mcp-client` 挂载的行 = 1 次连接 / 2 次 spawn**。`@modelcontextprotocol/client` v2.0.0 连接时先用
   `server/discover` 探测（新 wire 2026-07-28），fixture 按旧协议回 `-32601` 后，SDK **丢弃该进程**再 spawn 一个
   走 legacy `initialize`。所以 `eager` 组的"每台 2 条 spawn"是这条路径的特征，不是普适常数。

结论：**"启动零拉起"的判据是"marker 文件不存在"，不是"spawn 行数 = 0"**。反过来，使用 harness 挂载路径时
"1 次连接 = 2 条 spawn 行 + 1 个存活进程"。

### 边界与注意事项

- **常驻是宿主进程生命周期内的**：连接活到最后一个会话释放引用、提交了不同的加载模式、或插件卸载为止。
  **不跨宿主重启** —— 宿主重启后没有任何连接存在，直到下一次 `mcp_load`；而"启动与声明重建永不 spawn"是
  **无条件**的，与之前是否加载过无关。
- **`mcp_load` 按 entry id（叶子 id）识别行，不是配置里的 `serverName`。** 两者必须一致，否则会得到
  `unknown or disabled MCP server "<名字>"`，即使设置页名册里那一行显示为已启用。实测踩过：把 entry id 写成
  `t5-fixture-a` 而 `serverName` 写 `fixture-a` 时三次 load 全部失败；改成二者一致后立刻通过。
  这与设置页、名册的键口径一致（全局行更是由 id 决定名字），属**使用注意事项**而非缺陷。
- 观测到的一条宿主告警（`directory-picker-auto` 缺 native 模块）与加载行为无关，已如实记录在
  `instance-*.err.log`，不要把它读成插件问题。

### 本轮未覆盖 / 受阻

1. **真实 GUI 里的模型路径**：从"在 Web 会话里让模型调用 `mcp_load`"这条端到端链路**没有跑**。隔离
   `DSH_HOME` 没有凭据（也不应复制日常凭据），而本机 harness 检出没有 `node_modules`，源码宿主线不可用；
   因此按需触发改用测试 profile 内的最小自动化入口，经 harness 的工具执行路径调用真实 `mcp_load`/`mcp_unload`。
   处理器、池、注册与引用计数都在真实宿主里跑过，**未覆盖的是"模型如何决定调用"这一层**。
2. **真实实例上的运行中模式切换**（设置里把 `dynamic` 改成 `eager` 而不重启）：本轮只做了两次独立启动的
   对照（`dynamic` / `eager` 各一次）。恢复路径由第一节的 `on-demand-pool` harness 用例覆盖，实例侧未做。
3. **`lazy` 模式在真实实例里的池复用**与 `tools/list_changed` 的跨会话 resync：单元层已覆盖，
   实例侧本轮未跑。
4. **`npx -y` 冷启动耗时**：fixture 用直接 `node` 调用（刻意如此，避免把 `npx -y` 的 7.5–23 秒算进观察），
   所以本页不含冷启动时长对比。**同一原因还留下一条形状 B 的未测项**：真实 `npx -y` 服务器下 late hold 是否会有
   可观测的瞬时子进程没有实测（`node` 直调的 fixture 上两种形状都是零拉起，见 2d）。
5. **形状 A 的 GUI 写入路径**：设置页把全局行写进"它自己的 file-backed Include 文件"这条通道（`globalWritable=false`
   时按钮禁用、`true` 时 root anchor 会被宿主自己重写）本轮只在名册读取侧观察过，没有在 GUI 里走完整写入。

### 全局平面（第二轮：全局行纳入零拉起与按需加载）

本节按产物分两段：**2a**（`140B228B…`）记录一次失败与它的根因，**2b**（`9572ADC1…`）是修复后的复跑结果。
两段的 fixture 都是 preset 2 台（`fixture-a` / `fixture-b`）+ 全局 2 台（`gfixture-a` / `gfixture-b`，
marker 为 `marker-global-{a,b}.jsonl`），所以每个场景同时观察**两个平面、四个 marker**。

**先记一条宿主事实（第一轮之后踩到的）**：`$DSH_HOME/profiles/<name>/cordis.yml` **不是**用户可编辑的全局行文件 ——
`dsh` 每次启动都会把它重写回空模板（`prepareProfile` 的注释写明 "the root is always rewritten"，因为它只是 Loader 用来
锚定 `baseUrl` 的 include 根）。第一次尝试把全局行写进这个文件，跑完一次 `--dump-config` 就被还原成 223 字节的模板。
**全局行只能来自别处**，本节因此测了两种形状（见 2b 的表）。

#### 2a（`140B228B…`）：零拉起通过，按需加载失败

`lib/client.js` = `E3B9086BAFB2358B029329544EB8F556E849A121B286445356745FFEB33D3530`（与 2b 相同，见下）。
形状：profile 补丁里插入一条 `cordis:include` 行指向用户文件 `profiles/web/global-entries.yml`，全局 fixture 写在那里。

| 项 | 场景（端口 / hostPid） | 结果 |
|---|---|---|
| G1 全局零拉起 | `D7-global-zero-launch`（39176 / 32956，`dynamic`，45 秒 / 5 个采样点） | **通过**：`a`/`b`/`ga`/`gb` 四个 marker 全部 `exists=false`，存活 fixture 进程全程 0，stderr 无 `mcp-manager:` 行 |
| G2 全局按需加载 | `L10-contrast`（44997 / 49180，`dynamic`，**同一实例内**对照） | **未通过**：preset 行 `mcp_load(fixture-a)` 成功（2 个工具、1 条 spawn、1 个进程）；全局行 `mcp_load(gfixture-a)` 报 `unknown or disabled MCP server "gfixture-a"`，marker 不增、进程不增 |
| G3 `eager` 对照 | `E5-global-eager`（43867 / 32116，`eager`，24 秒） | **通过**：四台全部 spawn 并长期存活（4 个进程、各 2 条 spawn），证明该 Include 确实被组合加载、观测方法能看见全局行的 spawn |
| G4 不写回声明 | 上面四个场景全部跑完之后 | **通过**：`global-entries.yml` **逐字节一致**（1247 字节，sha256 `383DB967D6DC88F60128CDD6AD0991873A92A85955B946790B43067B845384E2`） |

**G2 的根因（当时读数）**：`dynamic` 下名册把全局行报成 `{"entryId":"gfixture-a","enabled":false,"fiberPhase":null}`，
`eager` 下报 `enabled: true` / `active`。即**抑制为让全局行不预加载而打的 `disabled`，被按需加载与名册读成了"用户禁用"**
（preset 行不受影响：它们的 `enabled` 取声明、live 只提供相位）。这条已由实现侧按"读声明 `entry.options.disabled !== true`"
修掉，2b 复跑确认修复生效。

#### 2b（`9572ADC1…`）：`enabled` 读取已修；两种全局行形状各只对一半

产物：`lib/index.mjs` = `9572ADC193D9EDD8D23A372AE49420AF29F241B1B17968AA06E9F938A622C61C`（152883 字节，mtime 23:49:45）。

| 形状 | 全局行的家 | file-backed Include 数 | 全局零拉起 | `mcp_load` + 跨会话复用 | 不写回声明 |
|---|---|---|---|---|---|
| **A** | 用户 Include 文件（补丁插 `cordis:include` 行） | 2 | ✅ `D8`（40249 / 33900，45 秒 / 5 点）：四个 marker 全不存在、进程 0、**stderr 为空** | ❌ `L11`（33746 / 37572）：三次 load 全报 `global MCP authoring requires exactly one file-backed Include` | ✅ `global-entries.yml` 仍逐字节一致（`383DB967…`） |
| **B** | profile 补丁顶层 `insert` 行 | 1 | ❌ `L12`（43946 / 24852）：`ga`/`gb` **启动即挂载**，各 2 条 spawn、2 个进程全程存活 | ✅ 三次 load 都成功、同一个 pid `11816`；`unload` 得 `{released:true,stopped:false}` → `{released:true,stopped:true}` | ✅ `cordis.patch.yml` 与场景文件逐字节一致，root anchor 仍 223 字节模板 |

- **修复确认（2a 的 G2）**：形状 A 下名册现在报 `{"entryId":"gfixture-a","enabled":true,"fiberPhase":"held"}` ——
  `enabled` 取声明、`held` 标记正确（2a 是 `enabled:false`）；preset 行仍是 `True/held`。
- **形状 B 的额外读数**：`mcp_load` 成功时开出的是**第二条连接**（池里的 pid `11816`），与组合已挂载的 `43140` 并存 ——
  同一台服务器在「组合挂载 + 按需加载」同时成立时有**两个进程**，`unload` 只停池那一条（进程 3 → 2）。
- **形状 B 未通过的项**：`dynamic` 下 profile 补丁里的全局行**没有被 hold**（名册报 `fiberPhase:"active"`），
  说明挂载前拦截只命中了 Include 子树里的行，补丁顶层插入的行不在其内。
- **结论**：目前**没有任何一种形状同时满足「启动零拉起」与「可按需加载」** —— 形状 A 零拉起但加载被单 Include 契约拒绝，
  形状 B 能加载但启动就挂载。需要实现侧先定哪种形状是产品目标（尤其：补丁声明的全局行该不该也 hold、
  以及为什么 `mcp_load` 需要"恰好一个 Include"才能描述一行已经拿到的 entry），再挑一种复跑。
- **重复行仍在**：形状 A 每台 4 条（3 条裸 id + 1 条限定 id，共 8 条），形状 B 每台 2 条（1 裸 + 1 限定，共 4 条）。
  与 2a 的"3 裸 + 1 限定"相比裸 id 从 3 降到 1，但**每台仍有重复**，设置页若直接渲染会看到重复行。
- **`lib/client.js` 未重建**：2b 给的哈希与 2a 完全相同（`E3B9086B…`），过期注释
  `* loading, while global rows are always mounted and ignore the loading mode` **仍在产物里**（`grep "always mounted"` = 1 处）；
  用户可见文案（`mcp.plane.global.eager`）在 2a 时就已就位。
- **`eager` 回归**：`E6`（36208 / 24280，24 秒）四台全部 spawn 并长期存活（4 个进程）✅ —— 抑制改动没有回归 `eager` 挂载。

**2b 的未覆盖**：全局平面的真实 GUI 渲染（名册 → 设置页）、GUI 里由模型触发的 `mcp_load`、以及设置页**写回**全局行的
写入路径（形状 A 的 `globalWritable=false`；形状 B 为 `true`，但 root anchor 会被宿主自己重写，写入路径本轮未测）。

#### 2c（`611F4678…`）：两个"顺带"到位了，两个主症状换了形态

产物：`lib/index.mjs` = `611F4678916D56AF06D263F82B73F14314790FD4DC9460378A72E6B5FF4AD6BD`（154516 字节，mtime 23:58:07）
＋ `lib/client.js` = `CF47E7B1315AABC18ED918C224D00869772EB39B5D0C039FA0785D13626E3689`（**这次真的重建了**：
`always mounted` 与「全局行全部加载」在产物里各 **0** 处）。

| 项 | 场景（端口 / hostPid） | 结果 |
|---|---|---|
| 形状 A 零拉起 | `D9`（32303 / 33076，45 秒 / 5 点） | ✅ 四个 marker 全不存在、进程 0、stderr 空 |
| 形状 A 按需加载 | `L13`（42388 / 37076） | ❌ 三次 load 全报 **`the row id occurs more than once`**（新错误，取代 2b 的单 Include 契约错误） |
| 形状 A `globalWritable` | `L13` 名册 | `false` ✅ 与实现侧预期一致（两个 file-backed Include 定不出唯一写入目标） |
| 形状 B 零拉起 | `L14`（42747 / 42484，12 秒 / 3 点） | ❌ **仍然启动即挂载**：`ga`/`gb` 各 2 条 spawn、2 个进程全程存活；名册两条都报 `active`（不是 `held`） |
| 形状 B 加载 | `L14` | ✅ 三次 load 同一 pid `49436`；`unload` `{true,false}` → `{true,true}` |
| 形状 B 两进程并存 | `L14` | ❌ 仍在：组合挂载的 `41252` 与池里的 `49436` 同时活着，`unload` 只停池那条 |
| `eager` 对照 | `E7`（33850 / 31188，24 秒） | ✅ 四台全部 spawn 并长期存活（4 个进程） |
| 不写回声明 | 全部场景之后 | ✅ `global-entries.yml` 逐字节一致（1247 B，`383DB967…`）；`cordis.patch.yml` 与场景文件一致；root anchor 仍 223 B 模板 |

**关键读数：每台全局行在 `loader.entries()` 里出现两次，而且两份的读数不一致。**

- 形状 A：`gfixture-a:True/held | gfixture-b:True/held | include:t5-global-include:gfixture-a:False/ | include:t5-global-include:gfixture-b:False/`
  —— 裸 id 那份走"读声明"（`True/held`），限定 id 那份仍读到被遮蔽的实例 getter（`False`）。**两次枚举都指向同一行**，
  于是新的 `liveGlobalEntry` 逐子树查找时命中两条 → `the row id occurs more than once`。
- 形状 B：`gfixture-a:True/active | gfixture-b:True/active | include:gfixture-a:True/active | include:gfixture-b:True/active`
  —— 两份都 `active`，说明**补丁声明的全局行一份都没被 hold**，所以启动仍会挂载。
- 去重进展：形状 A 从 2b 的 8 条降到 4 条（每台 3 裸 → 1 裸），但**限定 id 那份仍在**；形状 B 仍是 4 条。

**2c 的下一步（实现侧）**：`liveGlobalEntry` 需要与名册同样的 `leafId` 去重（并且两份读数要统一走"读声明"）；
补丁声明/根层的全局行仍未被 hold，需要确认 `globalRows()` 的新根层扫描是否真的覆盖了这类 entry 的 `update` 拦截。

#### 2d（`9B5D8D19…`，最终产物）：两种形状全部通过

产物：`lib/index.mjs` = `9B5D8D19D22401F52AAC69E2A5646FE65FB1D72EC57B808EF05800D2A6092548`（157102 字节，mtime 00:10:11）；
`lib/client.js` = `CF47E7B1315AABC18ED918C224D00869772EB39B5D0C039FA0785D13626E3689`
（产物里 `always mounted` 与「全局行全部加载」各 0 处）。

| 项 | 场景（端口 / hostPid） | 结果 |
|---|---|---|
| 形状 A 零拉起 | `D10`（39233 / 45556，45 秒 / 5 点） | ✅ 四个 marker 全不存在、进程 0、**stderr 为空** |
| 形状 A 名册 | `L15`（37422 / 50524） | ✅ **每台 1 条**：`gfixture-a:True/held | gfixture-b:True/held`（2c 是 4 条）；`globalWritable=false` |
| 形状 A 按需加载 | `L15` | ✅ 三次 load 全部成功、**同一个 pid `48380`**（`the row id occurs more than once` 已消失）；时间线 `boot 0/0 → load-a-1 1/1 → load-a-2 1/1 → load-b-1(新会话) 1/1 → unload-a 1/1 → unload-b 1/0`；marker-ga 恰 1 条 spawn，marker-gb 从未创建 |
| 形状 A `unload` | `L15` | ✅ `{released:true,stopped:false}`（B 还持有）→ `{released:true,stopped:true}`（末位释放） |
| 形状 B 启动 | `L16`（42327 / 12956，14 秒 / 4 点）+ 1 秒扫描 `B1`（33869 / 37336，10 秒 / 8 点） | ✅ 四个 marker 在 T+4s（扫描里是 T+5s）起就**不存在**、进程 0 —— **两种形状都是"启动零拉起"**（见下） |
| 形状 B 名册 | `L16` | ✅ 每台 1 条 `True/held`（2c 是两份都 `active`）；`globalWritable=true` |
| 形状 B 按需加载 | `L16` | ✅ 三次 load 同一个 pid `37712`、走池；`unload` 三分支同上；**"组合挂载 + 池连接两个进程并存"消失**（全程只有池那一个进程） |
| `eager` 对照 | `E8`（39194 / 38940，24 秒） | ✅ 四台全部 spawn 并长期存活（4 个进程、各 2 条 spawn） |
| 不写回声明 | 全部场景之后 | ✅ 三个文件都不变：用户 Include `global-entries.yml` 逐字节一致（1247 B、`383DB967…`）、`cordis.patch.yml` 与场景文件逐字节一致、root anchor 仍 223 B 模板且不含任何 MCP 行 |

**关于形状 B 的"启动拉起一次"——已定论**：实现侧预期它是 `late hold` 的固有代价(`apply` 会执行一次),但**这套实例
观测不到子进程** —— fixture 在 `spawn` 那一刻就写 marker,而形状 B 的四个 marker 文件在 T+4s 起就不存在、进程数 0。
补做的 **1 秒间隔扫描**(`B1-globalpatch-scan`,33869 / 37336,10 秒 / 8 个采样点;对照 `A1-global-scan`,43831 / 22480)
在两种形状下从 T+5s 起每个采样点都是"marker 不存在 + 进程 0",说明 `mcp-client` 的子进程**从未真正起来**(marker 由
子进程自己写,运行期间不会被删)。这与 harness 侧测到的 `applyCalls === 1` 不矛盾(`apply` 被调用 ≠ 子进程已 spawn)。
**正确口径:两种形状在这套 fixture 上都是"启动零拉起";差别只在插件回调层面 —— 形状 B 的 `apply` 被调用一次但不留
子进程,形状 A 连回调都不发生。"形状 B 会多起一个子进程"在真实实例上不成立,不要写进结论。**
**仍未覆盖**:真实 `npx -y` 服务器的冷启动路径(fixture 是直接 `node` 调用,刻意避开 npx 的 7.5–23 秒),
所以"形状 B 在 `npx -y` 下是否会有可观测的瞬时进程"**没有实测**。

**产品口径（本轮结论）**：**两种形状都实测"启动零拉起"**（1 秒采样），功能也都通过；差别只在**插件回调层面**
与"是否存在一个本插件管不到的挂载窗口"。**推荐形状 A** —— 全局行放在**独立的** file-backed Include 文件里,该 Include
作为组合行在本插件之后激活,行在 `apply` 前就被挂载前拦截挡住,**连 `mcp-client` 回调都不发生**。形状 B（行写在组合内:
anchor Include 或 patch 顶层 `insert`)靠 `late hold` 补救:不在本插件 `apply` 之前建好的行没有可拦截的窗口,只能
"挂载后再抑制"(先遮蔽再 `fiber.dispose()`,不写文件)。两种形状在 2d 上**功能都通过**(零拉起读数、名册 1 条、
按需加载与池复用、`unload` 三分支、不写回)。

### 原始证据索引

`evidence/` 下按场景保留（`<scenario>` = `D0-dynamic-baseline`、`E0-eager-control`、`D1-dynamic-fixed`、
`E1-eager-control`、`D2-dynamic-fixed2`、`L1-ondemand-fixed`、`L2-ondemand-presetjoin`、
`P1-probe`、`D3-dynamic-fixed3`、`L3-reuse`、`D4-zero-launch`、`E2-eager`、`L5-global`、`L6-reuse`、
`D5-final`、`E3-final`、`L7-final`、`D6-final2`、`E4-final2`、`L8-final2`、
`D7-global-zero-launch`、`L9-global-reuse`、`E5-global-eager`、`L10-contrast`、
`D8-global-zero-launch`、`L11-global-reuse`、`L12-globalpatch-reuse`、`E6-global-eager`、
`D9-global-zero-launch`、`L13-global-reuse`、`L14-globalpatch-reuse`、`E7-global-eager`、
`D10-global-zero-launch`、`L15-global-reuse`、`L16-globalpatch-reuse`、`E8-global-eager`、
`B1-globalpatch-scan`、`A1-global-scan`）：

| 文件 | 内容 |
|---|---|
| `run-<scenario>.meta.json` | 产物哈希、端口、`DSH_HOME`、patch、是否启用 driver、hostPid |
| `startup-<scenario>.jsonl` | 启动期逐采样点：每个 marker 的行数/spawn 数与存活 fixture 进程 |
| `samples-<scenario>.jsonl` | driver 场景每个 gate 的同样读数 |
| `driver-<scenario>.jsonl` | 每个 `mcp_load`/`mcp_unload`/`probe` 的完整返回（含工具列表、`fixture_info` 的 pid 与名册） |
| `instance-<scenario>.log` / `.err.log` | 实例 stdout / stderr |
| `marker-ondemand-a.jsonl` = `archive/marker-L8-a.jsonl` | 最后一次运行（`L8-final2`）那一刻的 marker 原文：1 条 spawn + 握手 + stdin-end/exit |
| `marker-dynamic-{a,b}.jsonl`、`marker-eager-{a,b}.jsonl` | 未改动基线的 `dynamic` 与 `eager` 两组 marker 原文 |
| `archive/marker-E4-{a,b}.jsonl`、`archive/marker-L8-a.jsonl` | 第一轮最终产物上对照组与复用组的 marker 原文；`D6` **没有** marker 文件，这正是"零拉起"的证据本身 |
| `marker-global-{a,b}.jsonl` | 第二轮全局 fixture 的 marker：`D7`（零拉起）后**不存在**，`E5`（对照组）后存在（各 2 条 spawn / 6 行）。这两个文件按场景复用同一路径、每次运行前删除，所以持久记录以 `startup-D7-global-zero-launch.jsonl`（`exists=false`）与 `startup-E5-global-eager.jsonl`（2 条 spawn / 6 行、4 个存活进程）为准 |
| `include-baseline/` | 全局平面用的 `global-entries.yml` 在写入后（`as-written`）与全部场景跑完后（`after-runs`）的副本 + 哈希清单，用于"不写回"的逐字节断言；形状 B 的补丁文件同样与场景文件逐字节比对（`cordis.patch.yml`、root anchor 223 字节模板） |
| `patch-*.yml`、`scenarios/plan-*.json` | 每个场景实际使用的 profile 补丁与 driver 计划 |

两点如实说明：① 早期基线用后台任务运行（`pwsh-144`/`pwsh-166`），后来的场景改由 `run-scenario.ps1` 前台运行，
所以"后台任务 id"只有前两组有，其余以 `run-*.meta.json` 里的 `hostPid` 为准；② marker 文件按场景复用同一路径，
每次运行前会删除，因此**只有最后一次运行的 marker 原文**留在顶层路径上，更早的场景以 `startup-*.jsonl` /
`samples-*.jsonl` / `driver-*.jsonl` 里的逐点读数与 pid 为准（它们是同一批观察的原始记录，不是事后复述）。

## 三、设置页单列表布局（去平面 tab，2026-10-16）

本节验证**只改客户端**的那次布局改动：删掉「全局 / Agent」两个平面 tab，整页一个列表，全局分组恒定在最前，
Agent 预设改为工具栏下拉。环境与产物：

| 项 | 值 |
|---|---|
| 宿主 | npm 发布版 `@deepseek-ai/dsh@0.2.0-rc.2`，隔离 `DSH_HOME`（`.scratch/harness-tests/mcp-lazy-20261015-222208-05869b/dsh-home`），端口 39513 / 33110 / 37352，`--no-open` |
| 插件产物（首轮） | `lib/client.js` = `0BC9CF451292A68E68EA7B206BBDE4B2BC9AE80BA4F2BDF180F0B29B08073581` |
| 插件产物（复测） | `lib/client.js` = `97F6456A6DD0094356D167DE02844963AD1BF659E5FE0E8426DAAFF570496A3B`（114242 B，mtime 00:36:41）；`lib/index.mjs` = `9B5D8D19D22401F5…`（两次都未变） |
| 浏览器 | Microsoft Edge **155.0.4283.45**（`--headless=new`），经 **CDP** 驱动：`Runtime.evaluate` / `Page.captureScreenshot` / `Emulation.setDeviceMetricsOverride` / `setEmulatedMedia` / `Input.dispatchMouseEvent`（真实指针点击）；本机无 Playwright/Puppeteer |
| 组合 | 形状 B（全局行写在 profile 补丁顶层）→ `globalWritable = true`，所以全局行可编辑；另用一份「声明 `disabled: true` 的行」的组合验证停用态 |
| fixture | 全局 2 台（`gfixture-a` / `gfixture-b`）+ preset `t5-fixture` 2 台（`fixture-a` / `fixture-b`），另有 4 个 0 行的内置预设（`standard` / `ptc` / `minimal` / `cordis`） |
| 原始材料 | `evidence/ui/`（首轮 12 张 + 复测 `v3-*.png` 6 张）、`browser-profile/audit.js`（布局审计）、`scripts/cdp.mjs`（CDP 驱动，支持 `eval`/`shot`/`viewport`/`theme`/`click`/`requests`） |

### 逐项结果（复测产物 `97F6456A…`）

| 验收项 | 结果 |
|---|---|
| 一个列表、无平面 tab | ✅ 设置页内 `[role="tab"]` **恒为 0**（1440/900/760/700/640/601/600/520 各档一致） |
| 全局分组在最前、切预设后仍在 | ✅ 任一档都是 `全局（2）` 在前、`全部 Agent 预设（2）`／`Agent 预设 · <预设名>（n）` 在后 |
| 分组标题与行卡片对齐 | ✅ 每一档 `group.x == row.x`、`group.right == row.right`（内容列宽 476/416/356/336/312/311/291 时都相同），`dx = 0` |
| 元素不重叠 | ✅ 组标题、行卡片两两无重叠（0 处；已排除父子包含关系） |
| **全局分组右侧小字** | ✅ 已按建议改：组标题高度**恒为 18px**（单行），不再随容器增高；`≤760px` 起**隐藏**（`display: none`），`761px` 以上显示。⚠️ 但宽容器下变成 `white-space: nowrap` + `text-overflow: ellipsis`：1440 实测 `clientWidth 497 / scrollWidth 1078`，**约 51/95 个字被省略号截掉**（旧版是换行 3 行、整句可读）——见「观察 2'」 |
| 下拉列出所有已声明预设 | ✅ `全部 Agent 预设（2） │ standard（0） │ ptc（0） │ minimal（0） │ cordis（0） │ T5 Fixture Preset（2）` |
| **选中 0 行预设** | ✅ **已修**（首轮 ❌）：`standard`/`ptc`/`minimal`/`cordis` 四个 0 行预设**逐个选中都稳定不回落**（同步读回 `select.value` 即所选项），组标题随之变 `Agent 预设 · standard（0）` 等，列表显示 2 台全局行 + 空态「还没有 Agent 预设里的 MCP 行」，**新增/导入恢复可用**（`disabled=false`、`title` 清空）；切回「全部 Agent 预设」后两者重新禁用并带回原因 `title` |
| 选中持有行的预设后过滤 | ✅ 选 `t5-fixture` 后组标题变 `Agent 预设 · t5-fixture（2）`、全局分组仍在最前；该预设 agent 行 2 行 |
| 「全部 Agent 预设」下新增/导入禁用 | ✅ 两者 `disabled=true`，`title` = 「先在右侧选一个 Agent 预设，新增的行才知道写到哪里。」 |
| 编辑全局行 → 写入平面 | ✅ 弹窗「配置范围」显示 **`全局`**，无预设下拉，服务器名 `gfixture-a` |
| 编辑 agent 行 → 只读显示预设 | ✅ 弹窗「配置范围」显示 **`预设 · t5-fixture`**，无预设下拉（`select` 数量 0），服务器名 `fixture-a` |
| 全局行不再显示「已禁用」 | ✅ 未被用户停用的行不出现「已禁用」（0 次）、「未配置」0 次（每一档相同）；**用户声明 `disabled: true` 的行仍然照实显示**「已禁用」 |
| 没有重复行 | ✅ 4 行 / 每台 1 行，重名 0 处 |

### 缺陷 1（首轮报，复测已修）：0 行预设列得出来、选不中

首轮根因：下拉的**选项**（`McpSection.tsx:317` 的 `presetChoices`，合并所有已声明预设）与**受控值**的校验
（`McpSection.tsx:300-301` 的 `activePreset`，当时仍走 `mcpAgentFilterOptions()`，而它只返回持有行的预设）来自两个集合，
`<select value={activePreset}>` 受控，于是选了 0 行预设立刻回落。实现侧已把 `activePreset` 的校验改用同一份
`presetChoices`；复测四个 0 行预设全部选得住、空态与按钮状态都正确（见上表）。

### 缺陷 2（已定位：**不是**开关问题，是全局行的写入路径）

> **更正**：本节早先写的"开关点不动、怀疑 React 事件委托"是**错误结论**。开关与 RPC 完全正常；
> 真正的失败发生在 host 侧的全局行写入。下面是定位后的读数与根因。
>
> **后续状态（2026-10-16，产物 `6C7FC6C1…`）**：实现侧据此修了"找哪个 Include"（排除 root anchor + 按行给出
> `writable`/`readOnly` 原因）与全局写入的"行必须在该 Include 文件里"校验 —— **形状 A 的停用方向已实测通过**；
> 但**启用方向暴露出新缺陷**（运行中被停用的行，开关仍显示"已启用"，无法点回去），详见**第五节**。

**现象（更正后的完整版）**：点全局行（`gfixture-a`）的开关 → 客户端**照常发出**
`POST /api/mcpManager/disableMcp`，payload 为
`{"args":{"request":{"target":{"scope":"global"},"entryId":"gfixture-a","disabled":true}}}`（`target.scope` 正确），
host 返回 `mcp/not-found`：**`MCP preset row "gfixture-a" was not found`**；客户端据此弹出 `[role=alert]`
并 `listMcps` 刷新，于是该行看起来"没反应"（行仍是启用、`aria-checked` 仍为 `true`）。

**决定性读数（同一实例、同一次会话，逐条原始值）**：

| 读数 | 全局行 `gfixture-a` | 对照：agent 行 `fixture-a` |
|---|---|---|
| React props key | `__reactProps$bu3qcgcgg8i`（**两个按钮同一个 key → 同一个 React 实例**） | 同左 |
| 开关的 `onClick` 源码 | `()=>{n(!e)}`（即原语的 `onChange(!checked)`，已压缩） | 同左 |
| 「编辑」的 `onClick` 源码 | `() => { setWritePlane("global"); openEdit(server); }`（插件代码未压缩） | `setWritePlane(...)` + `openEdit(server)` |
| 开关上还有哪些 `on*` props | **只有 `onClick`**（无 `onPointerDown`/`onMouseDown`/`onChange`） | 同左 |
| 行 fiber 的 `server` | `{"entryId":"gfixture-a","serverName":"gfixture-a","scope":"global","enabled":true,"fiberPhase":"held"}` | `{"entryId":"fixture-a",…,"scope":"preset","presetId":"t5-fixture",…}` |
| `McpRow` 的 `onToggleDisabled` / `actionsDisabled` | `function` / `false` | `function` / `false` |
| 真实指针点击（composedPath） | `pointerdown` + `click[SPAN>BUTTON#SW>SPAN>DIV>…]` —— **事件到达且冒泡** | 同左 |
| 点击后的网络（带 `--network`） | `POST /api/mcpManager/disableMcp` → `gateState` → `listMcps` | 同左 |
| 结果 | ❌ alert：`MCP preset row "gfixture-a" was not found`，行未变 | ✅ alert：**`已禁用 MCP 服务器`**，并且 profile patch 里 `fixture-a` 真的写上了 `disabled: true` |

**根因**（源码定位，`src/mcp-remote.ts`）：全局目标走
`disable()` 的 global 分支 —— `globalInclude()` → `globalMcpEntry()`（这一步**成功**，行确实活在组合树里）
→ 接着 `writeGlobalOne(include, …, (fileRows) => this.presetMcpRow(fileRows, rowId, target))`
（`mcp-remote.ts:609-613`）。**最后的回调只在 Include 自己的文件行里找这一行**；而本形状（形状 B）的全局行是
**补丁层 insert 出来的**，anchor 文件仍是 223 字节的 `[]` → 找不到 → 由 `presetMcpRow`（`mcp-remote.ts:826`）
抛出 `MCP preset row "…" was not found`（消息里写"preset"也是误导性的：这是全局写入路径）。

**两种形状下全局开关的实际可用性**：形状 A（行在用户 Include 文件里）→ `globalWritable=false`，开关与「编辑」
**在 UI 上就是禁用的**（原因 title：「这个组合没有唯一的文件型 Include…」）；形状 B → 开关可用但写入必然失败。
**也就是说目前没有一种形状能让用户从设置页切换全局行**，而且两种形状给出的反馈形式不同（一个禁用、一个报错）。
agent 行（preset 平面）**完全正常**，写入与回读都对。

**修法（不改 src，供实现侧选）**：
- **A（推荐，最小）**：`disable`/`enable`/`save`/`remove` 的 global 分支在写之前先校验这一行**是否存在于 Include 的文件行里**；
  不在就抛一个 plane 准确的错误（例如 `mcp/read-only`：「该全局行由组合补丁声明，不在 Include 文件里，无法在此切换」），
  并把 `presetMcpRow` 那条消息改成能区分平面的措辞（现在写的是 "preset row"）。
- **B（产品向）**：名册给每行加一个"可写入"标记（行 id 是否出现在该 Include 的文件行里），客户端据此把开关/编辑置灰
  并给出原因 —— 与 `globalWritable` 同源，避免"点得动但必然失败"。
- **C（只改文案）**：最小，但 UI 仍会提供一个永远失败的动作。

### 观察 2（已修，两态实测）

`title` 现在跟随**下一个动作**：启用态（`aria-checked=true`）label 与 title 都是**「禁用」**；用一份声明
`disabled: true` 的组合启动后，该行开关 label 与 title 都是**「启用」**（`aria-checked=false`，行上照实显示「已禁用」）。✅

### 观察 2'（已修，读数）

`≤760px` 隐藏、`≥761px` 显示；组标题高度**恒为 18px**（首轮是 54/72/90/126px）：

| viewport | 2000 | 1440 | 1200 | 900 | 761 | 760 | 700 | 640 | 601 | 600 | 520 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 小字可见 | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 组标题高 | 18 | 18 | 18 | 18 | 18 | 18 | 18 | 18 | 18 | 18 | 18 |
| 是否截断 | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | — | — | — | — | — | — |

**遗留**：宽容器下 `nowrap + ellipsis` 使整句读不全（1440 实测 497px 容器 / 1078px 文本，约一半字符被省略）。
若希望宽容器也能读完，建议宽容器恢复换行（`white-space: normal`）或缩短该文案。

### 未覆盖

1. **缺陷 2 的修复验证**：根因已定位（全局行写入路径只认 Include 的文件行），但**修法未落地、也未复测**；
   另外没有回归更早的产物确认这条是何时引入的。
2. **保存/写入路径**：只验证"读"的布局与弹窗写入平面的显示，**没有点保存**；agent 行的开关写入是**唯一**验证过的写入
   （它真的把 `disabled: true` 写进了 profile patch，复测后我已从场景文件还原）。
3. **`prefers-reduced-motion` 与真实手机**（软键盘、安全区）：未覆盖。
4. **深色主题**只截了 1440 与 600 两档；其余档位以审计脚本的颜色读数（弹窗 `rgb(44,44,46)`、行 `rgb(35,35,36)`）代替截图。
5. 形状 A（全局行放在独立 Include 文件）下 `globalWritable = false`，全局行的「编辑/禁用」为禁用态
   （`title` = 「这个组合没有唯一的文件型 Include，全局平面没有可写入的文件。」）—— 既有契约、非本次改动。

### 复测截图（`evidence/ui/`）

`v3-mcp-1440x900-light-default.png`、`v3-mcp-1440x900-dark-default.png`、`v3-mcp-1440-zero-row-preset.png`（选中 0 行预设
`cordis` 后的列表与空态）、`v3-mcp-601x900-light.png`、`v3-mcp-520x900-light.png`、`v3-mcp-1440-declared-disabled.png`
（声明停用的行：开关 label/title =「启用」，行显示「已禁用」）。

## 四、合并后产物全量实测（`D498FEC7…`，2026-10-16）

两条线（加载/闸门/池 + 优化）合并后的**独立复跑**。第二节的 2a–2d 绑的是旧 host 产物 `9B5D8D19…`，
本节绑新产物，结论互不替代。

| 项 | 值 |
|---|---|
| 产物 | `lib/index.mjs` = `D498FEC7A9C7A0CA47D44281FCBB0F50E2D1B9B4B02056E4B2CD6A3088B1EE0C`（195411 B）；`lib/client.js` = `AC4714B66F05EBE36CEBB22685AF2D28FB609986C344F35DA2EBDB227A1DD049` |
| 宿主 | npm 发布版 `@deepseek-ai/dsh@0.2.0-rc.2`，隔离 `DSH_HOME`（`.scratch/harness-tests/mcp-lazy-20261015-222208-05869b/dsh-home`），每次显式随机高位端口、`--no-open` |
| 驱动方式 | `scripts/run-scenario.ps1`（起实例 → 采样 marker/进程 → 跑 step-gated driver → 只停自己起的进程）+ `driver/t5-driver.mjs`（真实 `agents.create` + `tools.execute`）；浏览器部分用 Edge 155 headless + CDP |
| fixture 扩展 | `fixtures/fixture-mcp.mjs` 新增 `--tools <n>` 与 `--page-size <n>`；分页**第一页发 `nextCursor: ''`**（空串是合法游标），第二页发索引游标 —— 正是易崩清单第 27 条的形态。默认（不带参数）仍是 2 工具 / 单页，早前场景逐字节可比 |

### 逐项读数

| 验收项 | 场景（端口 / hostPid） | 结果 |
|---|---|---|
| 启动零拉起（形状 A，独立 Include） | `M1-zero-A`（38546 / 548，45 s / 5 点） | ✅ `a/b/ga/gb/opt` **五个 marker 全不存在**、fixture 进程 0、**stderr 为空** |
| 启动零拉起（形状 A，1 秒采样） | `M2-scan-A`（41503 / 33140，12 s / 11 点，T+4…T+16 s） | ✅ 每点都是 marker 不存在 + 进程 0 |
| 启动零拉起（形状 B，写在组合里，1 秒采样） | `M4-scan-B`（31689 / 35568，12 s / 10 点） | ✅ 每点都是 marker 不存在 + 进程 0 —— 形状 B 也没有瞬时 spawn |
| `eager` 对照 | `M5-eager`（33686 / 46904，24 s） | ✅ 四台（a/b/ga/gb）各 2 条 spawn，**4 个进程长期存活**；`opt` 不在该组合里，marker 不存在 |
| 常驻复用（全局行，形状 B） | `M4-scan-B` | ✅ 同会话 2 次 + 新会话 1 次 `mcp_load(gfixture-a)` → **同一个 pid `47628`**；`unload` 得 `{released:true,stopped:false}`（B 仍持有）→ `{released:true,stopped:true}`（末位） |
| 常驻复用（preset 行，形状 A） | `M3-opt`（36079 / 45292） | ✅ 整轮只 **1 条 spawn（pid 16140）**；`load-full`、`load-full-again`、另一会话的 `load-b-pooled` 都是 pid `16140` |
| `mcp_unload` 三分支 | `M3-opt` | ✅ `{released:false,stopped:false}`（该会话没加载过）/ `{released:true,stopped:false}`（别的会话在用）/ `{released:true,stopped:true}`（最后引用，进程随之消失：`processes 1 → 0`） |
| 不写回声明 | 全部场景之后 | ✅ `global-entries.yml`（1247 B，`383DB967…`）与 root anchor `cordis.yml`（223 B，`C300DCF2…`）**逐字节不变**；`cordis.patch.yml` 与最后一次场景的补丁逐字节一致；用户文件里 `disabled:` 出现 0 次 |

### 优化功能（这一轮新增的回归面）

| 验收项 | 读数 |
|---|---|
| 上游空串游标不被丢（易崩 27） | ✅ 分页序列在 `marker-optimize2.jsonl`（已归档 `archive/marker-optimize2.M6M7.jsonl`）里**独立复现 3 次**，每次都是：第 1 页 `cursor=- returned=2 nextCursor=''` → 客户端**确实带着 `cursor=''` 取了第 2 页**（`returned=2 nextCursor='4'`）→ 第 3 页 `cursor='4' returned=1 nextCursor=none`。整台加载拿回**全部 5 个工具**（只有三页都取到才可能） |
| 带 query 与不带 query 走同一条池化连接 | ✅ `M3-opt`：`load-full`(5 工具) 与 `load-query-alpha`(2 工具) 与 `load-tool-one`(1 工具) 全在同一进程 `16140` 上；`M6-narrow` 整轮也只有 1 条 spawn（pid `33732`） |
| `query` 收窄 | ✅ `M6-narrow`（38670 / 24116）**首次**加载即带 `query:'alpha'` → `tools=2 [alpha_one,alpha_two]`、**`loaded=2`**（真收窄，不是分页） |
| 同会话再 `mcp_load` 不带 query | ⚠️ `M6`：仍是 `tools=2 / loaded=2` —— **不会**把已收窄的视图加宽回整台。文档口径是"再给**新 query** 只加宽、永不收窄"，未定义"不带 query 的重载"；实测它保持收窄 |
| 收窄后恢复整台 | ✅ `M7-recover`（42128 / 5736）：`unload`（`{true,true}`）后再 `load` → 回到 `tools=5 / loaded=5`。所以恢复路径是 `mcp_unload` + `mcp_load` |
| `tool` 按名取一个 | ✅ `load-tool-one` → `tools=1 [beta_one]` |
| `limit` 分页 + `nextCursor` | ✅ `load-limit-1` → `tools=1 [echo]`、`nextCursor='o1'`、`loaded=5`（`loaded` 是选中集合，不是页大小） |
| 收窄到空不留视图 | ✅ `load-query-empty`（`query:'zzz-no-match'`）→ `tools=0` 且**不报错**；随后 `load-full-again` 仍拿到 5 个工具，说明没有留下空视图 |
| `namesOnly` | ✅ 默认与显式 `namesOnly:true` 都只返回名称/描述（`schema` 为空），与 `mcp_load` 的默认形态一致 |
| ⚠️ `mcp_load` 自己的 `cursor` 不接受空串 | `load-limit-1-cursor-empty`（`{limit:1, cursor:''}`）→ `isError=true`：`invalid cursor — pass nextCursor from the previous result, or omit it`。它自己发出的游标是非空串（`'o1'`），所以不破坏文档流程；但与易崩 27 所引用的"空串是合法游标"不对称 —— **待定**（要么接受空串，要么在文档里写明插件游标非空） |

### 设置页（合并后 client）

| 项 | 读数 |
|---|---|
| 单列表布局 | ✅ `[role="tab"]` **0** 个；全局分组在最前；4 行 / 每台 1 行（**无重复**）；`group.x == row.x`、`dx=0`、0 处重叠 |
| 噪声标记 | ✅ 「已禁用」0 次、「未配置」0 次（未被用户停用的行） |
| 预设下拉 | ✅ 列出全部已声明预设（含 4 个 0 行的） |
| 新增弹窗预选 | ✅ **已修**：工具栏选 `cordis` → 「新增 MCP」→ 弹窗「Agent 预设」= **`cordis`**（上一轮是 `standard`） |
| 独立「MCP 优化」设置页 | ✅ 导航项 `MCP 优化` 正常渲染：5 个开关（启用工具检索 / 检索时索引未缓存的服务器 / 默认只列工具名与描述 / 列出时带工具注解 / 隐藏声明为破坏性的工具）＋ 3 个数字（每次列出条数 10、单台服务器最多拉取 200、缓存有效期 5 分钟）＋ `刷新` / `清空缓存`（**该入口已于 2026-10-16 合并为「MCP 管理 → 上下文」页签，见第六节**） |
| 行开关（启用/禁用） | ❌（**根因见第三节更正后的「缺陷 2」**）全局行点击后 host 报 `MCP preset row "…" was not found`：开关与 RPC 都正常，失败在全局行的写入路径（只认 Include 的文件行）；**agent 行的开关完全正常**（alert「已禁用 MCP 服务器」，profile patch 里真的写上了 `disabled: true`） |

### 本节未覆盖

1. **真实 `npx -y` 服务器**：所有 fixture 都是直接 `node` 调用，刻意避开 `npx` 的 7.5–23 秒冷启动。
2. **GUI 里由模型决定的调用路径**：`mcp_load`/`mcp_search` 都由 driver 经 `tools.execute` 触发，没有模型参与。
3. **`tools/list_changed` 的跨会话 resync**：fixture 不发该通知，池的 fallback 扇出未实测。
4. **活动实例内运行中切换加载模式**、**`lazy` 模式的池复用**：仍未做（运行中切换会重建注册并释放 claim，值得单独一轮）。
5. **`mcp_search`**：本轮只验证了优化页渲染与 `mcp_load` 的 query/分页；`mcp_search` 工具本身的调用面未跑。
6. **写盘（新增/导入/开关）**：只验证"读"，没有点保存；行开关本身也不可用（上一行）。
7. **`mcp_load` 的空串 cursor**：只记录现象，未判定是缺陷还是待补文档。

## 五、全局行开关修复实测（最终产物 `121B8C0A…` / `E1B1051A…`）—— **已修复，实测通过**

> **本节分两段。** 前半段是**上一产物 `6C7FC6C1…` / `D5E8D7D1…`** 的状态快照（停用方向已修、启用方向不成立），
> **作为这次修复的依据保留**；后半段是**最终产物 `121B8C0A261FF54F2D5F83E3AA961F5F77B2111376BBEDD87F7724F3FD47F9B5` /
> `E1B1051A837A344FB015F164C46FDB67D6EBB79B03497691E1A94D8F72ECA7BB`** 上的复测，四个方向全部通过。

### 第一段（历史）：`6C7FC6C1…` 上的状态快照 —— 停用 ✅ / 启用 ❌

> 产物 `lib/index.mjs` = `6C7FC6C1B7B6D5E8F987C136C7576F4D0B43ED38CE89A71072111D025C2E5DFB`、
> `lib/client.js` = `D5E8D7D1EFC7BADF8F9945AA4CF8C0EAED66EF409E26F461797209EC8D837B2D` 上，
> **停用方向已修好、启用方向不成立**；下面的读数是当时的原始观测。

| 项 | 值 |
|---|---|
| 场景 | 形状 A（用户 Include `global-entries.yml`）＋ 形状 B（行写在 profile 补丁里）各一轮 |
| 实例 | 隔离 `DSH_HOME`、显式随机高位端口（38166 / 36739 / 42478）、`--no-open` |
| 浏览器 | Edge 155 headless + CDP（`--network` 抓包、真实 `Input.dispatchMouseEvent` 指针点击） |
| 驱动片段 | `browser-profile/row-detail.js`（行 fiber 的 `server` + 开关属性）、`row-suppressed.js`（`suppressed`/`pending`）、`switch-locate.js`（rect + `elementFromPoint`）、`read-probe.js`（alert/网络/命中路径） |

#### A. 形状 A：停用方向 ✅ 全绿

| 读数 | 值 |
|---|---|
| 行数据 | `{"entryId":"gfixture-a","scope":"global","enabled":true,"writable":true,"fiberPhase":"held"}` —— **`writable:true`**（本轮修复 A 让形状 A 变可写） |
| 开关 / 编辑 | 都 `disabled=false`，可点（上一产物上它们因 `globalWritable=false` 被禁用） |
| 真实指针点击后的网络 | `POST /api/mcpManager/disableMcp`，payload `{"args":{"request":{"target":{"scope":"global"},"entryId":"gfixture-a","disabled":true}}}` → `gateState` → `listMcps` |
| alert | **「已禁用 MCP 服务器」**（成功的 notice）—— 上一产物的 `MCP preset row "…" was not found` **完全消失** |
| 行渲染 | `gfixture-a 全局 已禁用 编辑`，`server.enabled=false` |
| **用户 Include 文件** | `global-entries.yml` `383DB967D6DC88F6` → **`B3ECD301F0D9B63E`**，内容里 `- id: gfixture-a` 下真的多了 `disabled: true`（副本存 `evidence/final-baseline/global-entries.yml.after-toggle-roundtrip`） |
| **anchor / 补丁层** | root anchor `cordis.yml` 仍 `C300DCF2EBC5F020`（223 B 模板）、`cordis.patch.yml` 未变 —— **逐字节不变** |

#### B. 形状 A：启用方向 ❌ 不成立（当时发现的缺陷 3）

停用成功后，**同一行**出现自相矛盾的读数：

```
row    = 'gfixture-a 全局 已禁用 编辑'                      <- 列表如实显示已禁用
switch = <button role="switch" aria-checked="true"
                aria-label="禁用" title="禁用" disabled=false>   <- 开关仍读作"已启用"
```

- **再点一次**（真实指针）→ 又是 `disabled: true`（幂等 no-op）：文件不变、alert 仍是「已禁用 MCP 服务器」。
  也就是**这一行在界面上再也回不到"启用"**。
- **整页 reload 后依旧**（客户端与名册都重读）：`aria-checked=true`、`label/title=禁用`、`suppressed=true`。
- **判别实验（关键）**：拿**同一个文件**（已含 `disabled: true`）**重启实例**，让该行从启动起就是停用状态 →
  渲染**正确**：`suppressed=false`、`aria-checked=false`、`label/title=「启用」`。
  → **只有"运行中被停用"这条路径坏**；"启动时就停用"是好的。

**根因（定位到行）**

1. 客户端 `src/client/McpSection.tsx:238`：`const allowed = server.enabled !== false || suppressed`，
   开关的 `checked` 取 `allowed`（239 行）。该行此时 `server.enabled === false`，但 `suppressed === true`
   （来自 host `gateState().suppressed`）→ `allowed = false || true = true` → 开关继续显示"已启用"。
   源码注释写明这个标志的本意是"页面跑着比 Host 旧的 bundle 时的兜底"，但现在的写法**无条件压过明确的用户停用**。
2. host 侧状态陈旧：写入 + `Include.refresh()` 之后，`gate.suppressedKeys()`（`src/mcp-gate.ts` 的
   `allowed && !wantMounted`，654/720 行）**仍含这一行**；而 `suppressedEntryIds()`（推 `fiberPhase:'held'` 的那个）
   在两种情形下都含它 —— 所以 `held` 不是判据，**陈旧的 `suppressed` 状态才是**。
3. 名字误导：host 抛的 `MCP preset row "…" was not found` 出现在**全局**写入路径上（`presetMcpRow` 作为
   `writeGlobalOne` 的文件行回调），文案应能区分平面。

**修法方向（两条都做）**

- 客户端一行：`const allowed = server.enabled === false ? false : (server.enabled === true || suppressed)`
  —— 让明确的 `enabled:false` 优先于兜底标志。
- host：声明变化 / `Include.refresh()` 之后清掉该行在 gate `states` 里的 `suppressed`。

**形状 B（预读，正式一轮待下一轮补齐）**：全局行 `{"writable":false,"readOnly":"no-writable-include"}`，
开关与「编辑」**都 `disabled=true`**，tooltip =「这个组合没有你自己可写的文件型 Include，全局行无法从设置页开关或编辑。
请在自己的组合文件里用一个 Include 行声明这些全局行。」——即修法 B1/B2 生效；`mcp/read-only` 的"强行 `el.click()`
绕过"尚未实测（按钮已 `disabled`，点击不会派发）。

#### C. 当时未跑 / 未覆盖

1. **形状 B 的完整验证**：置灰读数已有（见上），但"强行 `el.click()` → host `mcp/read-only` 拒绝"、以及该轮的文件不变断言未跑。
2. **名册每台全局行的实际条数**：本轮只顺带看到 `rows=4 / dupes=0`（2 台全局 + 2 台 agent），
   harness-tests 报的"同一行被列两次"未单独复现或证伪。
3. **回归抽验**（零拉起 1 秒采样、池复用同一 pid、单列表与优化页渲染）本轮未跑。
4. **启用方向的修复验证**：等新产物。

### 第二段（最终产物 `121B8C0A…` / `E1B1051A…`）：四项一轮跑齐，全部通过

| 项 | 值 |
|---|---|
| 产物 | `lib/index.mjs` = `121B8C0A261FF54F2D5F83E3AA961F5F77B2111376BBEDD87F7724F3FD47F9B5`；`lib/client.js` = `E1B1051A837A344FB015F164C46FDB67D6EBB79B03497691E1A94D8F72ECA7BB` |
| 宿主 | npm 发布版 `@deepseek-ai/dsh@0.2.0-rc.2`，隔离 `DSH_HOME`，端口 36652 / 40870 / 36896 / 41156 / 38963 / 38514、`--no-open` |
| 浏览器 | Edge 155 headless + CDP（`--network`、真实指针点击；`scripts/cdp.mjs` 本轮加了"按 URL 选页面目标"，避免扩展标签页抢到首位） |

#### 1. 形状 A 往返 ✅（本轮重点）

| 步骤 | 读数 |
|---|---|
| 起点 | `server={"entryId":"gfixture-a","scope":"global","enabled":true,"writable":true,"fiberPhase":"held"}`；开关 `aria-checked=true`/label「禁用」`disabled=false`；「编辑」可点 |
| 点停用 | `POST /api/mcpManager/disableMcp`，payload `{"args":{"request":{"target":{"scope":"global"},"entryId":"gfixture-a","disabled":true}}}` → `gateState` → `listMcps`；alert **「已禁用 MCP 服务器」** |
| 停用后 | 行 `gfixture-a 全局 已禁用 编辑`；**开关 `aria-checked=false` / label「启用」/ title「启用」**（上一产物坏掉的那条，现在正确了）；用户 Include `383DB967D6DC88F6` → **`B3ECD301F0D9B63E`**，`- id: gfixture-a` 下真的写了 `disabled: true` |
| 点启用 | 同一个 RPC，payload 变成 `"disabled":false`；alert **「已启用 MCP 服务器」** |
| 启用后 | 行回到 `gfixture-a 全局 编辑`；开关 `aria-checked=true`/label「禁用」；用户文件里 `disabled: true` **0 行**（文件 → `FAE9D4DE9A5F324A`） |
| anchor | `cordis.yml` 在**启动前 / 启动后 / 打开设置页后 / 停用后 / 启用后 / 实例停止后**六个时点全部是 `223B`/`C300DCF2EBC5F020` —— **全程逐字节不变** |
| `cordis.patch.yml` | 与被复制进去的场景补丁逐字节一致（此前看到的差异是宿主自己的 `ui-settings-general` 开局提示行，不是本插件） |

**⚠️ 一个需要你知道的副作用（不是本次修复引入）**：全局写入是把 Include 的**行列表序列化回文件**，所以用户文件会被重写 ——
注释被丢掉、引号风格被规范化（`'C:\...'` → `>-` 折叠标量）、启用后两行都留下显式的 `disabled: false`。
`disabled: true` 确实被移除（功能正确），但**文件不会回到逐字节原样**（1247 B → 942 B）。
用户手写在那个文件里的注释会消失；若要保留注释，需要"只改该行的 `disabled` 键"而不是整表序列化。

#### 2. 形状 B：置灰 + host 拒绝 ✅

| 读数 | 值 |
|---|---|
| 行数据 | `{"entryId":"gfixture-a","scope":"global","enabled":true,"writable":false,"readOnly":"no-writable-include","fiberPhase":"held"}` |
| 开关 | **`disabled=true`**，tooltip =「这个组合没有你自己可写的文件型 Include，全局行无法从设置页开关或编辑。请在自己的组合文件里用一个 Include 行声明这些全局行。」 |
| 「编辑」 | 同样 `disabled=true`，同一句原因 |
| 真实指针点击 | 0 个请求（按钮 `disabled`） |
| `el.click()` | 0 个请求 —— **合成点击在 `disabled` 按钮上不派发** |
| `dispatchEvent(new MouseEvent('click'))` | 0 个请求 |
| 去掉 `disabled` 属性后再 `.click()` | 0 个请求（React 按 props 判定禁用，仍不派发） |
| **直接重放 RPC**（`fetch('/api/mcpManager/disableMcp', …)`，仅用于触达 host 守卫） | HTTP 200 + `{"ok":false,"error":{"code":"mcp/read-only","message":"global MCP rows are written through a file-backed Include of your own","details":{"target":{"scope":"global"},"reason":"the composition mounts only the host profile Include, whose file the host regenerates"}}}` ✅ |

即：UI 侧根本发不出这个请求（三重绕过都 0 请求），host 侧也确实以 `mcp/read-only` 拒绝 —— 两侧都成立。
"强行 `el.click()` 会被 host 拒绝"这句要修正为"**合成点击到不了 host；直接重放 RPC 才会看到 `mcp/read-only`**"。

#### 3. 名册每台全局行的条数 ✅ 每台 1 条

- 驱动侧 `listMcps`：`entries(count=2)` = `gfixture-a:True/held | gfixture-b:True/held` —— **每台恰好 1 条**。
- 设置页审计：`rows=4`（2 全局 + 2 agent）、`duplicates=0`。
- harness-tests 报的"同一行被列两次"**在本产物上未复现**；本轮读数与它一致（每台 1 条）。

#### 4. 回归抽验 ✅

- **启动零拉起（形状 A，1 秒采样）**：`R2-zero` 共 11 个采样点（T+4…T+15 s），`a/b/ga/gb/opt` 五个 marker 全部不存在、
  fixture 进程 0、**stderr 为空**。
- **池复用**：`R1-regress` 三次 `mcp_load(gfixture-a)`（同会话两次 + 新会话一次）**同一个 pid `28812`**；
  两次 `mcp_unload` 得 `{released:true,stopped:false}` → `{released:true,stopped:true}`。
- **单列表布局 + 优化页**：设置页 `[role=tab]` 0 个、全局分组在最前、4 行无重复、`dx=0`、无「已禁用」/「未配置」噪声；
  独立「MCP 优化」页渲染正常（5 个开关 + 3 个数字 + `刷新`/`清空缓存`）。截图：
  `evidence/ui/final-B-mcp-1440-light.png`、`evidence/ui/final-B-optimize-1440-light.png`。
  **这两条读数绑的是当时的产物**：后来的合并（2026-10-16，第六节）把优化面收进页内页签、并让渲染了开关的行
  不再重复标「已禁用」，所以 `[role=tab]` 现在是 5 个（页面 2 个 + 加载方式 3 个），"无「已禁用」噪声"仍然成立。

#### 5. 一个未能复现的一次性异常（如实记录）

在**第一段那轮的 R1/R2 之间**，root anchor `cordis.yml` 曾被写成 **46973 B 的完整组合树**（mtime 09:52:49）——
正是"Loader 树写回把带补丁的组合烘进 anchor"的形态。之后我做了四次对照，**都没能复现**：

1. 纯运行（形状 A、dynamic、8 s + 停实例）→ anchor 始终 223 B；
2. 完整往返（启动前 / 启动后 / 开设置页 / 停用 / 启用 / 停实例 六个时点）→ 223 B；
3. 两个实例**并发**共用同一 `DSH_HOME`（起、查、停）→ 223 B；
4. 又一次纯运行 → 223 B。

判断：这是**宿主级的已知形态**（`app-boot` 的注释就写明"Loader 的树写回会把组合烘进这个文件，所以每次启动都把它重写成空模板"），
且该文件**每次启动都会被宿主重写回 223 B 模板**，所以它自愈、不影响用户数据；用户自己的 Include 全程只被"有意点击"改过。
**但它确实违反了"anchor 逐字节不变"这条断言**，因此留在这里等实现侧判断是否需要追。

### 仍未覆盖

1. **真实 `npx -y` 服务器**：fixture 都是直接 `node` 调用，刻意避开 `npx` 的 7.5–23 秒冷启动。
2. **GUI 里由模型决定的调用路径**：`mcp_load`/`mcp_unload` 都由 driver 经 `tools.execute` 触发，没有模型参与。
3. **`tools/list_changed` 跨会话 resync**：fixture 不发该通知。
4. **活动实例内运行中切换加载模式**、**`lazy` 模式的池复用**、**`mcp_search` 工具本身**。
5. **写盘的其他路径**：新增/导入/删除行、以及编辑弹窗的「保存」都没有点过；本轮只验证了行开关（停用/启用）。
6. **用户 Include 的注释保留**：见第 1 项的副作用，未做任何规避。

## 六、两页合并为页内页签（2026-10-16，产物 `B7A9BEEA…`）

> 本节读数绑定产物 `B7A9BEEA…`：当时标题下两个页签叫 `服务器` / `上下文`，加载方式块在名册页签里。
> 2026-10-16 稍后改为 `服务器` / `设置` 并把加载方式移进第二个页签（D24，见第九节），下面这行的字面读数**按当时产物**保留。

上一轮把「MCP 优化」做成独立的第二条 `settings.section`（order 15）。本轮把它并回**一个**设置页的第二个页签，
并把名册页按「先取证再改」重排（页头、两行工具栏、行内描述、状态徽标、筛选、计数口径）。触发是用户反馈：
"MCP 管理插件的页面布局很混乱，且出现两个页面"。环境与产物：

| 项 | 值 |
|---|---|
| 宿主 | npm 发布版 `@deepseek-ai/dsh@0.2.0-rc.2`（= npm `latest`/`next`），隔离 `DSH_HOME` `.scratch/harness-tests/mcp-ui-0.2.0-rc.2-20261016-113243`，端口 53145，`--no-open`，实例 pid 47496（node 41788） |
| 插件产物 | `lib/client.js` = `B7A9BEEA208244B1…`（176271 B）、`lib/index.mjs` = `121B8C0A261FF54F…`（202504 B，本轮未改 host 侧） |
| 组合 | 插件以 `link:` 装进该 profile（`dsh plugin --profile web add <工作树>`），改完源码 `npm run build` 即对页面生效，不需要重装 |
| fixture | 7 行 Agent 预设行（`fixture-alpha/beta/final/final2` + `playwright-mcp` + `yunxiao` + `skillsmp`），**全部由本轮的新增弹窗创建**，用来验证"平面选择进弹窗"这条路径本身；全局平面 0 行、无用户 Include（`globalWritable = false`），正好覆盖"全局那一档不可选" |
| 驱动 | Playwright 1.61.1（`chromium_headless_shell-1228`），`ignoreDefaultArgs: ['--hide-scrollbars']`；脚本与 `report.json` 在 `.scratch/mcp-ui-verify/` |

### 逐项读数

| 验收项 | 结果 |
|---|---|
| 侧栏只有一个 MCP 入口 | ✅ `nav button` 文本里以 `MCP` 开头的**只有 `MCP 管理`**（此前是 `MCP 管理` + `MCP 优化`） |
| 页头与页签 | ✅ `H2 MCP` + 一行 14/22 说明 + `SegmentedTabs`（`服务器` / `上下文`，`aria-selected` 正确切换）；两个 tabpanel 一个渲染、另一个 `hidden` |
| 「新增 MCP」首屏可用 | ✅ 默认视图（全部 Agent 预设）下按钮**不再禁用**；旧实现下 `needsPreset` 让它和「导入」在首屏就是灰的（原因只在 `title` 里，且文案还写着已经不在"右侧"的下拉） |
| 写入平面在弹窗里可选 | ✅ 新增弹窗有「配置范围」下拉：`全局[d]`（该组合没有可写的 fileInclude）+ `Agent 预设*`，原因就地写明；保存按钮**可用** |
| 端到端写入 | ✅ 7 行全部经该弹窗写入 `profiles/web/cordis.patch.yml` 的 `standard` 预设声明（`serverName` / `transport` / `command` / `args` / `env` / `cwd` 落盘正确），名册随即刷新出该行 |
| 描述是内容不是空字段 | ✅ 空描述渲染成「添加描述」；点开变 28px 输入框；输入 90 字时出现「模型只看到前 80 个字符」（常量取自 `src/mcp-inventory.ts`，未复制）；回车保存后行内显示新描述，落盘见 `descriptions: preset:standard:<name>` |
| 状态徽标不再逐行刷 | ✅ 把一行关掉后，行文本里**没有**「已禁用」（开关自己就是状态）；`rowAfterDisable` 与 `rowAfterEnable` 只差开关位置 |
| 计数口径 | ✅ 不筛选时 `7 行 · 已启用 6`；输入 `fixture` 后 `匹配 4 / 共 7 行`（分组标题同步只报本组渲染行数）；输入不存在的名字时两组都显示「没有匹配的服务器」且**不出现**新增按钮 |
| 「上下文」页签 | ✅ 4 组 6 个标题、5 个开关、3 个数字、目录状态独立成块；页签切换后名册内容不在 `innerText` 里（`hidden` 生效，未被自己的 `display: flex` 盖掉） |
| 按字段保存态 | ✅ 独立探针（`probe-savenote.cjs`）：`idle → 保存中`（点击当帧）`→ 已保存`（t+300ms / t+1000ms）`→ idle`（t+2600ms，2.5 秒后自动消失）；无 `role="alert"`，开关值与写入一致 |
| 盒子几何（11 档） | ✅ 320/360/390/430/600/601/760/761/1024/1280/1440：页标题、tabpanel、首行的**左右边界差同时为 0**（见下表）；`documentElement.scrollWidth === clientWidth`，面板 scrollWidth 也未溢出 |
| 浅色 + 深色 | ✅ `colorScheme: dark` 下 `body` 背景 `rgb(21,21,23)`、面板文字 `rgb(249,250,251)`；两套截图见下 |
| 控制台 | ✅ 0 条 `error`/`warning`、0 条 `pageerror` |
| 静态约束 | ✅ `npm run typecheck` 通过；`npm test` **21 文件 / 228 项通过**（含扩到两份样式表的 `tests/client-css.spec.ts`，18 项） |

两次运行（`7073A435…` 与最终 `B7A9BEEA…`）的逐项读数一致；上表与下表是**最终产物**那一轮的读数。

边界读数（内容列，`L/R` 为该元素 border-box 左右缘）：

| 窗口宽 | 设置面板 | 内容列宽 | 页标题 / tabpanel / 首行 | dL | dR |
|---|---|---|---|---|---|
| 320 | 272 | 31 | `(236,267)` 三者相同 | 0 | 0 |
| 390 | 342 | 101 | `(236,337)` | 0 | 0 |
| 601 | 553 | 312 | `(236,548)` | 0 | 0 |
| 760 | 712 | 471 | `(236,707)` | 0 | 0 |
| 1024 | 800 | 559 | `(324,883)` | 0 | 0 |
| 1440 | 800 | 559 | `(532,1091)` | 0 | 0 |

（1024 起内容列 559px 而不是 564px：名册长到出现滚动条后 shell 的 `.options` 让出了 rail。320–761 五档下内容列只有
31–471px，是**宿主设置面板本身**在窄窗口仍保留 188px 左侧导航所致，与本插件无关，本轮未改宿主。）

### 已知缺口（如实保留）

1. **删除行仍不可用**：整个插件只有 新增/编辑/停用/导入，`deleteMcp` 在 `src/`、字典与 Remote 接口里都没有。
   54 行全停用后清不掉，只能一行行关。要做得先加 Host 侧 Remote（全局走 Include 文件重写，preset 走 `configEditor.edit`）。
2. **没有批量启用/停用**：`disableMcp` 是单行接口，批量要新增 `disableMcps`（D12 已经证明逐行循环 = 每个 preset
   全量重启一轮，所以不能在前端循环）。
3. **名册里的描述保存没有反馈**：`updateMcpDescription` 仍是 fire-and-forget（`settings-controller.ts`），
   失败只写控制台。优化页那一面已有按字段的保存态，名册这一面还没有。
4. **窄窗口（≤761px）下设置面板内容列只有 31–471px**：宿主的问题（面板不切单列、导航不收起），本插件只保证
   不横向溢出、按容器断点堆叠；真机软键盘与 `pointer: coarse` 未测。
5. **只测了 6 行**：54 行那种规模下的滚动性能与更长列表未测；`report.json` 里的 `saveNote*` 字段是脚本按行文本
   截 60 字取样，**不能**当保存态证据（有效读数是独立的 `probe-savenote.cjs`）。

### 截图（`.scratch/mcp-ui-verify/`）

`10-mcp-empty-light-1440.png`（空名册 + 两个页签）、`11-add-dialog.png`（配置范围：全局禁用 + 原因）、
`12-after-add.png`（写入后的行）、`13-description-over-budget.png`（80 字预算提示）、`14-filter-empty.png`、
`14b-row-disabled.png`（关掉的行无「已禁用」）、`15-context-tab.png`、`16-save-note.png`、
`20-roster-{1440,760,601,390,320}.png`、`30-roster-dark-1440.png`、`31-context-dark-1440.png`。
README 用的三张图（`docs/images/mcp-settings.png`、`mcp-context.png`、`mcp-editor-import.png`）已用这一轮的产物重拍。

## 七、审查修复轮复跑（2026-10-16，产物 `53FD00C5…` / `9777E8E9…`）—— **两套测试全绿，隔离实例未复跑**

代码审查（1.3.0 之后的 7 个提交）定级的问题在本轮修完要紧项，每组修复后都重跑了两套测试：

1. **catalog 漏传**：`index.ts` 把共享目录交给 `registerMcpTools`（参数改必传），新增回归
   「one catalogue serves every registration generation」（mcp-load.spec）。
2. **超时泄漏子进程**：`connectLazyWithin` 在超时后关闭迟到的 client（search 索引 8s 预算、编辑器列表 30s）；
   新增「closes the client a lost race still produces」与「hands the client over untouched」。
3. **池 claim 竞态**：claim 记号按次计数、`release` 只结算真实 claim、`claim` 拒绝已关闭连接、claim 提前到
   acquire 之后；新增池单测两条与「two parallel loads of one server settle on one view」。
4. **发布点反序**：file-backed 行改走「先遮蔽后处置」（late-hold 同序），新增两条 gate 单测（顺序断言 +
   未识别 entry 不动）。
5. **保存三态**：描述行/工具规则/优化行的保存中-成功-失败三态、失败保留草稿与原因、IME 守卫、
   `setOptimize` 串行化合并写（防丢更新）。
6. **文案口径**：截断提示不再承诺 `query` 能找回截掉的工具（它做不到）；零工具服务器不再误报
   「换个词再搜」；`opt.maxTools.desc` 同步改为如实描述。
7. **UI 规范小项**：禁用态 `opacity:.5;cursor:default` 补齐 select/textarea/checkbox；`.mcpFilterSelect`
   并入 600px 16px 规则。
8. **`tools/list_changed` 重列翻页**：池的重列走 opener 的 `relist`（宿主传 `listAllTools` 游标遍历），
   不再把分页服务器静默缩成第一页，`truncated`/`ttlMs` 随之更新；新增「re-walks every page through the
   opener relist」。

**读数**：`npm run typecheck` 通过；`npm test` **21 文件 / 237 项**全绿（修复前 21/219）；`npm run test:harness`
**6 文件 / 25 项**全绿（真实 Loader）。产物 SHA-256 前 8 位：`lib/index.mjs` `53FD00C5`、`lib/client.js` `9777E8E9`。

**未覆盖（如实）**：隔离实例协议**没有**对新产物复跑——第五节的实测读数仍属于 `121B8C0A…` / `E1B1051A…`
那份产物，README 已按此改写；`settings-controller` 写队列无单测（`@deepseek-ai/dsh-client-store` 的 zustand
依赖在 Node 下解析不到，controller 不能进 Node 测试）；逐行保存三态只做了代码与类型验证，未走浏览器实测；
并发 `mcp_load` 的收敛用单测固定，多会话真并发的进程计数未在隔离实例复测；`mcp_search` 索引仍在 TTL 过期后
为活着的池连接另起一个短命连接（去重已加，走池复用是后续设计项），search 侧命中数被 `maxTools` 截断时
也仍不回报 truncated。

## 名册布局改版：一个平面、按行标注、按卡片编辑（2026-10-16，D22）

本节验证本轮**可见界面**改动：删掉「全局 · N 行」「Agent 预设 · N 行」两个分组标题与预设下拉里的
「全部 Agent 预设」项；列表恒为平铺列表，全局行在前带「全局」标签、预设行以一行小字报预设名；点卡片
本身打开编辑器；有 `env`/`headers` 的行按钮是「密钥」并直接落在编辑器新增的「密钥」页。取舍见
[design-decisions.md](design-decisions.md) 的 D22。

**环境**：npm 发布版宿主 `@deepseek-ai/dsh@0.2.0-rc.2`（当时的 `latest`/`next`），随机高位端口、独立
`DSH_HOME`（`.scratch/harness-tests/mcp-layout-0.2.0-rc.2-a7f3`），插件以 `plugin add <本地目录>`
（pnpm 记为 `link:`，改 `lib/` 后重启实例即生效）装进该 profile；浏览器用 Playwright 驱动的
`chrome-headless-shell` 149.0.7827.55，1440×900 起测，脚本与截图在
`.scratch/mcp-layout-verify/`（`verify.mjs`、`verify-result.json`、`shots/v-*.png`）。夹具在该 profile 的
`cordis.patch.yml`：全局行 `gv-headers`（headers）/`gv-plain`（空 headers）/`gv-stdio-env`（env），
预设 `mcp-verify` 下 `pv-env`（env）/`pv-plain`（空 headers）。验收产物：
`lib/index.mjs` SHA-256 `DAA6878D…`、`lib/client.js` SHA-256 `39F02038…`（**该 client.js 里还含同分支并发提交的
Toast 浮层改动**；本轮浏览器读数的截图即取自这一版，见下表）。

**重要说明（并发提交）**：本轮验收跑在一个**同时有另一个会话在写本仓**的工作树上。15:09 起该会话提交了
`b94cfb5`（目录清理提示）与 `aba3002`（行写入提示，含 `lib/client.js` 重建），期间 `src/client/McpSection.tsx`
于 15:11 被外部重写一次、`lib/` 重建两次；本节读数因此**绑定到上面那对产物指纹**，而不是任何更早的构建。
两次核对：`npm test` 22 文件 / 253 项、`npm run typecheck`、`npm run build` 在提交前全部通过，且 `npm run build`
对当前源码是**幂等**的（重建后 `lib/` 无 diff）。

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 无分组标题 | ✅ | `01` 断言：以「全局/Agent 预设 · N 行」正则扫全对话框段落/标题，命中 **0** 个 |
| 下拉无冗余项 | ✅ | `02a`：`options=["standard","ptc","minimal","cordis","mcp-verify"]`，无「全部 Agent 预设」 |
| 选预设后全局行仍在且被标注 | ✅ | `02b`/`02c`：选 `mcp-verify` 后 5 行 = 3 全局 + 2 预设；3 个全局行含「全局」、2 个预设行不含 |
| 有密钥的行显示「密钥」 | ✅ | `03a`：`{gv-headers:密钥, gv-plain:编辑, gv-stdio-env:密钥, pv-env:密钥, pv-plain:编辑}` |
| 点「密钥」直接落在密钥页 | ✅ | `03c`：页签 `[配置, 密钥, 工具列表]`、可见页为「请求头」、字段 `Authorization=Bearer gv-token`、`X-Verify=layout`；`03c2`：stdio 行可见「环境变量」且 `GV_TOKEN=abc` |
| 点「编辑」落在配置页 | ✅ | `03d`：可见页含「JSON 配置」与 JSON 正文 |
| 点卡片空白处打开编辑器 | ✅ | `04a`：在行内空白坐标真实点击后 `[role=dialog]` 数 > 1（截图 `v-01…`） |
| 点描述文字不打开编辑器 | ✅ | `04b`：点描述按钮后对话框数不变（就地编辑） |
| 点开关不打开编辑器 | ✅ | `04c`：点开关后对话框数不变（该行开关状态随后复位） |
| 无横向溢出 | ✅ | `05-*`：320/360/430/601/760/1024/1440 七档 `documentElement.scrollWidth == clientWidth`，且对话框 `scrollWidth == clientWidth` |
| 深色可读 | ✅ | `05-dark`（1280×900，`colorScheme: dark`）：行卡片底色 `rgb(44,44,46)`、文字 `rgb(249,250,251)`，无溢出 |
| 控制台干净 | ✅ | `06`：无 `console.error` / `pageerror` / `requestfailed` |

**本轮修掉的两个真 bug（都由上面的实测抓到，不是源码推断）**：

1. **全局行的配置没有过到名册**：`McpGlobalRow` 不带 `config`、名册为组合行构造 options 时也只写
   `{id,name}`，于是有 `env`/`headers` 的**全局行**按钮仍是「编辑」（`secretKeys` 恒空），组合全局行的
   「未配置」标记也一起失效。修法：`mcp-gate.ts` 的 `readGlobalRows()` 在行里带上 `entry.options.config`
   （只读、不写不落盘），`mcp-roster.ts` 透传给 `rosterRow`。回归测试：`tests/mcp-roster.spec.ts` 的
   「reports a composed global row's credential field names…」（含「序列化结果不含密钥值」断言）。
2. **「密钥」打开后停在「配置」页**：编辑器常驻挂载（关闭时 `open=false`），`useState(openTab)` 只在首次
   挂载求值，之后点「密钥」不会改页签。修法：在 `open` 的 effect 里 `setTab(openTab)`，并把 `openTab`
   列入依赖。`03c` 复测通过（修复前该断言 FAIL，可见页是「配置」）。

**已知限制（如实）**：窗口 **≤601px** 时宿主设置壳仍保留左侧 188px 导航，面板内只剩约 224px，本插件的
section 被压到约 36px 宽、行卡片被裁切（截图 `shots/v-03-width-360.png`，360×900）。实测
`documentElement.scrollWidth == clientWidth`（无文档级横向溢出），且该压扁来自宿主设置壳自身的窄窗布局
（导航栏不收起）——**本插件未改动宿主设置壳，也未修复该行为**；≤601px 下的可用性属宿主设置壳的已知
缺口，修它需要动宿主而不是本插件。

**未覆盖（如实）**：
- 真机/粗指针（`pointer: coarse`）触摸目标、iOS 软键盘与安全区未测——本轮只跑无头 Chromium 的鼠标事件。
- `prefers-reduced-motion: reduce` 只做代码层保证（`@media` 块关闭 `.mcpRow` 过渡），未在浏览器里录到差值。
- 「密钥」页的**保存**未走通端到端：本轮只验证了字段读取与页签落点，没有点「保存」写回 composition 文件
  （`EditMcpRequest` 的写入路径仍只有单测与类型验证）。
- 空态未取到实测：该 profile 的每个已声明预设都至少有一行，`extra-empty-state` 因此返回 `null`（未验证，
  不是通过）；文案改动只做了单测与类型检查。
- `npm run test:harness` **未在本轮复跑**（本次改动只碰名册/闸门读取与浏览器半边，harness 回归仍以
  D17 的 6 文件 / 25 项读数为准）。
- 滚动条外观未做像素剖面复核（无头截图默认 `--hide-scrollbars`；本轮判定的是盒子测量而非滚动条形状）。

**读数（本轮）**：`npm run typecheck` 通过；`npm test` **22 文件 / 253 项**全绿；`npm run build` 通过，
`lib/index.mjs`、`lib/client.js` 与源码同批提交。

### 追加修复与**定向**复测（2026-10-16 15:17，非全量复跑）

独立验收人在本轮产物上复核出两条交互缺陷，两者都已修复，并用**只针对这两条**的脚本 `verify-keyboard.mjs`
（同一隔离实例、1280×900、无头 Chromium）复测，**没有**重跑上面的全量 22 项：

| 缺陷 | 修法 | 定向读数 |
| --- | --- | --- |
| 卡片是 `div`，Tab 焦点落不到它（验收项 4 的键盘子句曾判未通过） | 卡片加 `tabIndex={0}` 与 Enter/Space 处理；命中判定抽成 `fromRowControl()`，行内控件自己处理按键 | `card-focusable`：`focus()` 后 `activeElement` 就是卡片、`tabindex="0"`；`card-enter-opens`、`card-space-opens` 均 true；`control-enter-does-not-open-card` 为 false（行内控件按 Enter 不会连带打开编辑器） |
| 描述就地编辑时按 Esc 会连带关闭整个设置弹窗 | 描述输入框的 Escape 分支 `stopPropagation()`，只取消草稿 | `escape-cancels-draft-only`：按键前后对话框数都是 1，仍是「设置 / MCP 管理」 |

追加修复后的产物：`lib/index.mjs` SHA-256 `CB726D57…`、`lib/client.js` SHA-256 `E3067B1F…`（MD5 `C7E8637A…`）。
**注意**：上面那张 22 项总表读的是**追加修复前**的产物 `lib/client.js` `39F02038…`；追加修复只碰卡片的键盘
处理、描述框的 Escape 与卡片焦点环，未改动列表结构、筛选、按钮文案或密钥页，但**全量 22 项没有在新产物上
重跑**——按当轮指示只做定向验证。

## 八、连接掉线的感知与恢复（2026-10-16，合并后产物 `444E9B1E…`）—— **单测新增 6 项，两套测试全绿；隔离实例未复跑**

**改动**：池新增「丢失」状态（`PooledConnection.lost`，与「我们自己关掉的」分开）。`LazyClient.onclose`（SDK 的传输结束回调，对我们自己的 `close()` 同样触发）在 `watch` 里接到这条连接自己的 `end(lost)` 闸门；判定为丢失时连接**立刻移出池**、warn 一次、调 `ConnectionOpener.onConnectionLost`，注册侧 `McpToolRegistration.connectionLost` **撤回每个会话对它的视图**，行仍留在按需清单里，所以下次 `mcp_load` 会拉起新进程并注册新的一代工具。设计与被否决方案见 [design-decisions.md](design-decisions.md) D23。

**读数**：

- `npm run typecheck` 通过；
- `npm test` **21 文件 / 243 项**全绿（改动前 21/237，本轮新增 6 项：`tests/mcp-pool.spec.ts` 5 项 + `tests/mcp-load.spec.ts` 1 项）；
- `npm run build` 通过；
- `npm run test:harness` **6 文件 / 25 项全绿**（`zero-launch` 4、`global-zero-launch` 5、`on-demand-pool` 4、`global-authoring` 3、`plugin-startup` 3、`preset-compat` 6）。本轮只给两个 harness spec 的 opener 补了新的必填成员，未改它们的断言。
- **合回 `main` 后在同一棵树上复跑**（该树同时含 D22 名册布局那批改动，上面 21/243 是合并前单独跑在 `b94cfb5` 基线上的读数）：`npm run typecheck` 通过；`npm test` **22 文件 / 259 项**全绿；`npm run test:harness` **6 文件 / 25 项全绿**；`npm run build` **幂等**（重建后 `lib/index.mjs` 无 diff）。本节的产物指纹 `444E9B1E…` 取合并后的这次构建。

**关于 `lib/client.js`（操作坑，本轮踩到）**：**它不在本次提交里**。构建产物里的 CSS module 类名哈希是**由文件路径派生**的（本轮在 `.scratch/worktrees/…` 下构建得到 `_3uWxFG_`，主仓路径下是 `y1VbRq_`），所以**在 worktree 里 `npm run build` 必然得到一份与主仓不同的客户端产物**。本改动不涉及 `src/client/`，故把它还原为 HEAD 版本；`lib/index.mjs` 不含绝对路径，是路径无关的，正常提交。**在 worktree 里改客户端代码时要注意这一点**：产物必须在主仓路径下重建，否则会带进整份类名 churn。

**用例确实能抓到缺陷（不是空转）**：

- 把 `connection.client.onclose = () => { end(true) }` 临时摘掉后重跑 `tests/mcp-pool.spec.ts`，新增 5 项里 **4 项变红**；第 5 项「自己的关闭不算丢失」是防误报守卫，旧行为下本就通过（它挡的是「把任何 `onclose` 都当丢失」那种写法）。
- 把 `lazy-mcp.ts` 里 `connectionLost` 的接线临时摘掉后重跑注册层用例，报 `expected [ 'mcp_load', 'mcp_search', …(2) ] to not include 'mcp__alpha__a'` —— **死工具仍留在会话里**，正是本次要修的缺陷。
- 两处临时改动均已还原并重跑全绿（typecheck + 243 项）。

**未覆盖（如实）**：

- **stdio 子进程被强杀后传输层是否必然触发 `onclose`，本轮没有实测**：单测直接调用 `client.onclose()` 模拟，没有真杀进程；隔离实例的 marker / 进程计数协议未对本产物复跑。
- **挂死**（进程还在、既不结束也不响应）既没有 `onclose` 也没有超时，池不会做任何事 —— 本轮明确不解决的边界（与 D17 的「挂死仍无超时」一致）。
- 视图撤回后模型侧的观感（工具消失、行仍在清单里可重新加载）未走浏览器实测。

## 九、页签改名「设置」并把加载方式移入（2026-10-16，D24，client 产物 `E6F79864…`）

改的是可见布局（D24）：第二个页签从「上下文」改名「设置」、加载方式块移进它、名册页签删掉 `mcp.list.hint`
那句说明、标题计数不再带 `· 筛选：{name}` 后缀。因此**必须回到隔离实例复跑**，不能只看单测。本轮**只读页面**
（打开、切页签、量盒子、截图），不加行、不改开关、不切加载方式。

### 环境与产物绑定

| 项 | 值 |
|---|---|
| 宿主 | npm 发布版 `@deepseek-ai/dsh@0.2.0-rc.2`（沿第六节那台隔离实例的版本） |
| `DSH_HOME` | `.scratch/harness-tests/mcp-ui-0.2.0-rc.2-20261016-113243`（profile `web` 只挂本插件，`link:` 指向本仓） |
| 端口 / 进程 | 53145，`npx dsh web --port 53145 --no-open`，跑完按 PID 与端口监听两个条件都核对后停止（`port released: True`） |
| Node / 浏览器 | v24.12.0；Playwright 1.61.1（`chromium_headless_shell-1228`），`ignoreDefaultArgs: ['--hide-scrollbars']` |
| 本轮 client 产物 | `lib/client.js` = `E6F79864B397D9DEC919063CDEDF3147C03EE9EFB2FB7687CD0D634921A0AA06` |
| 本轮 host 产物 | `lib/index.mjs` = `444E9B1E5F6CD35E86055B743DB2FB6C962F8F7E9C851CF5136987FF3CF5ECE5`（与第八节同一份，本轮 host 源码未改，重建后内容一致） |
| 数据 | 隔离命名空间里第七节留下的 7 行 fixture（1 个预设 `standard`），全部只读渲染 |
| 脚本与读数 | `.scratch/mcp-ui-verify/verify-tabs.cjs` + `verify-tabs.ps1`，结果 `report-tabs.json` |

### 逐项读数

| 验收项 | 结果 |
|---|---|
| 页签名称 | ✅ `[role="tab"]` 里页面级两枚是 `服务器` / `设置`，`aria-selected` 随点击正确切换（另有三枚是加载方式的 `SegmentedControl` 分段） |
| 加载方式移入「设置」 | ✅ 名册页签的 `[role="tabpanel"]:not([hidden])` 里 **`h3` 只有 `服务器列表` 一个**；「设置」页签的 `h3` 依次为 `MCP 加载方式` / `工具检索` / `加载与列出` / `工具目录缓存` / `工具注解与安全`，加载方式在最前 |
| 名册说明段已删 | ✅ 面板 `innerText` 不含 `开关决定`（改前它在列表工具栏下方常驻一行） |
| 计数不再复述预设名 | ✅ 标题旁读数 `7 行 · 已启用 6`，面板文本不含 `筛选：`（改前是 `7 行 · 已启用 6 · 筛选：standard`） |
| 加载方式三档仍在页内 | ✅ 切换后「设置」页签文本里依次出现 `全部加载` / `动态插入` / `延迟加载`，并带当前档位的说明（`动态插入*` 选中态正确） |
| 盒子几何（11 档） | ✅ 320/360/390/430/600/601/760/761/1024/1280/1440：页标题、tabpanel、首行三者**左右边界差同时为 0**（1440 同为 `(532,1091)`，1024 同为 `(324,883)`）；`documentElement.scrollWidth === clientWidth` 全档成立 |
| 浅色 + 深色 | ✅ `colorScheme: dark` 下 `body` 背景 `rgb(21,21,23)`、面板文字 `rgb(249,250,251)`；两个页签各截一张 |
| 控制台 | ✅ 0 条 `error`/`warning`、0 条 `pageerror` |
| 静态约束 | ✅ `npm run typecheck` 通过；`npm test` **22 文件 / 259 项**通过（含 `tests/client-css.spec.ts`：删 `.listHint` 必须同步删引用，否则「有类没人引」变红） |

### 截图（`.scratch/mcp-ui-verify/`）

`40-servers-tab.png`（名册页签，无加载方式块与说明段）、`41-settings-tab.png`（设置页签，加载方式在最前）、
`44-servers-dark.png` / `45-settings-dark.png`（深色两页签）、`43-servers-<width>.png`（1440/760/601/390/320）。

### 本节未覆盖（如实）

1. **没点加载方式换档**：本轮只读，切档会重建工具面并改动隔离命名空间的 profile，未在本产物上复跑；接线本身未改（同一个 `McpLoadingPicker` 与 `pickMode`），但没有本轮实测读数。
2. **没跑真实点击录入、导入、行开关**：那些路径在第六节与名册布局轮已验，本轮不重复；`/mcp-ui-verify/verify.cjs` 仍是它们的全量脚本。
3. **软键盘、`pointer: coarse`、`prefers-reduced-motion`、真机安全区未测**：与第六节的缺口相同，本轮只覆盖 320–1440 的窗口宽度。
4. **`verify-tabs.cjs` 的 `mode` 字段只取按钮文本**，不是「点了会怎样」的证据；本文没有把它写成行为结论。

## 十、密钥页去掉三句说明（2026-10-16，client 产物 `7DCAD8FE…`）

用户看着密钥页的截图提了两件事：删掉「乱七八糟的描述」，以及问这些密钥是怎么被认出来的。本轮只做前者（后者是
解释，不做行为改动）：删除 `mcp.credential.envHint` / `mcp.credential.headerHint`（`环境变量`/`请求头` 标签下那句）
与 `mcp.credential.hint`（面板底部那句），**保留** `mcp.credential.empty`（空态一句）、`unreadable` 与 `busy`
两个状态句 —— 它们说的是状态，不是对控件的复述。

### 环境与产物绑定

| 项 | 值 |
|---|---|
| 宿主 / `DSH_HOME` / 端口 | 与第九节同一台：`@deepseek-ai/dsh@0.2.0-rc.2`；`.scratch/harness-tests/mcp-ui-0.2.0-rc.2-20261016-113243`；53145（跑完 `port released: True`） |
| 浏览器 | Playwright 1.61.1（`chromium_headless_shell-1228`），`ignoreDefaultArgs: ['--hide-scrollbars']` |
| 本轮 client 产物 | `lib/client.js` = `7DCAD8FEC1DAA64BC0D8A998F2A6AC81E161ED3785451886171A6D4556EE0FC9` |
| host 产物 | `lib/index.mjs` = `444E9B1E…`（未改 host） |
| 脚本与读数 | `.scratch/mcp-ui-verify/verify-credentials.cjs` + `verify-credentials.ps1`，结果 `report-credentials.json` |

### 逐项读数

| 验收项 | 结果 |
|---|---|
| 空态（新增弹窗 → 密钥） | ✅ 面板文本只剩 `环境变量 这行配置里还没有密钥。`；截图 `50-credentials-empty.png` |
| 有值时（JSON 框里手写两个 `env` 值，未保存） | ✅ 面板文本为 `环境变量 LIGHTRAG_BASE_URL LIGHTRAG_API_KEY`，字段逐个渲染，无任何说明句；截图 `51-credentials-declared.png` |
| 三句已消失 | ✅ `值只保存在本机配置里` / `连接时附加的 HTTP 请求头` / `改完直接点「保存」即可` 三者均不在面板文本里 |
| 控制台 | ✅ 0 条 `error`/`warning`、0 条 `pageerror` |
| 静态约束 | ✅ `npm run typecheck` 通过；`npm test` **22 文件 / 259 项**通过（删字典键不影响用例） |

### 本轮如实记下的两件事（**未改**，留给决策）

1. **`!!js` 表达式的值会以 `{"__jsExpr":"…"}` 原样显示**：`specFromEntryConfig`（`src/mcp-config.ts`）把 Loader
   条目里的 `env` 原样放进编辑器的 JSON 框，而密钥面板对非字符串值做 `JSON.stringify`（`src/client/credential-fields.ts`），
   所以 `env: { LIGHTRAG_API_KEY: !!js process.env.LIGHTRAG_API_KEY || "" }` 显示成
   `{"__jsExpr":"process.env.LIGHTRAG_API_KEY || \"\""}`（截图 `51-credentials-declared.png` 复现）。
2. **改动这种字段会把表达式写坏**：`credentialText` 把面板看到的那串文本原样写回，一旦用户在该输入框里改动并保存，
   `!!js` 表达式就变成一个普通字符串，服务器会拿到字面量。**只读不改动则安全**（`mergeCredentialEdits` 只写改动过的键）。
   面板目前不区分「字符串值」与「表达式值」，也没有只读提示 —— 这是已知缺口，本页只记录、未修。

### 本节未覆盖

- 没有在真实行上保存（避免改动隔离命名空间的 profile），所以「保存后表达式是否真的退化」是从代码推的，**不是实测**。
- 名册侧的「密钥 / 编辑」按钮判据未复跑：`storedCredentialKeys`（`src/mcp-config.ts`）**只数字符串值**的键，
  所以一个 `env` 值全是 `!!js` 表达式的行在名册上显示「编辑」而不是「密钥」，而打开编辑器后密钥页仍会列出这些键 —— 这个
  不一致本轮只做了源码阅读，未在浏览器里实测。

## 十一、行内按钮去掉、状态换位、页签占满整列（2026-10-16，D26，client 产物 `A8EAD3FE…`）

用户看着名册截图一次提了三条：去掉行内的「密钥 / 编辑」按钮；把状态与平面标记（预设名 / 全局标签）调换位置，
因为状态有时候没有、导致不对齐；「服务器 / 设置」两个页签占满整行。取舍与被否决方案见
[design-decisions.md](design-decisions.md) D26。

### 环境与产物绑定

| 项 | 值 |
|---|---|
| 宿主 / `DSH_HOME` / 端口 | `@deepseek-ai/dsh@0.2.0-rc.2`（npx 缓存 `_npx/7eff65a5cfe9d1d1`）；`.scratch/harness-tests/mcp-layout-0.2.0-rc.2-a7f3`（沿用名册布局轮那台）；44917（跑完端口已释放，只停本轮启动的进程） |
| 插件装载 | 该 profile 的 `node_modules/@guowenzhang/dsh-mcp-manager` 是指向本仓的符号链接，重建 `lib/client.js` 后重启实例即生效 |
| 浏览器 | Playwright（npx 缓存 `_npx/381cec31605a419a`）+ `chromium_headless_shell-1228`，无头 Chromium，1440×900 起测 |
| 本轮 client 产物 | `lib/client.js` = `A8EAD3FE4B67AC1A12D333817F65270873127CD5802A82D6F76B04C21D3D1E15`（195,773 字节）；同一张表在下一轮的产物 `97C389FC…` 上**复跑一次读数完全相同**（见第十二节），两轮的差别只在编辑器与导入弹窗，未碰名册 |
| host 产物 | `lib/index.mjs` = `444E9B1E5F6CD35E86055B743DB2FB6C962F8F7E9C851CF5136987FF3CF5ECE5`（未改 host，与第八/十节同一份） |
| 夹具 | 该 profile 原有的 `global-entries.yml`（`gv-headers` / `gv-plain` / `gv-stdio-env`）与预设 `mcp-verify`（`pv-env` / `pv-plain`），本轮**追加**一行 `gv-nourl`（HTTP 行不带 `url` → 「未配置」徽标），备份 `global-entries.yml.bak-d26`。追加原因：追加前 5 行**全都没有状态**，混排"有状态/无状态"才是这次要验的场景 |
| 脚本与读数 | `.scratch/mcp-layout-verify/verify-d26.mjs`，结果 `results-d26.json`，截图 `shots/d26-<宽>-<主题>.png` |

### 逐项读数（真实盒子测量，非 CSS 字符串断言）

| 验收项 | 结果 |
|---|---|
| 页签占满整行 | ✅ 1440px：`.tabs` 盒 532→1096（564px），与 `.section` 532→1096（564px）**逐位相同**，两个页签各 282px。其余档 `tabs == section`：760px 476=476、601px 317=317、360px 76=76（section 随宿主设置壳收窄，见下方缺口） |
| 行内没有「编辑 / 密钥」按钮 | ✅ 6 行的 `row.querySelectorAll('button')` 文本集合是 `["添加描述", ""]`——「添加描述」是描述就地编辑按钮，空文本那个是 `role="switch"` 的开关；浅色与深色一致 |
| 状态排在平面标记之前 | ✅ `gv-nourl` 的子元素顺序为 `[status「未配置」939→991, plane「全局」999→1037, switch 1045→1081]`；其余 5 行是 `[plane, switch]` |
| 有状态与无状态的行仍然对齐 | ✅ 1440px 六行：开关左缘**唯一值** `[1045]`、平面标记右缘**唯一值** `[1037]`（各 8px 间距）。`gv-nourl` 的「未配置」只占掉它左边的 52px，右侧两列不动——这正是换序要的结果（换序前状态夹在标记与动作组之间，它一出现就把标记与按钮推左 60px） |
| 深色同样成立 | ✅ `colorScheme: dark` 的 1440px 读数与浅色逐位相同（tabs 564、switchX `[1045]`、planeRight `[1037]`）；截图 `shots/d26-1440-dark.png` |
| 窄列仍可读 | ✅ 601/760px 触发既有的堆叠规则（容器 ≤480px：行改上下、`.mcpRight` 用 `space-between` 把元素推向两端），状态 / 平面标记 / 开关各在其位；截图 `shots/d26-601-light.png` |
| 控制台干净 | ✅ 五档（1440 浅 / 1440 深 / 760 / 601 / 360）`console.error` / `pageerror` / `requestfailed` 均为 **0** |
| 静态约束 | ✅ `npm run typecheck` 通过；`npm test` **22 文件 / 259 项**全绿（与改动前同数；`tests/client-css.spec.ts` 的"CSS 类必须被 TSX 引用"正是逼着删 `.mcpActions` 时同步删引用的那条）；`npm run test:metadata` 1 项通过 |
| host 侧 harness 回归 | ✅ `npm run test:harness`（`DSH_HARNESS_ROOT` 指向本机 `deepseekharness` checkout）**6 文件 / 25 项**全绿，与 D17 读数一致；重建后 `lib/index.mjs` / `lib/client.js` 两个哈希与上表逐位相同（构建幂等） |

### 本节未覆盖（如实）

- **真实点击未复跑**：本轮只做盒子测量与截图比对，没有点行卡片、开关或保存；那几条交互读数是名册布局轮的，属**旧产物**。
- **紧凑布局下平面标记仍会随状态移动**（601px 读数 `planeRight = [289, 421.5, 307.4]`，760px `[289, 501, 307.4]`）：`space-between` 把状态、标记、开关三个元素均匀推开，所以 `gv-nourl` 的标记比别的行靠右。这是容器查询里的既有设计（元素推到两端），本轮**只按要求换序，没有改紧凑布局**；要消除它得把状态与标记包进同一个子容器，属另一件事。
- **`npm run test:harness` 本轮复跑且通过**（6 文件 / 25 项），但它是**改动后**在同一份 host 产物（`444E9B1E…`，与第八/十节同一份，未变）上跑的：本次只碰浏览器半边，host 行为没有可回归的差异，harness 项数也与 D17 相同，不能据此宣称覆盖了 UI 行为。
- **`prefers-reduced-motion`、`pointer: coarse`、真机软键盘与安全区未测**：与前几节同样的缺口。
- **360px 下 section 只有 76px**：宿主设置壳在窄窗口仍保留左侧 188px 导航造成的既知缺口（第七节已记）；本轮未改宿主，"页签占满整行"只保证与 section 同宽。
- **第十节记的 `!!js` 表达式显示/回写缺口**未受本次改动影响，也未修复。

## 十二、写入落点两级下拉合成一个（2026-10-16，D27，client 产物 `97C389FC…`）

> **历史提示（2026-10-16 第五轮，D29）**：导入 Claude 配置的整条链路（含本节验过的「导入到」下拉）已按用户要求
> 删除，本节关于导入弹窗的读数只作为当轮记录保留；新增弹窗那部分在后续产物 `F92245F7…` 上复跑仍逐项成立（见
> 第十三/十五节）。

用户看着新增弹窗的截图问：这两个下拉（「配置范围」+「Agent 预设」）不能合并成一个吗 —— 全局肯定不是某个 agent，
agent 也肯定不是全局。本轮把新增弹窗与导入弹窗的这两级都合成一个「落点」下拉，两个弹窗共用
`src/client/McpTargetSelect.tsx`；取舍与被否决方案见 [design-decisions.md](design-decisions.md) D27。

### 环境与产物绑定

| 项 | 值 |
|---|---|
| 宿主 / `DSH_HOME` / 端口 | `@deepseek-ai/dsh@0.2.0-rc.2`；`.scratch/harness-tests/mcp-layout-0.2.0-rc.2-a7f3`（与第十一节同一台）；44917（跑完端口已释放，只停本轮启动的进程） |
| 插件装载 | 该 profile 的 `node_modules/@guowenzhang/dsh-mcp-manager` 是指向本仓的符号链接；**改完 `lib/client.js` 必须重启实例**（宿主按启动时的内容 revision 供包），本轮两组读数各自跑在重启后的实例上 |
| 浏览器 | Playwright + `chromium_headless_shell-1228`，无头 Chromium，1440×900，浅色 |
| 本轮 client 产物 | `lib/client.js` = `97C389FCB6B4FAD5DC0F46F5B07060E40567080FDA2DD311E0BD5E8806AC9A40`（193,367 字节）；同一批读数在第十三节的产物 `37F19C55…` 上**复跑逐项相同**（两轮差别只在编辑器表单与行的芯片/居中，未碰下拉合并） |
| host 产物 | `lib/index.mjs` = `444E9B1E5F6CD35E86055B743DB2FB6C962F8F7E9C851CF5136987FF3CF5ECE5`（未改 host） |
| 夹具 A | 第十一节的 6 行名册夹具（`mcp-verify` 预设 + 可写的全局 Include）→ **全局档可选** |
| 夹具 B | 在该 profile 的 `cordis.patch.yml` 末尾临时追加 `- id: mcp-verify-global-include` + `disabled: true`（备份后已还原）→ **全局档不可写**，正是用户日常组合的形状 |
| 脚本与读数 | `.scratch/mcp-layout-verify/verify-d27.mjs`（夹具 A）、`verify-d27b.mjs`（夹具 B），结果 `results-d27.json` / `results-d27b.json`，截图 `shots/d27-*.png` |

### 逐项读数

| 验收项 | 结果 |
|---|---|
| 新增弹窗只剩一个落点下拉 | ✅ 夹具 A：对话框内 `select` 数量 **1**，`aria-label = 配置范围`，页面文本里不再出现「Agent 预设」这个标签（旧实现是 2 个 select + 2 个标签） |
| 选项 = 全局 + 全部已声明预设 | ✅ `[全局(值 "")、预设 · standard、预设 · ptc、预设 · minimal、预设 · cordis、预设 · mcp-verify]`（与名册筛选下拉列出的已声明预设集合一致） |
| 一个控件承载两种落点 | ✅ 打开时选中 `mcp-verify`（名册筛到的那个预设）→ 选「全局」后 `select.value` 变 `""` → 再选回预设仍是 `mcp-verify`，全程只有这一个 select |
| 导入弹窗同样合并 | ✅ `select` 数量 **1**，`aria-label = 导入到`，选项集合与新增弹窗逐项相同；切到「全局」后 `value` 变 `""` |
| 全局不可写时不卡住保存 | ✅ 夹具 B：新增弹窗落点下拉的**初值直接是第一个预设 `standard`**，`全局` 档 `disabled=true`，控件下方给出原因「这个组合没有唯一的文件型 Include，全局平面没有可写入的文件。」，「保存」**可用**（`disabled=false`） |
| 导入弹窗的不可写全局 | ✅ 夹具 B：同样 1 个下拉、初值 `standard`、`全局` 灰掉、同一条原因句；「导入所选」的禁用来自"没有可导入的条目"（该 DSH_HOME 里 Claude 配置没有可导入项），**不是** `noTarget` |
| 控制台 | ✅ 两组读数都是 0 条 `error` / `pageerror` / `requestfailed` |
| 名册读数未受影响 | ✅ 第十一节那张表在 `97C389FC…` 上复跑：tabs 564=564、六行 `switchX=[1045]`、`planeRight=[1037]`、行内按钮只有「添加描述」与开关，读数与 `A8EAD3FE…` 逐位相同 |
| 静态约束 | ✅ `npm run typecheck` 通过；`npm test` **22 文件 / 259 项**全绿（`tests/client-css.spec.ts` 已把新组件纳入类名检查名单） |

### 本节未覆盖（如实）

- **没有真实保存/导入**：两组读数都只到"表单状态正确、按钮可用"为止，没有点「保存」写回 composition 文件，也没有跑一次真实导入（写入路径的回归当时只有单测 `tests/mcp-authoring.spec.ts` / `tests/claude-import.spec.ts`；**后者与导入功能本身已于第十四节删除**）。
- **没有测「已不在名册里的预设 id」兜底项**：那段逻辑（`unlisted`）只做了类型与代码层保证，浏览器里没有构造出这种值。
- **`npm run test:harness` 未在 `97C389FC…` 上复跑**：本轮改动只在浏览器半边（两个弹窗 + 字典），host 产物哈希未变；harness 读数仍以第十一节的 6 文件 / 25 项为准。
- **`prefers-reduced-motion`、`pointer: coarse`、真机软键盘与安全区未测**：与前几节同样的缺口。
- **README 里的截图（`docs/images/mcp-editor-import.png` 等）未重拍**：图上是旧的两级下拉与行内按钮，本轮只改了正文文字。

## 十三、必填标记与自动命名、平面标记改芯片并居中（2026-10-16，D28，client 产物 `37F19C55…`）

用户提了两条：新增弹窗的必填字段要打 `*`、"能给默认值或者自动设置就设置"；名册里「未配置 / standard / 开关」
这一组要**上下居中**，并且 agent 范围的样式"类似 tab"。取舍与被否决方案见 [design-decisions.md](design-decisions.md) D28。

### 环境与产物绑定

| 项 | 值 |
|---|---|
| 宿主 / `DSH_HOME` / 端口 | `@deepseek-ai/dsh@0.2.0-rc.2`；`.scratch/harness-tests/mcp-layout-0.2.0-rc.2-a7f3`（第十一/十二节同一台）；44917（跑完端口已释放，只停本轮启动的进程） |
| 浏览器 | Playwright + `chromium_headless_shell-1228`，无头 Chromium，1440×900，浅色 |
| 本轮 client 产物 | `lib/client.js` = `37F19C55534DAF5A50F3338D339B4B87B4F7690B90FA0D4099CBDD840EE030C2`（197,973 字节） |
| host 产物 | `lib/index.mjs` = `444E9B1E…`（未改 host） |
| 夹具 | 第十一节那 6 行（3 全局 + 1 未配置 + 2 预设行），全局 Include 可写 |
| 脚本与读数 | `.scratch/mcp-layout-verify/verify-d28.mjs`，结果 `results-d28.json`，截图 `shots/d28-rows.png`、`shots/d28-add-required.png` |

### 逐项读数（真实盒子测量）

| 验收项 | 结果 |
|---|---|
| 行右侧那组上下居中 | ✅ 六行的 `rowCenterY` 与 `.mcpRight` 盒子中心**逐行相等**：351=351、431=431、511=511、591=591、671=671、751=751 |
| 平面标记是 tab 样式芯片 | ✅ 六行的芯片 `border-radius: 12px`（= `--dsw-radius-md`，与宿主页签选中态同款），`全局` 与 `mcp-verify` 用同一个类；芯片盒高 24px |
| 芯片与开关仍成一列 | ✅ 六行 `switchX=[1045]`、芯片右缘 `[1037]`（唯一值），与第十一节同列 |
| 必填标记 | ✅ 表单字段名依次为 `["配置范围","服务器名*","描述（写进系统提示，帮模型选要加载哪台）","JSON 配置*"]`；两个 `*` 的颜色 `rgb(236,19,19)`；`aria-required`：服务器名 `true`、JSON `true` |
| 名称自动填 | ✅ 空表单 → 粘贴 `{"type":"stdio","command":"npx","args":["-y","@upstash/context7-mcp"]}` 后输入框自动变成 **`context7`** |
| 手填的名字不被覆盖 | ✅ 把名字改成 `my-own-name` 后再粘贴另一份 JSON（`server-filesystem`），输入框仍是 `my-own-name`；清空后也不再自动填（用户碰过这个字段就不再自动写） |
| 控制台 | ✅ 0 条 `error` / `pageerror` / `requestfailed` |
| 前两节读数复跑 | ✅ 第十一节（页签全宽、对齐、无行内按钮）与第十二节（两个弹窗各一个落点下拉）在同一产物上复跑：1440px `tabs=564=section`、`switchX=[1045]`、芯片右缘 `[1037]`、`selectCount=1`、选项集合逐项相同 |
| 静态约束 | ✅ `npm run typecheck` 通过；`npm test` **23 文件 / 264 项**全绿（新增 `tests/mcp-spec.spec.ts` 5 项） |

### 本节未覆盖（如实）

- **没有真实保存**：自动填出来的名字与必填标记只验到"表单状态正确"，没有点「保存」把这一行写进 composition。
- **URL 主机推断只在单测里覆盖**：浏览器里只粘贴了 stdio 的 JSON；`https://mcp.yunxiao.com/mcp` → `yunxiao` 这条是 `tests/mcp-spec.spec.ts` 的读数，不是浏览器读数。
- **真实粘贴（`Ctrl+V`）未测**：脚本用 Playwright 的 `fill` 设值并触发 `input`，走的是同一条 `onChange`，但没有覆盖 IME、拖拽或从剪贴板粘贴的多事件序列。
- **深色只看了第十一节那批截图的同款布局**，本轮 D28 的截图只拍了浅色；芯片用的都是语义 token，未逐像素比对深色。
- **`pointer: coarse` / 真机软键盘 / `prefers-reduced-motion` 未测**：与前几节同样的缺口。
- **`npm run test:harness` 未在本轮复跑**（改的是浏览器半边与纯函数推断，host 产物哈希未变）；harness 读数仍以第十一节的 6 文件 / 25 项为准。
- **README 截图（`docs/images/mcp-editor-import.png`）未重拍**：图上仍是旧的两级下拉、行内按钮与灰字预设名。

## 十四、删除「导入 Claude 配置」整条链路（2026-10-16，D29，client `F92245F7…` / host `2771BA61…`）

用户原话：「删除导入Claude配置的功能」。删掉的文件与符号见 [design-decisions.md](design-decisions.md) D29。
本节记录**验证**：删干净了、没留死引用、名册工具栏不再有入口。

### 环境与产物绑定

| 项 | 值 |
|---|---|
| 宿主 / `DSH_HOME` / 端口 | `@deepseek-ai/dsh@0.2.0-rc.2`；`.scratch/harness-tests/mcp-layout-0.2.0-rc.2-a7f3`（第十一/十二/十三节同一台）；44917（跑完端口已释放） |
| 本轮产物 | `lib/client.js` = `F92245F7…`（175,154 字节，删导入后变小）；`lib/index.mjs` = `2771BA61…`（196,091 字节，host 侧删了扫描与批次写入） |
| 浏览器 | Playwright + `chromium_headless_shell-1228`，1440×900，浅色 |
| 脚本与读数 | `.scratch/mcp-layout-verify/verify-d29.mjs`，结果 `results-d29.json` |

### 逐项读数

| 验收项 | 结果 |
|---|---|
| 名册工具栏不再有导入入口 | ✅ 工具栏按钮集合 = `["新增 MCP"]`（旧实现是「导入 Claude 配置」+「新增 MCP」） |
| 死引用为零 | ✅ `npm run typecheck` 通过（tsc 会报未用的导入、缺失的导出与类型）；`npm test` 无 TSX/字典残缺；`tests/client-css.spec.ts` 的"类必须被引用"因此挡住了留 `.mcpActionError` 这类孤儿样式的写法（删导入时正好命中） |
| host 侧 RPC 已撤 | ✅ `src/remote.ts` 的 descriptor 列表不再有 `addMcps` / `scanClaudeMcp`；`mcp-remote.ts` 不再有对应方法（§见以下"未覆盖"：没有在隔离实例上验证客户端调用旧方法会拿到 404） |
| 字典无残留 | ✅ `mcp.import.*` 的中英各 33 条全部删除；`McpSectionKey` 由 `zh` 推导，`en` 是 `Record<McpSectionKey, string>`，所以少一条都会编译失败 |
| 测试数变化符合预期 | ✅ `npm test` **22 文件 / 253 项**（删除前 23 / 264；`tests/claude-import.spec.ts` 的 11 项随文件一起删） |

### 本节未覆盖（如实）

- **没有在浏览器里点过已删除的入口**：按钮不存在是读 DOM 得到的（按钮集合断言），不是"点了没反应"的读数。
- **旧客户端调用已撤 RPC 的失败形态未测**：`addMcps` / `scanClaudeMcp` 的 descriptor 已从贡献里移除，理论上调用方会拿到"未注册的方法"；本轮没有构造旧 bundle 去触发它。
- **`docs/images/mcp-editor-import.png` 未处理**：那张图右半是已删除的导入弹窗；README 里的引用已撤，图片文件本身仍留在 `docs/images/`（其余几张截图也早于本轮的多处 UI 改动，一并待重拍）。

## 十五、工具列表 token、加载态居中、设置页整理（2026-10-16，D30，client `F92245F7…`）

用户提了三条：工具列表的说明改成"取消勾选则不加载进入上下文，当前加载 xx token，取消 xx token"、每行后面显示
token 量；「连接中……」应该是个 loading、放到中间、不要把描述挤下来；删掉「立即生效…」与策略区总述两句描述，
加载方式的 tab 占满整行。取舍见 [design-decisions.md](design-decisions.md) D30。

### 环境与产物绑定

| 项 | 值 |
|---|---|
| 宿主 / `DSH_HOME` / 端口 | 同第十四节（同一台隔离实例、同一端口） |
| 本体产物 | `lib/client.js` = `F92245F7…`、`lib/index.mjs` = `2771BA61…`（同第十四节，两轮改动同一份产物） |
| 夹具 | 该 profile 的预设 `mcp-verify` 下**新增两行**：`pv-tools`（`node <script>`，跑一个用本仓 `@modelcontextprotocol/sdk` 写的三工具 fixture 服务器）、`pv-slow`（同一 SDK，`tools/list` 延迟 60s）；脚本 `.scratch/mcp-layout-verify/fixture-mcp-server.mjs` / `fixture-mcp-slow.mjs`，patch 备份 `cordis.patch.yml.bak-d29`。**保留在该隔离命名空间里**，重跑直接可用 |
| 浏览器 | Playwright + `chromium_headless_shell-1228`，1440×900，浅色 |
| 脚本与读数 | `.scratch/mcp-layout-verify/verify-d29.mjs`，结果 `results-d29.json`，截图 `shots/d29-*.png` |

### 逐项读数（真实盒子 + 真实 MCP 列举）

| 验收项 | 结果 |
|---|---|
| 每行显示 token | ✅ 真实列举（`pv-tools`，fixture 服务器）：`ping` `≈26`、`echo` `≈46`、`big_tool` `≈778`（长 schema + 中文描述）；计数 `3/3` |
| 提示句就是两份合计 | ✅ `取消勾选则不加载进上下文：当前加载 ≈850 token，取消 ≈0 token。`——26+46+778 = **850**，与逐行数字自洽 |
| 取消勾选后两个数反号 | ✅ 取消 `big_tool` 后计数 `2/3`，提示句变 `当前加载 ≈72 token，取消 ≈778 token。`（26+46=72） |
| 加载态居中 | ✅ `pv-slow`（60s 才答复）上：`role="status"` 的盒子中心与面板中心**差 0px**；文字 `连接中……`；转圈元素 `animation-name = mcp-tool-spin` |
| 描述不被挤动 | ✅ 提示句的 `getBoundingClientRect().y` 在点击「加载工具列表」前后**都是 373**（等待期间新增的是下方居中的那一块，上方文字不动） |
| 按钮不再换字 | ✅ 忙碌时「加载工具列表」仍是该文案（只是 disabled），`mcp.form.toolsLoading` 只出现在居中的状态块里 |
| 设置页两句已删 | ✅ `innerText` 里 `立即生效` = **false**、`控制一次调用把多少工具内容交给模型` = **false** |
| 加载方式占满整行 | ✅ `[role="tablist"]`（全部加载 / 动态插入 / 延迟加载）盒子 532→1096 = **564px**，与其所在块、与设置列**逐位相同** |
| 控制台 | ✅ 0 条 `error` / `pageerror` / `requestfailed` |
| 静态约束 | ✅ `npm run typecheck` 通过；`npm test` **23 文件 / 258 项**（新增 `tests/mcp-tokens.spec.ts` 5 项） |
| 第十三节读数复跑 | ✅ 在**同一产物** `F92245F7…` 上复跑 `verify-d28.mjs`：八行（本轮夹具多了 `pv-tools`/`pv-slow`）的 `rowCenterY == rightCenterY == chipCenterY`、芯片 R12、`switchX=[1045]`、芯片右缘 `[1037]`、必填 `*` 与 `aria-required`、粘贴后自动填 `context7`、手填名不被覆盖——与第十三节逐项相同。第十一/十二节的读数取自较早产物（改动只碰工具列表与设置页，未动名册与新增弹窗结构），**未在最终产物上复跑** |

### 本节未覆盖（如实）

- **深色未拍**：本轮截图只有浅色；新增的 `.toolTokens` / `.toolsLoading` / `.spinner` 都用语义 token，未逐像素比对深色。
- **`prefers-reduced-motion: reduce` 只做了代码层保证**：`@media (prefers-reduced-motion: reduce)` 关掉转圈动画，没有在浏览器里录到差值（媒体查询本身在前几节也没实测）。
- **没有跨多行验证数字**：只在一个三工具服务器上验了合计；分页（`pageSize`/`maxTools` 截断）时"当前加载"只算**这一页列出的**工具，未构造真实的多页读数。
- **token 数是估算**：本节只证明"逐行数字与提示句自洽、取消后反向"，**不证明**它与任何 provider 的实际计费一致（`src/mcp-tokens.ts` 的注释与 D30 都写明这一点）。
- **`pointer: coarse` / 真机软键盘 / 安全区未测**：同前几节。

## 十六、JSON 校验移到字段标签行、失焦才判（2026-10-16，D31，client `116D3AA7…`）

用户看着新增弹窗的两张截图（配置页与工具列表页各一张，红框画在 `JSON 配置 *` 标签右侧）要求：这个校验显示在配置
JSON 旁边，鼠标失焦时才显示。取舍见 [design-decisions.md](design-decisions.md) D31。

### 环境与产物绑定

| 项 | 值 |
|---|---|
| 宿主 / `DSH_HOME` / 端口 | 同第十四/十五节那台隔离实例；44917（跑完端口已释放） |
| 本轮 client 产物 | `lib/client.js` = `116D3AA7…`（177,222 字节） |
| 浏览器 | Playwright + `chromium_headless_shell-1228`，1440×900，浅色 |
| 脚本与读数 | `.scratch/mcp-layout-verify/verify-d31.mjs`，结果 `results-d31.json`，截图 `shots/d31-*.png` |

### 逐项读数（真实盒子测量）

| 验收项 | 结果 |
|---|---|
| 初始状态不报 | ✅ 打开弹窗（骨架 JSON 合法）：`[role="alert"]` 数量 0，`aria-invalid=false` |
| 输入时不报 | ✅ 把框填成 `{ "type": "stdio", "command": `（半截文档）后**焦点仍在框内**：alert 数量仍是 0 |
| 失焦即报 | ✅ 点服务器名输入框后：alert 文本 `JSON 格式或字段不合法`，`aria-invalid=true` |
| 就在标签行上 | ✅ 该 alert 与 `JSON 配置 *` 标签的**垂直中心差 0px**（`labelDelta = 0`），在文本框**上方** 7px |
| 没有被弹窗裁掉 | ✅ `visible = true`（第一版把消息放在文本框下方时被弹窗内容区下边缘裁掉，截图 `d31-json-error-from-tools.png` 可复现旧写法的问题） |
| 改对后消失 | ✅ 换成合法 spec 并失焦：alert 数量 0、`aria-invalid=false` |
| 从工具列表页触发也落到这里 | ✅ 在半截文档状态下切到「工具列表」并点「加载工具列表」：页签**切回 `["配置"]`**，消息出现在标签行上（旧行为是在工具列表页显示一条连接错误 `toolsError`） |
| 控制台 | ✅ 0 条 `error` / `pageerror` / `requestfailed` |
| 静态约束 | ✅ `npm run typecheck` 通过；`npm test` **23 文件 / 258 项**全绿（DSL：`tests/client-css.spec.ts` 的"类必须被引用"覆盖新增的 `.fieldError`） |

### 本节未覆盖（如实）

- **只有中文文案的读数**：英文 `mcp.form.jsonInvalid` 未在浏览器里切换语言验证（字典两语言同步改的是同一个键）。
- **`role="alert"` 的读屏播报未实测**：只验证了节点与属性存在。
- **深色未拍**：新增的 `.fieldError` 用 `--dsw-alias-state-error-primary`，未逐像素比对深色。
- **`${env:…}` 这类只有 Host 能判的引用**不在这个字段的判定范围内（D15/D31），本节的输入也没有覆盖到它。

## 十七、工具列表页去掉加载按钮（2026-10-16，D32，client `4FEC5E73…`）

用户看着加载中的工具列表页提的：那个按钮也去掉，其他按钮都隐藏会让下面的说明句掉一行。取舍见
[design-decisions.md](design-decisions.md) D32。

### 环境与产物绑定

| 项 | 值 |
|---|---|
| 宿主 / `DSH_HOME` / 端口 | 同第十四至十六节那台隔离实例；44917（跑完端口已释放） |
| 本轮 client 产物 | `lib/client.js` = `4FEC5E73…` |
| 夹具 | 该 profile 的预设 `mcp-verify` 下的 `pv-tools`（本仓 `@modelcontextprotocol/sdk` 写的三工具服务器）与 `pv-slow`（`tools/list` 延迟 60s），脚本在 `.scratch/mcp-layout-verify/fixture-mcp-*.mjs` |
| 浏览器 | Playwright + `chromium_headless_shell-1228`，1440×900，浅色 |
| 脚本与读数 | `.scratch/mcp-layout-verify/verify-d32.mjs`，结果 `results-d32.json`，截图 `shots/d32-*.png` |

### 逐项读数（真实盒子 + 真实列举）

| 验收项 | 结果 |
|---|---|
| 没有加载按钮 | ✅ 弹窗按钮集合 = `["配置","密钥","工具列表","取消","保存"]`；工具页签里只剩「全选 / 全不选」（有列表时） |
| 进页签即列举（编辑） | ✅ 点 `pv-tools` 卡片 → 点「工具列表」→ 250ms 后已在 `connecting`（`role="status"` 存在、计数为空），随后 `3/3` / 3 行 |
| 提示行不跳 | ✅ 四种状态（首次列举中 / 列举完成 / 表单改过后重列 / 新增弹窗列举完成）提示行都在 **y=373**；`.toolsHead` 高度恒为 **28px** |
| 表单变了才重列 | ✅ 改 JSON 指向慢服务器后再进页签：立刻进 `connecting`（`busy=true`），且因为已有上次列表，「全选/全不选」仍在 |
| 新增弹窗也能列举 | ✅ 「新增 MCP」里填好名字与 JSON → 点「工具列表」→ `3/3`、3 行（旧实现只在编辑模式自动列举） |
| 控制台 | ✅ 0 条 `error` / `pageerror` / `requestfailed` |
| 静态约束 | ✅ `npm run typecheck` 通过；`npm test` **23 文件 / 258 项**全绿（删字典键由 `en: Record<McpSectionKey, string>` 守住） |

### 本节未覆盖（如实）

- **没有验证"同一表单再进页签不重连"**：读数覆盖了"变了要重列"，但没有反向断言未变时不重列（需要统计子进程或 RPC 次数）。
- **慢夹具只用于触发 connecting**：60s 的那次列举在脚本里没有等它结束（页面后续被关闭）。
- **深色、`pointer: coarse`、`prefers-reduced-motion` 未测**：同前几节。
- **`mcp.form.toolsNeedsName` 的新文案只在中文界面读过**：英文文案未在浏览器里切换验证。

## 十八、全局平面自动创建（2026-10-27，D33，产物 `F6365849…` / `02FBA051…`）

用户反馈「刚安装完选不了全局、也看不到全局 MCP」。取舍见 [design-decisions.md](design-decisions.md) D33。

### 环境与产物绑定

| 项 | 值 |
|---|---|
| 日期 | 2026-10-27 |
| 插件 | @guowenzhang/dsh-mcp-manager@1.5.0（HEAD 05234cd，工作树有本轮未提交改动） |
| 宿主 | `@deepseek-ai/dsh@0.2.1-rc.2`（隔离实例；取得当天 `npm view dist-tags` 的 `latest`，用 `--version` 固定） |
| DSH_HOME / 端口 | `…\harness-tests\mcp-global-e2e-0.2.1-rc.2-m6z9lt` / 56271（主流程）；`…\mcp-global-enable-0.2.1-rc.2-h4szpe` / 24681（弹窗路径）；两个实例跑完都已停止、端口已释放 |
| Node / 浏览器 | Node v24.12.0；Playwright + `chromium_headless_shell-1228`（显式 `executablePath`，未下载新浏览器） |
| lib/index.mjs | `f6365849…47d`（207,615 字节，2026-10-27 17:21:51） |
| lib/client.js | `02fba051…8a2`（187,167 字节，2026-10-27 17:21:51） |
| 脚本与截图 | `.scratch/mcp-global-enable/e2e.mjs`、`e2e-dialog.mjs`；截图 `01-fresh-profile.png` … `10-dialog-row-added.png` |

### 车道结果（本轮实跑）

| 车道 | 命令 | 结果 |
|---|---|---|
| typecheck | `npm run typecheck` | 通过 |
| build | `npm run build` | 通过（host 207.62 kB；client handoff 写出） |
| unit | `npm test` | **24 文件 / 268 项**全绿（新增 `tests/mcp-global-include.spec.ts` 10 项） |
| harness | `DSH_HARNESS_ROOT=…\deepseekharness npm run test:harness` | **6 文件 / 25 项**全绿（新增两条断言：shape A 再启用是 no-op；无 `profileContext` 时以 `mcp/unavailable` 拒绝） |
| 门禁 | `node tools/testing/gate.mjs` | dsh-mcp-manager 无 error / warning；全仓 3 个 error 都在其他仓，与本轮无关 |

### 逐项读数（真实点击）

| 验收项 | 读数 |
|---|---|
| 全新 profile 的说明 | 名册上方显示「当前组合里没有你自己的可写 Include…」，并有「启用全局（自动创建）」按钮 |
| 创建前磁盘 | profile 目录没有 `mcp.cordis.yml` |
| 弹窗里的「全局」 | `<option value="">` 没有 `disabled` 属性：可选中，选中即触发创建 |
| 一键创建 | 3s 内出现「已启用全局平面」提示、说明块消失；同一会话内 Include 已挂载（无需重启） |
| 写入内容 | `mcp.cordis.yml` = `[]`；`cordis.patch.yml` 末尾追加 `- insert:\n    - id: mcp-manager-global\n      name: cordis:include\n      config:\n        path: ./mcp.cordis.yml\n        initial: []`，原有 `ui-settings-general` 行原样保留 |
| 新增全局行 | 「配置范围」= 全局，保存后列表出现 `probe-global` 并带「全局」芯片；`mcp.cordis.yml` 出现该行（`transport: streamable-http`） |
| 行内开关往返 | 关：文件出现 `disabled: true`；开：该键被移除；两次都只改这一个文件 |
| 弹窗路径 | 第二个全新 profile 里，把新增弹窗的「配置范围」切到「全局」→ 自动创建（8 项断言全过），随后保存 `probe-dialog` 直接进 `mcp.cordis.yml` |
| 布局 | 1280×900 与 390×844、浅色与深色：`document.scrollWidth - clientWidth = 0`；深色背景 `rgb(21, 21, 23)` |
| 控制台 | 两轮均 0 条 `error` / `pageerror` |

### 环境备注（工具链，未改脚本）

- `tools/testing/isolate.mjs start` 在本机没取到认证 URL：web 进程确实起来了（401 可探），但 `dsh web: http://…/?token=…` 没有落进 `boot.out`，`status` 的 `url` 为 null。本轮做法是：先用 isolate 建命名空间并安装插件（保留实例记录），停掉它启动的进程，再用同一个 `DSH_HOME` 以受管后台任务启动，从任务输出取 URL；结束时按端口与命令行核对后停止。
- `isolate.mjs --plugin` 按调用时的工作目录解析相对路径：在工作区里写 `../dsh-mcp-manager` 会指到 `C:\02-codespace\dsh-mcp-manager`（不存在，Node 报 `spawn cmd.exe ENOENT`）；传绝对路径即正常。

### 本节未覆盖（如实）

- 预设平面的新增 / 删除 / 导入行与编辑弹窗逐行保存状态仍未在浏览器里实测。
- 未验证两个「启用全局」请求并发（Remote 已走 mutation 队列，但没有专门断言）。
- 没在「宿主没有 `profileContext`」的真实部署里点过这个按钮（harness 里断言了拒绝，但那是合成组合）。
- 未验证启用后用户把 `cordis.patch.yml` 手工改坏时 UI 的具体提示：代码走「写入成功但未挂载 → 提示重启」分支，仅由阅读确认。
- 只在 0.2.1-rc.2 上实测；alpha 线与更老宿主未复跑。
- 未验证 URL 之外的认证路径（token 只在 URL 里）。

## 十九、空态只留一句「还没有」（2026-10-27，D34，client `283A797D…` / host 不变）

用户要求去掉名册空态里那句解释与「新增到 Agent 预设」按钮。取舍见 [design-decisions.md](design-decisions.md) D34。

### 环境与产物绑定

| 项 | 值 |
|---|---|
| 日期 | 2026-10-27 |
| 插件 | @guowenzhang/dsh-mcp-manager@1.5.0（HEAD 05234cd，工作树有本轮未提交改动） |
| 宿主 | `@deepseek-ai/dsh@0.2.1-rc.2`（隔离实例，全新 profile） |
| DSH_HOME / 端口 | `…\harness-tests\mcp-empty-state-0.2.1-rc.2-e7lqmd` / 25578（跑完已停止，端口已释放） |
| Node / 浏览器 | v24.12.0；Playwright + `chromium_headless_shell-1228`，1280×900 与 390×844 |
| lib/index.mjs | `f6365849…47d`（207,615 字节；本轮未改 host） |
| lib/client.js | `283a797d…884`（186,144 字节） |
| 脚本与截图 | `.scratch/mcp-global-enable/e2e-empty.mjs`；`11-empty-state-1280.png`、`12-no-match-1280.png`、`13-empty-state-390-light.png`、`14-empty-state-1280-dark.png` |

### 逐项读数（真实点击，10 项断言全过）

| 验收项 | 读数 |
|---|---|
| 空态文本 | `emptyBlock` 的 textContent 只有「这个筛选下还没有 MCP 服务器」 |
| 解释句 | 页面不再包含「当前筛选显示」「全局行已在上面列出」 |
| 空态按钮 | 没有「新增到 Agent 预设」；列表右上的「新增 MCP」仍在（1 个） |
| 全局平面说明与动作 | 「启用全局（自动创建）」仍在（本次未动） |
| 搜索无命中分支 | 无命中搜索仍显示「换个关键词，或清空筛选框。」 |
| 布局 | 390px 无横向溢出（`scrollWidth - clientWidth = 0`）；深色主题正常 |
| 控制台 | 0 条 `error` / `pageerror` |
| 静态 | `npm run typecheck` 通过；`npm test` 24 文件 / 268 项全绿 |

### 本节未覆盖

- 只测了全新 profile（0 行）的空态；预设非 `standard`、或全局平面已启用的组合未另测（空态渲染条件与全局平面无关）。
- 英文界面未在浏览器里切换验证（键集合由 `en: Record<McpSectionKey, string>` 守住）。
- 空态块的高度变化没有做像素级测量，只做了截图与文本断言。

## 二十、首次读取自动创建全局 Include（2026-10-27，D33 修订，产物 `2A4A2AF8…` / `9BB47956…`）

用户：「这个还要我手动启用，不能插件自己自动启用一次吗」。D33 据此把创建时机改为**每个宿主进程第一次读取名册时自动创建一次**，不再需要点按钮。

### 环境与产物绑定

| 项 | 值 |
|---|---|
| 日期 | 2026-10-27 |
| 插件 | @guowenzhang/dsh-mcp-manager@1.5.0（HEAD 05234cd，工作树有本轮未提交改动） |
| 宿主 | `@deepseek-ai/dsh@0.2.1-rc.2`（隔离实例，全新 profile） |
| DSH_HOME / 端口 | `…\harness-tests\mcp-auto-global-0.2.1-rc.2-r8qbw2` / 30085（跑完已停止，端口已释放） |
| Node / 浏览器 | v24.12.0；Playwright + `chromium_headless_shell-1228`，1280×900 |
| lib/index.mjs | `2a4a2af8…d1ad`（209,423 字节，2026-10-27 18:02:41） |
| lib/client.js | `9bb47956…5bfb`（186,194 字节，2026-10-27 18:02:41） |
| 脚本与截图 | `.scratch/mcp-global-enable/e2e-auto.mjs`；`15-auto-enabled-1280.png`、`16-auto-global-row.png` |

### 逐项读数（真实点击 + 文件读数，11 项断言全过）

| 验收项 | 读数 |
|---|---|
| 打开页面前 | profile 目录没有 `mcp.cordis.yml` |
| 首次读取 | 打开「MCP 管理」后（未点任何按钮）文件已出现，patch 里 `mcp-manager-global` 恰好 1 处 |
| 界面 | 不再显示「启用全局（自动创建）」按钮与只读说明 |
| 落点 | 新增弹窗里「全局」可直接选中（不再需要先启用） |
| 新增行 | 直接保存 `auto-global` → 列表出现并带「全局」芯片，写入 `mcp.cordis.yml` |
| 刷新幂等 | 整页 reload、重开设置后：patch 仍只有 1 行、Include 里的行仍在、列表仍显示该行 |
| 控制台 | 0 条 `error` / `pageerror` |
| 静态 | `npm run typecheck` 通过；`npm test` **24 文件 / 268 项**；`npm run test:harness` **7 文件 / 27 项**（新增 `tests/global-auto-enable.harness.spec.ts` 2 项：首次读创建一次、无 `profileContext` 时读仍返回只读原因） |

### 本节未覆盖（如实）

- 自动创建**失败**后的降级（名册仍返回 `no-writable-include`、按钮可重试）只在 harness 的「无 profileContext」用例与代码路径上验证，没有在真实实例里故意写坏 patch 文件复现。
- 只在 0.2.1-rc.2 上实测；更老宿主没有 `enableGlobalPlane`，自动创建不会发生（页面回退到按钮，但按钮会报方法不存在——跨版本混装的预期状态，未专门测）。
- 空态精简（第十九节）的读数绑定当时 client `283A797D…`；当前 client `9BB47956…` 只多改了回退提示文案 `mcp.global.autoHint`，空态断言未在当前构建重跑。

## 维护

改加载、池或闸门行为后：先跑 `npm test` 与 `npm run test:harness`，再按上面的隔离实例协议复跑，并把**新结果与
日期**写回本页；失败、未覆盖与受阻项如实保留，不要用「应该没问题」替代观察。
## 二十一、本地 MCP 工具目录持久化与新增连接探测（2026-10-28，产物 `6C9E5236` / `0C4414B5`）

### 环境与产物绑定

| 项 | 值 |
|---|---|
| 日期 | 2026-10-28T10:18:29+08:00 |
| 插件 | @guowenzhang/dsh-mcp-manager@1.5.0（HEAD 05234cd，工作树 36 项未提交） |
| 宿主 | @deepseek-ai/dsh@0.2.1-rc.2（隔离实例） |
| DSH_HOME | `C:\02-codespace\DeepSeek\.scratch\harness-tests\mcp-local-cache-0.2.1-rc.2-av8lh9` |
| 端口 / URL | 58857 / `http://127.0.0.1:58857/`（无认证 URL，实际访问 401；实例已停止） |
| Node | v24.12.0 |
| lib/index.mjs | `6c9e52361d6aefb6b8f8a069874c2671f8eba180525ca9d4b0cda5f77da4fe63`（222692 字节，2026-10-28T02:17:44.428Z） |
| lib/client.js | `0c4414b5157d992cf06b17830fda59faeba552553b06efc746636435dfc476df`（190875 字节，2026-10-28T02:17:44.536Z） |
| 证据文件 | `.scratch/test-system/runs/2026-10-28-101749-dsh-mcp-manager.json` |

### 车道结果

| 车道 | 状态 | 退出码 | 耗时 |
|---|---|---|---|
| typecheck | passed | 0 | 1.5s |
| harness（包含 build） | passed | 0 | 4.1s |
| unit | passed | 0 | 2.1s |
| metadata | passed | 0 | 0.5s |
| static gate | passed（0 error / 0 warning） | 0 | — |

补充证据：`.scratch/test-system/runs/2026-10-28-101743-dsh-mcp-manager.json`（类型）、`2026-10-28-101747-dsh-mcp-manager.json`（构建与组合）、`2026-10-28-101528-dsh-mcp-manager.json`（元数据）、`.scratch/test-system/gate.json`（门禁）。元数据检查后仅源码改动与重建，包元数据未再改。

### 逐项读数

- 单元/组件回归 **27 文件 / 310 项**，真实 Loader/registry/scope 组合回归 **7 文件 / 27 项**。新增持久化测试 21 项、产物 Remote 探测测试 6 项、jsdom 新建探测组件测试 13 项；mcp-load 增补 2 项。
- 本地 stdio 探测 RPC 返回前磁盘已存在完整目录；保存声明清行内存后、新建 catalog restore 能取回 schema，保留原 fetchedAt。HTTP/SSE/Streamable HTTP（包含 localhost URL）探测只读回内存，测试路径不存在目录文件。
- TTL=0、服务器短 TTL、过期、命令/参数/cwd/env/namespace/transport 改变 miss；读取损坏/坏版本/未来时间/坏类型工具字段不会进入检索。坏 JSON 未被探测写回覆盖。原配置与凭据不进入持久化文本，工具定义仅投影公开字段。
- 独立 writer 合并保留双方目录；另一 writer 清空后旧代写入拒绝。手动清空、旧请求 epoch、6 台服务器的排队索引、关闭后晚到发现、clearMemory 后 live invalidation 均覆盖；500 容量与慢盘合并快照覆盖。探测写盘失败不报成功，失败与成功连接均关闭 client。
- 新建探测组件覆盖本地/三种远端、探测中/成功/失败重试、防重复点击、名称/配置/凭据编辑后的旧响应隔离、关闭重开隔离、直接保存与不自动保存声明/规则。此处是 jsdom 组件证据，不是宿主浏览器证据。
- 隔离实例安装成功，监听 PID 51008、端口 58857；启动器等待 120 秒但 `boot.out`/`boot.err` 均为空、没有认证 URL。浏览器直接访问实际返回 **401 Unauthorized**，未绕过认证。仅经 isolate stop 核对 DSH_HOME/命令行/端口后停止本轮实例，端口已释放。日常 57370 实例未改动。
- 首轮类型检查发现新增 RemoteError 缺 reason 字段，补齐后通过；早期排队索引回归用 40ms delay + 50ms waitFor 采样使第二批先启动而失败，改成显式连接 promise gate 后全量通过。门禁不识别 spec.{ts,tsx} 的窄 include，增加显式排除 node:test 文件后通过。以上失败不作为通过证据。

### 本节未覆盖

- **宿主真实浏览器验收受阻**：隔离实例无认证 URL，401。因此新增按钮的真实点击、全部 11 档宽度/深浅色/reduced-motion/真实手机软键盘与安全区均未验证；没有宣称 UI 已达标。
- 单测使用 SDK doubles，没有实际本地 stdio 子进程或真实云端服务的端到端连通性/重启恢复测量；本轮未使用真实凭据。
- 不承诺断电 fsync 持久性或 Windows owner-only ACL。跨主机共享 home 的 PID 文件锁不受支持；另一宿主清空后旧宿主写入安全拒绝，需要重新加载插件/宿主再写。
- 安装开发测试依赖时 npm audit 汇总报告 15 项依赖漏洞（5 moderate / 8 high / 2 critical），本轮未自动执行 audit fix/升级无关依赖，未进行漏洞归因分析。

---
## 二十三、服务器列表独立滚动与顶部固定（2026-10-28，产物 `6C9E5236` / `7CBDE037`）

### 环境与产物绑定

| 项 | 值 |
|---|---|
| 日期 | 2026-10-28T20:45:23+08:00 |
| 插件 | @guowenzhang/dsh-mcp-manager@1.5.0（HEAD 4ffdf2a，工作树 26 项未提交） |
| 宿主 | @deepseek-ai/dsh@0.2.1-rc.2（隔离实例） |
| DSH_HOME | `C:\02-codespace\DeepSeek\.scratch\harness-tests\mcp-roster-scroll-0.2.1-rc.2-3zpa5t` |
| 端口 / URL | 40236（未取得认证 URL；该隔离实例已停止，端口已释放） |
| Node | v24.12.0 |
| lib/index.mjs | `6c9e52361d6aefb6b8f8a069874c2671f8eba180525ca9d4b0cda5f77da4fe63`（222692 字节，2026-10-28T12:43:35.682Z） |
| lib/client.js | `7cbde037f40f793297208ad6e5bc69619688b31e788a2ed5784e2f36ae252e05`（192048 字节，2026-10-28T12:53:25Z） |
| 证据文件 | `.scratch/test-system/runs/2026-10-28-204338-dsh-mcp-manager.json` |

### 车道结果

| 车道 | 状态 | 退出码 | 耗时 |
|---|---|---|---|
| typecheck | passed | 0 | 1.5s |
| build | passed | 0 | 0.7s |
| unit | passed | 0 | 2.2s |

### 逐项读数

- 类型检查、build、单元/组件 **27 文件 / 310 项**通过；static gate 0 error / 0 warning。修改只涉及 MCP 插件内部：height:100% 获取宿主已限定的内容高度，活动 tabpanel/rosterBlock 以 min-height:0 收缩，列表状态放在固定挂载的 rosterBody 中；页头、页签、服务器标题/新增、全局提示与筛选不在滚动区中。设置页签保留自己的内部滚动。
- 隔离测试宿主选择 npm latest 的精确版本 `0.2.1-rc.2`（当时 next 是 `0.2.1-rc.4`，未混用）；安装成功，监听 PID 50684、端口 40236。但 boot.out/boot.err 为空，120 秒内没有认证 URL，完整宿主浏览器验收未进入。没有绕过认证。isolate stop 校验命名空间、端口归属与命令行后停止；status 复核 portOwner=null。日常实例未改动。
- 最终构建证据 `.scratch/test-system/runs/2026-10-28-205325-dsh-mcp-manager.json`；标准 `browser:roster-scroll` 车道通过，最终加强版 76.2 秒，证据 `.scratch/test-system/runs/2026-10-28-210209-dsh-mcp-manager.json`（先前轮次 63.4 秒也通过）。浏览器为已安装 Chrome **156.0.8078.73**，fixture 使用实际 McpSection TSX/CSS、真实宿主 ui-primitives、完整主题表与 SettingsRoot 的 panel/content/header/options 样式，数据每个预设 **80 行**（standard/other）。宿主样式/控件来源为工作区源码包 `0.2.1-alpha.2`，与上面的 npm 隔离宿主不是同一版本。常规窄宽矩阵仅复现 content 列、不渲染188px导航；另有1440px真实导航场景，不把此矩阵宣称为完整宿主手机适配。构建 manifest 对全部输入逐项 SHA256 防过期，fixture artifact `c8a0068e1046ab3a87f3d0902b7a131671c8ae7b4beb9e56d00a289dd5da7110`；这不是完整 Harness 集成测试。
- 真实 Chromium **49 场景全通过**：320/360/390/430/600/601/760/761/1024/1280/1440px × 浅/深 × motion/reduced（44），另宽窗口 420px 窄面板、真实188px宿主导航、390×560、1440×420、761×560。所有场景标题/说明/页签/服务器标题/新增/搜索/预设选择器在滚轮及键盘滚动前后的 x/y/width/height 变化 **0px**；宿主 options、外祖先和 document scrollTop 都为 **0**；卡片左右缘与页签左右缘差都为 **0px**，无横向溢出，控制台/页面错误 **0**。
- 1440×900：列表视窗 **518px**、行高 **70px**、末端 scrollTop **5880px**；390×900：视窗 **430px**、堆叠行高 **110px**、末端 scrollTop **9168px**；1440×420 短窗口仍有 **90px** 可滚动视窗。滚轮、PageDown/End、末行可达、到底不链式滚动父级、筛选/预设切换、短列表/空态、切到设置单独滚动/切回保留位置、刷新保留位置均通过。短高下测试短列表为自然能放下的1行（不是强制把两行挤下）。
- 完整读数：`.scratch/test-system/mcp-roster-scroll/readings-2026-10-28T13-02-09-201Z.json`。截图 `.scratch/test-system/mcp-roster-scroll/1440x900-dark-motion.png`、`390x900-light-motion.png`，浏览器启动明确移除 `--hide-scrollbars`；本轮检查实际滚动与几何，不宣称已做滚动条像素剖面。
- 浏览器测试已登记到工作区 `tools/testing/registry.mjs` 的 `browser:roster-scroll` 车道，fixture 构建只输出工作区 `.scratch/test-system`，不启动替代应用服务器、不访问日常实例。

### 本节未覆盖

- 完整 npm 宿主内实际设置页未验证：隔离实例未输出认证 URL。fixture 只能证明真实组件与宿主 CSS 的几何/滚动行为，不替代完整 slot/插件装配验收。
- 真实手机软键盘、安全区、触摸滚动与安装版 GUI 的直接运行未验证；不宣称当前日常界面已自动更新。

---
## 二十四、Agent 预设名称复用宿主当前语言显示名（2026-10-28，产物 `C757C120` / `CBB6FA6E`）

### 环境与产物绑定

| 项 | 值 |
|---|---|
| 日期 | 2026-10-28T22:20:06+08:00 |
| 插件 | @guowenzhang/dsh-mcp-manager@1.5.0（HEAD 4ffdf2a，工作树 35 项未提交） |
| 宿主 | 工作区 Harness 源码 `0.2.1-alpha.2` 组合/字典/控件验证；静态 helper 来自已装 registry `0.1.7-rc.2`，非日常 GUI 实测 |
| DSH_HOME | （未绑定） |
| 端口 / URL | （未绑定） |
| Node | v24.12.0 |
| lib/index.mjs | `c757c12094241c406936cfdfdd7db3cfd1c44bcd7195e3c86ef0ef9784425360`（222655 字节，2026-10-28T14:19:04.697Z） |
| lib/client.js | `cbb6fa6e3d8fe3f603d9fb6f31cfbad10c31effdcf0ea2e9b80530b4c384de05`（195837 字节，2026-10-28T14:25:03Z） |
| 证据文件 | `.scratch/test-system/runs/2026-10-28-222505-dsh-mcp-manager.json`（最终类型/构建/单测）；`2026-10-28-221806-dsh-mcp-manager.json` 为前一轮 |

### 车道结果

| 车道 | 状态 | 退出码 | 耗时 |
|---|---|---|---|
| typecheck | passed | 0 | 1.8s |
| build | passed | 0 | 0.7s |
| unit | passed | 0 | 2.3s |

### 逐项读数

- 最终类型、构建、单元/组件 **29 文件 / 319 项**通过（`2026-10-28-222505-dsh-mcp-manager.json`；前一轮318项通过后补充切语言不重置编辑草稿的回归）。真实 Harness 组合 **7 文件 / 27 项**通过，证据 `.scratch/test-system/runs/2026-10-28-221908-dsh-mcp-manager.json`；静态门禁 0 error / 0 warning。
- 根因是 client/index.ts 在读取时把 optional name 改成 name??id，抹掉宿主内置预设判据且把字符串缓存。修复保留 `{id,name?}`，向页面注入稳定的 presetName callback，render时用宿主公共 `presetDisplayText` 与活的 `settings.agentPreset` 翻译函数；不新增 activation audit RPC，不复制内置中文映射。
- 滤镜菜单、选中显示、卡片预设芯片、新增目标选项和编辑范围共用 resolver，筛选/保存仍用原始 id；自定义名称（含空字符串）保留。旧宿主缺字典时退回 id、不展示 locale key。shared `/display` 无 import 纯 helper 精确内联进产物，产物测试确认没有运行时 require 该宿主子路径。
- 新增5项 resolver/产物测试、2项组件交互测试及1项名册原始元数据测试：四种内置名称、同一数据切语言、自定义同id覆盖、未知id/缺字典回退、空名称、菜单/卡片一致、新增select value不变，全部通过。另补1项切换 translator 后不重置编辑草稿/目标、不重读预设的回归，移除编辑初始化 effect 的 t 依赖；名称依旧在 render 更新。首次类型检查发现 agent-filter helper要求name必填，改为传render-local本地化投影后通过，没有将其误记为通过。
- 浏览器首次新增编辑断言在 effect 填充服务器名之前取值，空值断言失败；改为等待输入框完成加载后验证（同时修正卡片点击落在 padding，避免误点描述编辑按钮）。产品名称解析未因此改变；失败记录 `2026-10-28-222709-dsh-mcp-manager.json`、`2026-10-28-223002-dsh-mcp-manager.json` 不计作通过，随后 quick 开发子集已通过，完整最终结果另列。

- 最终真实 Chrome **156.0.8078.73** 浏览器车道 **51/51 场景通过**（保留滚动49场景，增加1440px浅色/390px深色本地化2场景），耗时76.4秒，console/page error **0**。名称精确对照宿主实际字典：中文 `标准模式 / PTC 模式 / 极简模式 / 创造模式`，英文 `Standard mode / PTC mode / Minimal mode / Creator mode`；Research Agent 原样。打开菜单/选中项/卡片芯片/新增目标/编辑范围活切zh↔en，selected id仍ptc/research，新增select values始终原始id，语言切换期间roster reads **1→1**。
- 最终车道证据 `.scratch/test-system/runs/2026-10-28-224236-dsh-mcp-manager.json`；完整读数 `.scratch/test-system/mcp-roster-scroll/readings-2026-10-28T14-42-36-034Z.json`，输入manifest逐项hash含产品helper、宿主字典/控件/样式。截图 `.scratch/test-system/mcp-roster-scroll/preset-names-390-dark-zh-menu.png`、`preset-names-1440-light-zh-menu.png` 以及对应 en-menu/zh-add-target/en-edit-scope 均已生成。fixture无网络/认证/日常数据，不等同完整宿主集成。

### 本节未覆盖

- 未向日常安装实例安装/重载本次产物，完整认证 GUI 流程没有重新验收；上一节隔离实例不输出认证 URL 的限制仍存在。
- 真实手机软键盘/安全区、全部旧版宿主的兼容性未验证；只核对已装 helper 与工作区源码契约。

---
## 二十五、全部 MCP 目录 SQLite 持久化与服务器专属刷新（2026-10-28，产物 `79D5D56D` / `C05B2F61`）

### 环境与产物绑定

| 项 | 值 |
|---|---|
| 日期 | 2026-10-28T23:46:44+08:00 |
| 插件 | @guowenzhang/dsh-mcp-manager@1.5.0（HEAD 4ffdf2a，工作树 53 项未提交） |
| 宿主 | 工作区源码组合测试；浏览器fixture使用宿主0.2.1-alpha.2控件/主题/字典，无新的运行宿主实例 |
| DSH_HOME | （未绑定） |
| 端口 / URL | （未绑定） |
| Node | v24.12.0 |
| lib/index.mjs | `79d5d56d18ab8b99501182382a7fbbea5d2a3bd67e06bc3a0a161abf53de1d6b`（228670 字节，2026-10-28T15:52:03Z） |
| lib/client.js | `c05b2f61377bf85fb1479b6297c28bc6cfd01d3ba2d61d61981204a353fe54d6`（202011 字节，2026-10-28T15:45:23.204Z） |
| 证据文件 | `.scratch/test-system/runs/2026-10-28-235056-dsh-mcp-manager.json`（最终类型/构建/单测）与 `2026-10-28-235207-dsh-mcp-manager.json`（最终Harness）；234525为前轮 |

### 车道结果

| 车道 | 状态 | 退出码 | 耗时 |
|---|---|---|---|
| typecheck | passed | 0 | 1.6s |
| build | passed | 0 | 0.7s |
| unit | passed | 0 | 2.4s |

### 逐项读数

- 用户取消“本地JSON/云端仅内存/自定义TTL”旧模型；运行入口统一 databaseCatalogStorage，所有 stdio/HTTP/SSE 工具目录均写真实SQLite，路径 profile home/cache/dsh-mcp-manager/<profile hash>/catalog.sqlite。没有JSON读取/迁移/回退或手动TTL。旧JSON文件源码已清成无导出能力的空模块，唯一运行入口不再引用；删除操作被file-guard拒绝，未绕过。旧测试已替换成SQLite选型防回归，不再保留HTTP不落盘断言。
- 类型、构建、单元/组件 **31文件/330项**通过；Harness **7文件/27项**通过（最终`.scratch/test-system/runs/2026-10-28-235207-dsh-mcp-manager.json`；233737为前轮）。数据库套件19项是真实SQLite文件：头部SQLite format 3、两transport重开、共享generation、独立writer merge、空读不创建、公开字段投影、坏库/未知schema拒绝、事务回滚、500行/32MiB UTF8逻辑payload限制。内存目录9项涵盖本地长期、HTTP仅server TTL/无TTL手动、0 TTL、跨重开schema、clear/close晚到拒绝。
- 产物Remote探测与刷新7项：本地/http/sse/streamable-http全部探测后返回前已写库，刷新只连接HTTP、不启动本地，失败保留已存目录。mcp_load/search套件41项含searchIndex=false下已知过期HTTP自动刷新、无TTL不按时间刷新、clear后排队发现不复活。分页发现取所有有效TTL最短值，本轮补1项断言。
- 控件8项覆盖TTL控件移除、目录状态cache组内、首屏仅纯状态读取、真正refreshCatalog RPC、防连点/pending/success/partial/失败保持旧内容、clear原RPC、迟到read不覆盖新状态、local/manual/expired显示。
- 最终真实Chrome156.0.8078.73 **53/53场景通过**（原滚动49+名称2+缓存控制2），76.3秒，console/page错误0。缓存控制在1440px浅色/390px深色实测：状态直接嵌cache组、TTL控件0、页面渲染刷新调用0、按钮后refresh调用1、local/server记录保留、clear后两类均移除。证据 `.scratch/test-system/runs/2026-10-28-234000-dsh-mcp-manager.json`，读数 `.scratch/test-system/mcp-roster-scroll/readings-2026-10-28T15-40-00-023Z.json`，截图对应catalog-controls-1440-light.png/catalog-controls-390-dark.png。数据callbacks为fixture，非真实云端。
- 首轮类型错误为store工具字段索引断言，换Reflect.get后通过；独立writer测试偶发b先于a提交导致顺序断言失败，改按label比较独立记录集合后全量通过。未把失败记作通过。node:sqlite ExperimentalWarning为Node24内置模块预期提示。

### 本节未覆盖

- 未更新、重启或安装日常实例；完整认证宿主GUI没有重跑，早先隔离实例不输出认证URL的限制仍存在。fixture只验证真实组件/宿主CSS，不替代安装组合验收。
- 实际云端服务/真实本地子进程连通性未使用真实凭据测试；Remote用SDK double，数据库是真实文件。
- 未在最低Node22.19或Electron宿主逐版本跑SQLite。只在Node24.12.0验证；POSIX0600不代表Windows ACL。数据库32MiB为逻辑payload不是SQLite页/索引文件大小。
- 跨进程clear通过数据库generation拒绝旧writer写回；其他已经运行的宿主实例的旧内存快照不会主动实时同步，本轮未宣称多宿主实时共享目录。
- 本轮没有提交、推送、升版或发布npm，已有其它未提交改动继续保留。

---
