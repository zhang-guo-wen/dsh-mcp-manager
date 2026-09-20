---
description: "dsh-mcp-manager 的同类插件对比与功能路线图：社区三簇玩家的做法、逐维度差距、按投入产出排序的下一步。"
kind: "package-reference"
---

# 竞品与路线图 —— MCP 插件生态

本页回答两个问题：**同类插件都做了什么**，以及**我们下一步做什么、凭什么优先级**。
检索方法与来源在文末，可复现。星标与提交时间取自 2026-09-20 的 `gh search repos`，会随时间变化。

设计取舍记在 [design-decisions.md](design-decisions.md)；实现契约在 [AGENTS.md](../AGENTS.md)；
本页只记录外部事实与由它导出的路线图。

## 生态概况

MCP 管理不是蓝海：`gh search repos 'dsh mcp'` 一次就有 20+ 个直接同类，`topic:dsh-plugin` 下更多。
按机制分成三簇，我们同时属于第一簇与第三簇。

| 簇 | 代表仓库 | 星标 | 核心卖点 |
|---|---|---|---|
| 管理面板（事实标配） | [PerryLink/dsh-mcp-panel](https://github.com/PerryLink/dsh-mcp-panel) / [Fishquito7/dsh-skill-mcp-panel](https://github.com/Fishquito7/dsh-skill-mcp-panel) / [xxxYZ/DeepSeekHarness-MCP-Manager](https://github.com/xxxyz/DeepSeekHarness-MCP-Manager) / [Js2Hou](https://github.com/Js2Hou/dsh-mcp-manager) / [Imzl-zl](https://github.com/Imzl-zl/dsh-mcp-manager-ui) / [null119](https://github.com/null119/dsh-mcp-manage) / [kairoz9](https://github.com/kairoz9/dsh-mcp-admin) | 61 / 135 / 19 / 18 / 18 / 16 / 4 | 设置页 CRUD + 状态 + 工具数，写回 `cordis.patch.yml` |
| 连接器与鉴权 | [duhu2000/dsh-mcp-connector](https://github.com/duhu2000/dsh-mcp-connector) / [hyqhyq3](https://github.com/hyqhyq3/dsh-mcp-manager) / [ArvinQi](https://github.com/ArvinQi/dsh-mcp) / [springbrand-lab](https://github.com/springbrand-lab/dsh-oauth-mcp-client) / [fangzaozao](https://github.com/fangzaozao/dsh-mcp-oauth-client) | 24 / 16 / 15 / 8 / 0 | OAuth 2.1 + PKCE + 动态注册 + 回环回调 + 凭据刷新 |
| 省上下文与延迟加载（我们的赛道） | [labmimors/dsh-mcp-lens](https://github.com/labmimors/dsh-mcp-lens) / [wings1848/dsh-mcp-lazy](https://github.com/wings1848/dsh-mcp-lazy) / [leaforbook/dsh-mcp-lazy](https://github.com/leaforbook/dsh-mcp-lazy) / [vibeinging/dsh-tool-search](https://github.com/vibeinging/dsh-tool-search) / [ben7am1n/dsh-mcp-proxy](https://github.com/ben7am1n/dsh-mcp-proxy) / [AllenLogo/dsh-mcp-session](https://github.com/AllenLogo/dsh-mcp-session) / [lilyblessing/dsh-mcp-skill-panel](https://github.com/lilyblessing/dsh-mcp-skill-panel) | 9 / 4 / 3 / 1 / — / 0 / 6 | 把常驻 schema 压成 1–3 个固定工具 |

互补而非竞品：反向委派 MCP server [Mr-potato-123/dsh-mcp](https://github.com/Mr-potato-123/dsh-mcp)（117 ★，把 DSH 当后端）、
MCP 工具 diff 卡 [Fakek0f3sT/dsh-mcp-diff](https://github.com/Fakek0f3sT/dsh-mcp-diff)、
MCP Apps 宿主 [sugarforever/dsh-mcp-apps](https://github.com/sugarforever/dsh-mcp-apps)、
反向的 [xDJTomato/deepseek-harnessed](https://github.com/xDJTomato/deepseek-harnessed)。

## 逐维度对比

| 维度 | 我们 | 竞品做法 |
|---|---|---|
| 加载模式 | 三档 `eager`/`dynamic`/`lazy` + 「允许」与「何时进上下文」两个开关 | 多数只有 enable/disable；leaforbook 分「自动接管（只藏 schema）」与「连接层懒加载」两级 |
| 进程惰性 | 行级摘除，未加载的服务器**一个进程都不起** | leaforbook 明说不关第三方进程；wings1848 / ben7am1n 只在首次调用时 spawn |
| schema 交接 | `lazy` 把 schema 作为 `mcp_load` 的文本结果返回 | proxy / panel 干脆不给完整 schema（只在调用时透传）；leaforbook 用 `describe` 按需吐；tool-search 不复制 schema，靠下一次请求头部带上 |
| 检索 | 无，一次倒出整台服务器 | hyqhyq3 三工具（BM25 + NFKC + CJK + 别名 + 编辑距离，默认 10 / 上限 50）；labmimors 两工具固定 1,114 B；ben7am1n 纯关键词；wings1848 加权排序 |
| 回合末回收与闲置 | 连接留到会话结束 | leaforbook `releaseOnTurnEnd` + `warmIdleMs` 5 分钟；ben7am1n `idleDisconnectMs` 5 分钟；lilyblessing 30 秒 |
| 目录磁盘缓存 | 无 | wings1848 / ben7am1n 元数据落盘，**不连进程也能答搜索**；labmimors `catalogTtl` 24 小时 |
| 覆盖非 preset 行 | 全局行恒常驻（README 已注明） | leaforbook 自动接管任意 `mcp__<server>__*`；AllenLogo 每个 agent `restrict({deny:['mcp__*']})` |
| OAuth | 只有静态 header / env | 五家都有 PKCE + DCR + 回环回调 + 刷新 |
| Resources / Prompts | `lazy` 与过滤载体的服务器拿不到 resources | PerryLink 只读浏览 resources；hyqhyq3 与 labmimors 都处理了 |
| 探测与试调 | 只有启用停用与名册 | Js2Hou 探测报延迟 + 工具数；PerryLink `/mcp call` 试调走官方执行管线 |
| 配置导入 | 导入 Claude Code 全部来源（用户 / 项目 / 设置 / `.mcp.json`），名称按规范预检，逐条独立导入 | Imzl-zl 导入 Claude / Cursor / Cline / Roo / VS Code 配置 |
| 作用域 | 全局 + preset，且 `mcp_load` 绑到单个会话 | 多数只有全局；五家做项目或工作区级（见[作用域分层](#作用域分层)） |
| 写配置的可回滚 | atomic write + `tree.refresh()` | PerryLink 审批门 + 自动备份；null119 override + revert/restore；ArvinQi 受管块 + `.bak` + 幂等 |
| CLI / HTTP API | 无 | Fishquito7 全套 `dsh-panel` CLI；xxxyz `POST /dsh-mcp-manager/api`（同源 + token 校验） |
| 测试 / CI / 分发 | 1 个 spec（51 行），无 test script、无 CI、未发 npm | leaforbook CI 跑 rc.6/rc.7/rc.8；labmimors 178 测试 + 1000 工具基准；vibeinging 带 invariant companion |

### 我们守住的三点

1. **进程级惰性 + 行级过滤 + 会话隔离三合一**：`mcp_load` 走 `exec.agent.ctx.plugin()`，native 载体随会话销毁，
   proxy 载体靠 `bindAgentScope` 回收。竞品要么不管进程（leaforbook），要么不管作用域（多数面板插件）。
2. **工具过滤两点强制**：`mcp_load` 的返回与 `mcp_call` 的入参校验都挡；配了规则的行自动切换代理载体。
   labmimors 的 `allowTools/denyTools` 最接近，但它是网关级、没有按行规则。
3. **加载语义显式建模**：两个正交开关，且模式是活设置（提交即对所有会话的下一次请求生效）。
   竞品普遍只有一个 enable/disable 维度。

### 已知的两类代价（来自竞品视角，我们尚未在 README 写明）

- **代理通道丢掉模型侧的参数文档**：`lazy` 要求模型照抄 schema 里的参数（设计取舍见 design-decisions.md D2）。
- **代理通道丢掉富 UI 呈现**：`dsh-mcp-diff` 按 `mcp__<serverName>__<tool>` 前缀注册 toolview，
  `dsh-mcp-apps` 按工具 `_meta.ui.resourceUri` 渲沙箱 App——两者都依赖工具被**原生注册**。
  经 `mcp_call` 的调用结果只有一个文本字段，这类卡片与 App 不会触发。

## 作用域分层

「这个 MCP 属于谁」在生态里有五种答案，越往下越少见——**多数插件只有最上面一层**。

| 作用域 | 语义 | 谁这么做 |
|---|---|---|
| 全局 / profile | 所有会话可见；写 `cordis.patch.yml` 或 `~/.dsh/mcp.json` | PerryLink、Js2Hou、kairoz9、Fishquito7、null119、zebbkira、wings1848、ben7am1n、labmimors、leaforbook（显式 server）、duhu2000（global 半边） |
| 项目 / 工作区（按目录，不按 agent） | 只有 cwd 落在该工作区的会话可见 | Imzl-zl（`.dsh/mcp.json`）、hyqhyq3（user vs workspace）、yangfch3（只有 workspace 级）、duhu2000（project 半边 + Host 强制隔离）、lilyblessing（`.dsh/mcps`） |
| **agent preset 平面** | 行写进该 preset 的 `agent.cordis.yml` | **只有 lilyblessing 与本插件**。它显式操作 preset 行（`loader.resolve(id).update({disabled})`，README 写明「启停作用于 preset 层」）；我们按 `preset:<id>:<name>` 行键管理，用闸门挂载而不写文件 |
| per-agent 可见性 | 每个 agent（含子代理）一份可见集合，服务器归属不变 | AllenLogo（`agent/created` 给每个 agent 装 `restrict({deny:['mcp__*']})`，`mcp_pin` 显式物化）、hyqhyq3（`agents.create` / `resume` 时在 agent scope 注册 + `exclude` 遮蔽）、vibeinging（per-agent 工具检索） |
| 单会话加载 | 服务器真的挂进调用方那一个 agent 的层 | 只有本插件（`mcp_load` → `exec.agent.ctx.plugin()`）。竞品的「按需」多是揭示已有工具，不涉及服务器归属 |

两条容易混为一谈的线要分开看：**可见性**（每个 agent 看到哪些工具，AllenLogo / hyqhyq3 / vibeinging 在做）与
**绑定**（服务器属于谁，只有 preset 平面与 `mcp_load` 在做）。Imzl-zl 的 README 甚至明说不要把本插件手工插进 Agent preset。

### 两条 DSH 语义（读源码核实）

1. **子代理继承的是父的 preset standing mount，不是父 agent 本身。**
   [`packages/subagent/subagent/src/child-agent.ts`](../../packages/subagent/subagent/src/child-agent.ts) 的
   `applyChildComposition` 调 `agentPresets.composeFrom(childCtx, parent.ctx)`，
   [`packages/preset/agent-presets/src/index.ts`](../../packages/preset/agent-presets/src/index.ts) 里它落到
   `bindScopeParent(agentKey, standing.key)`。所以 preset 平面的 MCP 行，该 preset 的会话**及其子代理**都能用。
2. **父 agent 自己 scope 上的东西不会漏给子代理。**
   `mcp_load` 挂进 `parent.ctx`、`restrict()` 也在父的层，子代理的 scope 链上没有它们。
   AllenLogo 的 README 把这条记作实测结论（"a parent's `restrict()` does not reach a subagent"）。

于是本插件的两种语义互补：**preset 行 = 绑到 preset（含子代理继承）；`mcp_load` = 绑到当前会话（不含子代理）**。
检索范围内同时具备这两者的只有本插件。

### 交叉验证

lilyblessing 记录过一次事故：**运行期写 preset 文件会触发 standing 重挂且旧实例不清理**（serverName 全冲突、会话创建失败），
它因此改成「状态文件 + 启动早期物化」。这与 [design-decisions.md](design-decisions.md) D5 选「运行时摘行、绝不写文件」
是各自独立得到的同一结论。

## 路线图

优先级按「投入产出 + 是否补上机制差距」排序，每条给出证据与实现落点。

### P0 —— 生态短板，半天内可完成

1. **加 GitHub topics 并登记社区目录。**
   证据：我们仓库 `topics` 为空、0 star；竞品全部带 `dsh-plugin`，[awesome-dsh-plugins](https://github.com/kejixiaoliang/awesome-dsh-plugins)
   的 [CONTRIBUTING](https://github.com/kejixiaoliang/awesome-dsh-plugins/blob/main/CONTRIBUTING.md) 以该 topic 为收录前提，其 MCP 分类眼下只有 8 条。
   落点：仓库 topics（`dsh-plugin`、`dsh`、`mcp`、`deepseek-harness`）+ 往 `plugins/mcp.md` 提一行 PR。
2. **接上 `npm test` 与最小 CI。**
   证据：`package.json` 只有 `build` / `typecheck`，`tests/mcp-tool-filter.spec.ts` 没有任何 script 调到它；无 `.github/`。
   落点：加 vitest script + 一个跑 build / typecheck / test 的 workflow。
3. **发 npm。** 证据：社区文档给的安装形态主要是 `dsh plugin add <npm 包>`；`@yilinxiao/dsh-mcp-lazy`、`dsh-mcp-proxy` 都已发布，我们只能 git 装。

### P1 —— 核心赛道（1–2 周）

4. **检索式 `mcp_load`（最高优先级）。**
   证据：hyqhyq3 的三工具 broker（BM25 + NFKC + CJK + 别名 + 编辑距离，默认 10 / 上限 50）、
   labmimors 的两工具固定 1,114 B、ben7am1n 纯关键词、leaforbook 的路由工具——四家都证明"按查询只给出命中的工具"可行且有效。
   落点：给 `mcp_load` 加可选 `query`，复用 [`src/mcp-tool-filter.ts`](../src/mcp-tool-filter.ts) 的白名单机制与
   [`src/lazy-mcp.ts`](../src/lazy-mcp.ts) 的结果渲染，只返回命中的 top-N 工具及其 schema。检索保持离网、无 embedding。
5. **回合末 schema 回收 + 连接保温。**
   证据：leaforbook `releaseOnTurnEnd` + `warmIdleMs`（默认 5 分钟）是当前最完整的形态；
   ben7am1n 与 lilyblessing 也各有 5 分钟 / 30 秒的回收。我们的 `lazy` 一旦加载，schema 就留在会话历史里收不回。
   落点：`mounted` 现在只有 `Map<agentId, Map<serverName, MountedServer>>`，需要再维护每个 agent 的可见集合与保温暖回收定时器。
6. **用 `tools.restrict()` 把全局平面纳入 lazy。**
   证据：这能消掉我们 README 里那条"全局行恒常驻"的限制，也是 leaforbook 与 AllenLogo 覆盖第三方行的手段。
   harness 已有公共 API：`ctx.tools.restrict({ deny })` 要求 scoped context、名字必须已知、被 restrict 的名字读作不存在（调用直接 `UNKNOWN_TOOL`）。
   可直接照抄的先例是 [`packages/experimental/browser-use-runtime/src/mcp.ts`](../../packages/experimental/browser-use-runtime/src/mcp.ts)
   （`createScope(ctx, agent)` + `restrict({ deny: inherited.map(t => t.name) })` 屏蔽继承来的 MCP 工具）。
7. **目录磁盘缓存 + 闲置回收。**
   证据：wings1848 与 ben7am1n 的元数据落盘让搜索不必启动进程；labmimors 的 `catalogTtl` / `idleDisconnect` 是现成参数表。
   落点：缓存 `listTools` 结果（含 schema），供编辑弹窗与 `mcp_list` 复用；给已加载连接加空闲超时。
8. **量化并公布 token 收益，同时测出 `dynamic` 的前缀代价。**
   证据：leaforbook 给出 95.6% / 94.4% / 88.8%（合计 9,727 → 581）；wings1848 给出 5,313 → 381；
   labmimors 给出 1,114 B vs 647,962 B；lilyblessing 量化了缓存 miss 的 5–12.5 倍费率；
   vibeinging 自曝首次选择后只剩约 2% 前缀。我们 README 目前没有任何数字。

### P2 —— 连接能力补齐

9. **OAuth 2.1 + PKCE（含动态注册）**，凭据走 DSH 的 credentials 服务而不是写进配置文件。
   反面教材是 fangzaozao：明文 token 落 `cordis.patch.yml`。落点：`McpSpec` 加鉴权字段 → [`src/mcp-config.ts`](../src/mcp-config.ts) 透传。
10. **给代理载体注册资源提供者。**
    harness 有现成的 scoped 缝：[`packages/mcp/mcp-resources/src/index.ts`](../../packages/mcp/mcp-resources/src/index.ts) 的
    `ctx.mcpResources.register(server, provider)`，provider 只需实现 `resources/list`、`resources/templates/list`、`resources/read`。
    我们的 SDK client 已经连着服务器，补上 provider 就能让懒加载的服务器也有 resources——这是当前 `lazy` 的功能空洞。
11. **连接探测（probe）。** 编辑弹窗加"测试连接"，报延迟、工具数与失败原因（Js2Hou、PerryLink、duhu2000 都有）。
12. **工作区级作用域**（按会话 cwd 隔离）。
    证据：Imzl-zl、hyqhyq3、yangfch3、duhu2000、lilyblessing 五家都做，这是我们唯一完全缺失的作用域维度。
13. **子代理的服务器获取与继承**（评估项）。
    证据：AllenLogo 的 `mcp_pin` 整会话常驻且显式物化，子代理能自行 `mcp_call` / `mcp_pin` 获取服务器。
    本插件目前只有"子代理各自 `mcp_load`"，没有 pin，也没有从父会话继承的语义（父的层本来不在子代理的 scope 链上）。

### P3 —— 管理面增强

12. ~~批量导入 Claude Code 的 `mcpServers`~~ —— **已完成**：设置页工具栏「导入 Claude 配置」，
    读 `~/.claude.json`（含 `projects[<cwd>]` 分区）、`~/.claude/settings.json`、`settings.local.json`
    与项目 `.mcp.json`，勾选后逐条导入为全局行（`scanClaudeMcp` + 现有 `addMcp`，见 [AGENTS.md](../AGENTS.md)）。
    仍未做：Cursor / Cline / Roo / VS Code 的配置文件（Imzl-zl 覆盖的那批），以及导入到 preset 平面。
13. 配置写入的备份与 revert；14. UI 内工具试调（走官方执行管线，不进模型上下文）；
15. 观察项：MCP Apps（`_meta.ui.resourceUri`）已经进入生态，我们的三种模式都未考虑它。

### 不建议追

- **WebSocket 传输**：检索到的同类仓库没有一家做。
- **embedding 检索**：四家明确列为未实现或 deferred，词法检索已够用。
- **通用工具检索**：[vibeinging/dsh-tool-search](https://github.com/vibeinging/dsh-tool-search) 已用 `tools.restrict()` 做了全工具版本；
  我们应聚焦「MCP 专属 + 管进程」这一层，而不是再写一个通用 tool search。

## 检索方法与来源

```sh
gh search repos 'dsh mcp' --limit 20 --json fullName,description,stargazersCount,pushedAt
gh search repos --topic dsh-plugin mcp --limit 30 --json fullName,description,stargazersCount
gh search repos 'dsh mcp lazy' --limit 8 --json fullName,stargazersCount,description
gh api repos/<owner>/<repo>/topics -H 'Accept: application/vnd.github+json'
```

结论来自各仓库 README 原文、[awesome-dsh-plugins](https://github.com/kejixiaoliang/awesome-dsh-plugins) 目录，
以及本仓源码对 harness 能力（`tools.restrict()`、`mcpResources.register()`）的核对。星标与时间均为 2026-09-20 采样。
