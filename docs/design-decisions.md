---
description: "dsh-mcp-manager 加载相关决策的参考页：每条决策的结论、理由、被否决的替代方案与已知代价，以及 Claude 延迟加载先例的对照。"
kind: "package-reference"
---

# 设计决策参考 —— MCP 加载

本页是「为什么」的唯一归属：加载相关的每条决策记结论、理由、被否决的替代方案与已知代价。
用户可见行为在 [README.zh.md](../README.zh.md)，实现契约与踩坑在 [AGENTS.md](../AGENTS.md)。
末节是外部先例（Claude Code 与 Anthropic Messages API 的 tool search），作为后续决策的对照基线。
外部资料查阅日期：2026-09-20，来源见文末。

## 决策清单

| 编号 | 决策 | 一句话理由 |
|---|---|---|
| D1 | 「允不允许用」与「什么时候进上下文」是两个开关 | 两件正交的事用一个枚举表达不了 |
| D2 | 三种加载模式，默认 `dynamic` | 省 token 与工具绑定质量之间取默认值 |
| D3 | 按需工具的注册落在 host 平面 | 放 preset 作用域会让 preset 反复重挂 |
| D4 | 连接按会话隔离，随会话回收 | 一个会话加载的服务器不能漏给别的会话，也不能活过它 |
| D5 | 预加载靠运行时摘行（gate），不写文件 | preset 是输入不是持久化目标 |
| D6 | 工具过滤在返回与调用两点强制，并强制代理载体 | 只挡一处挡不住模型凭记忆直呼工具名 |
| D7 | `mcp_load` 结果带 `hidden` 计数 | 模型必须知道"还有工具但不可调用" |

### D1 允许与进上下文分离

- **结论**：composition 行上的 `disabled` 表示用户**允不允许用**（禁用 = 完全不用：不进 `mcp_list`，`mcp_load` 拒绝）；`mcp-manager.loading` 表示允许的服务器**什么时候进上下文**。
- **理由**：服务器实际有三态——不用 / 可用但按需 / 常驻。两个正交输入能表达全部三态，且 UI 能把"已配置但未运行"如实显示出来。
- **被否决**：把"不预加载"编码成 `disabled`。那样"允许但按需"无法表达，用户也无法从界面区分"我关掉了它"和"它按需可用"。
- **代价**：设置页与行开关是两处入口，文案必须持续讲清各自语义（`src/client/locales.ts` 的 `mcp.mode.hint` 承担这件事）。

### D2 三种加载模式

- **结论**：
  - `eager`：允许的行照常挂载，不注册任何按需工具。
  - `dynamic`（默认）：允许的行默认不挂载；`mcp_load` 把 mcp-client 挂进**调用方 agent 的作用域**，工具原生注册。绑定质量最好，代价是工具列表每次加载变一次，请求缓存前缀随之失效。
  - `lazy`：允许的行默认不挂载；`mcp_load` 用 MCP SDK 直连且**不注册任何工具**，把工具 schema 作为结果返回，模型用固定的 `mcp_call` 代理调用。工具列表永不变，请求缓存前缀零失效。
- **理由**：默认值要覆盖大多数场景——既省 token，又保持原生工具绑定。`lazy` 的代理通道要求模型照抄 schema 里的参数，质量风险高于收益，因此不做默认。
- **被否决**：默认 `lazy`（把质量风险推给所有用户）；只留 `eager`/`lazy` 两档（丢掉原生绑定这一最有价值的中间态）。
- **代价**：`dynamic` 下每次 `mcp_load` 破坏一次前缀，长会话里这是真实成本；选择权交给用户。
- **实现**：[`src/lazy-mcp.ts`](../src/lazy-mcp.ts) 的 `registerMcpTools`，模式由 `parseMcpLoadingMode` 收敛（无法识别的存量值回退 `dynamic`，不因一个拼错的值让设置提交失败）。

### D3 注册落在 host 平面

- **结论**：按需工具在插件 `apply` 的 root ctx 上用 `ctx.effect` 注册，不做成 preset 行。
- **理由**：实测把注册做成 preset 行（`inject: ['tools']`，在 preset 的 standing 作用域里注册）后，**preset 每 ~5 秒被重挂一次**，MCP 子进程反复重启；撤掉即恢复。
- **代价**：注册的生命周期由插件自身管理——模式切换时 `dispose()` 旧注册再按新模式注册，交换对所有会话的下一次请求生效。

### D4 连接按会话隔离、随会话回收

- **结论**：`mounted` 是 `Map<agentId, Map<serverName, MountedServer>>`。同一会话重复 `mcp_load` 复用一份；不同会话各起一份（stdio 就是各一个子进程）；子 agent 与 fork 出的会话都算独立会话。`eager` 相反——preset 是 standing mount，全局共享一个实例。
- **理由**：一个会话加载的服务器不应把工具漏进别的会话的层；会话结束后也不该继续占着进程。
- **实现分野**：**native 载体**挂在 agent ctx 上，Cordis 随该 ctx 销毁一并回收；**proxy 载体**是裸 SDK client，不绑定任何作用域，`bindAgentScope` 在该会话第一次 load 时用 `agent.ctx.effect` 注册一次清理，`releaseAgent` 只 dispose proxy 载体（native 的 handle 属于正在销毁的那个 ctx，再调一次是多余的）。
- **代价**：同一服务器被多个会话并发使用时会有多份进程。

### D5 预加载闸门是事后纠正

- **结论**：`dynamic`/`lazy` 下"允许但不预加载"靠运行时摘行实现——读每个 preset 的**文件真值**得到 allowed，令 live 行满足 `mounted === (allowed && mode === 'eager')`，用 `entry.update({disabled})` 驱动挂载/卸载。
- **理由**：harness 的 `mcp-client` 在 `apply` 里立刻 spawn，插件没有"提前告知"的入口；事件驱动的事后纠正是不改 harness 时唯一可行的做法。
- **四条性质**（[`src/mcp-gate.ts`](../src/mcp-gate.ts)）：
  1. **不写文件**。preset 树是 `PresetTree`，`write()` 是空实现（agent-presets 的契约：preset 是输入不是持久化目标）。
  2. **全局行绝不动**。它们的树是 file-backed `Include`，`write()` 会把闸门状态写回配置，所以全局行恒为常驻挂载，不受加载模式影响。
  3. **触发点是 `tools/change`（无过滤广播）**，另订阅 `loader/entry-init` / `agent-preset/selected`；`reconcile()` 内部串行化、幂等、可重放。
  4. **一次 reconcile 会真的 kill 掉 MCP 子进程**，所以设置页先等 `gateState` 再读名册。
- **已知代价（本插件唯一需要 harness 配合的缺口）**：行是"先挂载、再被摘掉"的，所以每个 host 生命周期内 preset 首次挂载会有一次真实的启动+杀掉。要消除它，需要 harness 侧让 `mcp-client` 在 apply 早期就知道自己被抑制。
- **被否决**：在插件里拦截 spawn（越界）；改 `mcp-client`（不属于本插件的边界）。

### D6 工具过滤两点强制 + 强制代理载体

- **结论**：被隐藏的工具既不出现在 `mcp_load` 的结果里，也不能被 `mcp_call` 调用。
- **理由**：只做前者挡不住模型凭历史记忆直呼工具名。
- **强制代理**：配了规则的行走代理通道（`mode === 'lazy' || filterHidesAnything(filter)`），即使模式是 `dynamic`。因为 `dynamic` 的原生注册由 harness 的 `mcp-client` 全量挂载，插件拿不到单个工具的撤销权；`eager` 同理，所以 `eager` 下规则不生效并 warn。**这条决定了 `mcp_call` 在 `dynamic` 与 `lazy` 下都要注册**（只注册 `lazy` 是不够的）。
- **规则是活闭包**：`filterFor` 每次 load 现读，改规则对下一次 `mcp_load` 生效；已加载的服务器保持加载时那套工具（不追溯）。

### D7 结果里的 `hidden` 计数

- **结论**：`mcp_load` 的输出带 `hidden` 字段，render 里有一行提示。
- **理由**：模型需要知道"这台服务器还有工具但不可调用"，否则会照历史里的名字硬调，失败后无法归因。

## 先例：Claude 的 MCP 延迟加载

### 现状（Claude Code，2026-09-20 的文档口径）

tool search 默认开启：会话启动时进上下文的只有**工具名 + 服务器 instructions**（官方 context-window 页给的示意值是 ~120 tokens），完整 schema 不发。会退回**全量前置加载**的条件：

| 条件 | 行为 |
|---|---|
| `ANTHROPIC_BASE_URL` 指向非第一方主机 | 关闭 tool search（多数代理不转发 `tool_reference` 块） |
| Google Cloud Agent Platform 上 4.5 之前的模型 | 前缀加载（serving 栈拒绝 beta header） |
| Azure 上的 Microsoft Foundry 部署 | 服务端拒绝，SDK 检测到后改为前缀加载 |
| `ENABLE_TOOL_SEARCH=false` | 不延迟，每轮都带全部定义 |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | 强制关，`ENABLE_TOOL_SEARCH` 覆盖不了 |
| `ENABLE_TOOL_SEARCH=auto` / `auto:N` | 阈值模式：可延迟定义合计不到窗口的 10%（或 N%）就前置加载 |

另有两条相关能力：`alwaysLoad: true`（服务器级）或工具 `_meta["anthropic/alwaysLoad"]: true`（工具级）可豁免延迟；`MCP_DISCOVERY_CACHE` 让远端服务器**不连接**就给出工具列表（`/mcp` 显示 `cached … connects on first use`）。

**反例要记住**：claude.ai / 桌面端的 connectors 有 issue 报告"按需加载"开关并未真正延迟 schema，仍全量前置；旧版 Claude Code 也是全量。所以"Claude 已经不全量加载"只对 CLI / Agent SDK 这条线成立。

### API 机制（真正的"规范"）

1. 请求的 `tools` 数组仍带**全部工具的完整定义**，靠 `defer_loading: true` 标记哪些不进上下文；搜索工具自身必须非延迟，且至少有一个非延迟工具。
2. 客户端在 `tools` 里加一个服务端工具：`tool_search_tool_regex_20251119`（模型写 Python `re.search()` 风格正则）或 `tool_search_tool_bm25_20251119`（自然语言）。两者都检索工具名、描述、参数名、参数描述。
3. 模型调用它，返回 `server_tool_use`（`srvtoolu_…`）+ `tool_search_tool_result`，内容是 `tool_reference` 块（默认 5 个，模型可传 `limit`，1–10000）。
4. **API 就地展开** `tool_reference` 为完整定义，内联进对话，**system 前缀不动**——所以 prompt caching 保留；strict mode 的语法按全量工具集编译，与 defer 正交。
5. 续接要求：历史块原样回传，继续发同一份含全部延迟定义的 `tools`；**不要**给 `srvtoolu_…` 回 `tool_result`（400）；检索无匹配返回空数组而不是错误。
6. 边界：`defer_loading` 的工具不能同时带 `cache_control`（400）；MCP connector 场景在 `mcp_toolset.default_config` 或 per-tool `configs` 上设；**自定义检索是官方支持的逃生舱**——自己实现检索（含 embedding），在普通 `tool_result` 的 `content` 里返回 `tool_reference` 即可，被引用的工具仍需在顶层 `tools` 里有定义。
7. 动机数字：多服务器（GitHub + Slack + Sentry + Grafana + Splunk）全量约 55k tokens 定义，tool search 通常砍掉 85%+；超过 30–50 个工具后选择准确率下降。

### 与本插件三种模式的对照

| 维度 | Claude 的 tool search | `dynamic` | `lazy` |
|---|---|---|---|
| 未加载时的上下文 | 工具名 + instructions（约百 token） | 0（`mcp_list` 只列服务器名） | 0 |
| 定义何时进上下文 | 搜索结果内联 `tool_reference` | `mcp_load` 原生注册，进工具段（前缀断一次） | `mcp_load` 结果，作为对话内容 |
| 每轮是否仍发全部定义 | **是**（服务端要靠它展开引用） | 否 | 否 |
| 谁做检索 | 服务端 regex/BM25，或客户端自定义检索 | 模型自己选服务器 | 模型自己选服务器 |
| 粒度 | 单个工具 | 整台服务器 | 整台服务器（可叠规则过滤） |
| 缓存前缀 | 不破（前缀不动） | 每次 load 断一次 | 永不破 |
| 依赖 | 需支持 `tool_reference` 的模型 + 第一方 API | 纯 harness | 纯 harness |
| 服务器进程 | 发现缓存 / 首用才连 | 加载时才 spawn | 同左 |

### 可迁移结论

1. **前缀稳定优先于"少发请求"。** Claude 宁可每轮把全部定义发出去，也不动 system 前缀。我们的 `lazy` 更进一步（连定义都不发），`dynamic` 则每次 load 付一次前缀失效——这条支持 D2 把默认值留给用户而不是替用户选。
2. **粒度是下一个可优化维度。** Claude 是单工具检索；我们是整台服务器，所以一台几十个工具的服务器一次 `mcp_load` 仍把全部 schema 倒进历史——这正是 D6 的工具过滤要解决的问题，也说明过滤只是权宜，检索才是根治。
3. **检索可以自己做。** 官方明确允许自定义 search tool 返回 `tool_reference` 等价物；我们的 `mcp_call` 在结构上已经是这个形状，升级路径是把"选服务器"细化为"按查询检索工具"。
4. **"允许/进上下文"分离是共识。** Claude 用 `alwaysLoad` + `ENABLE_TOOL_SEARCH` 表达同一对正交输入，与本插件 D1 同构。
5. **隐藏必须在执行点强制。** Claude 的 `blocked` 工具是"模型看不见 + 调用被拒"，与 D6 同构。

### 不可直接照搬之处

- `tool_reference` 是 Anthropic API 的服务端能力，依赖第一方 API 与支持该块的模型；DSH 面向任意 provider，没有这个原语。
- 服务端检索的代价转移到了**请求体**：每轮都要发全部定义。受限网络或超大目录下不划算，我们的 `lazy` 恰好相反。
- `ToolSearch` / `WaitForMcpServers` / `MCP_DISCOVERY_CACHE` 是 Claude Code 的客户端私有行为，只能作设计参照，不构成接口。

## 待评估

功能次序、竞品证据与实现落点归 [competitive-landscape.md](competitive-landscape.md) 的路线图；
本页不再维护第二份待办清单，以免两处各自演化。

## 来源

- [Claude Code — Connect to tools via MCP](https://code.claude.com/docs/en/mcp)：Scale with MCP tool search / Configure tool search / Exempt a server from deferral / Server status detail。
- [Agent SDK — Scale to many tools with tool search](https://code.claude.com/docs/en/agent-sdk/tool-search)。
- [Messages API — Tool search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)：延迟加载、`tool_reference` 展开、Prompt caching、自定义实现。
- [Claude Code — Explore the context window](https://code.claude.com/docs/en/context-window)：`MCP tools (deferred)` 一项的 token 示意值与说明。
- 反例报告：[claude-ai-mcp#401](https://github.com/anthropics/claude-ai-mcp/issues/401)、[claude-code#49073](https://github.com/anthropics/claude-code/issues/49073)。
- 本插件实现：[AGENTS.md](../AGENTS.md)（延迟加载 / 预加载闸门 / 工具过滤）、[`src/lazy-mcp.ts`](../src/lazy-mcp.ts)、[`src/mcp-gate.ts`](../src/mcp-gate.ts)、[`src/mcp-tool-filter.ts`](../src/mcp-tool-filter.ts)。
