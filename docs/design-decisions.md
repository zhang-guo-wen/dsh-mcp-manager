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
| D4 | 连接进宿主级常驻池，按 claim 引用计数释放 | 一台服务器在宿主进程内只起一次、跨会话复用，没有会话再用时才停 |
| D5 | 预加载靠「发布点抑制 + 挂载前拦截 + late hold」三条路径 | 三种建立顺序都不 import 插件；全局行只在内存里拦，绝不写用户文件 |
| D6 | 工具过滤在返回与调用两点强制 | 只挡一处挡不住模型凭记忆直呼工具名 |
| D7 | `mcp_load` 结果带 `hidden` 计数 | 模型必须知道"还有工具但不可调用" |
| D8 | 载体由加载模式决定，规则与收窄只决定可见集合 | 模式才是「绑定 vs 缓存」的取舍；`mount` 载体已删除，`dynamic` 一律 `native` |
| D9 | 服务器清单进系统提示，不做成列目录工具 | 模型看不到名字就加载不了，而这段常驻成本可用预算封顶 |
| D10 | 名册读声明 + live fiber，不等任何行的激活 | 等激活等于把 MCP 子进程启动时间（实测 7.5–23s）算进设置页 |
| D11 | 全局行写 Include 的文件 + `refresh()`，不走 Loader 写回 | Loader 写回会把带补丁的树拍平进用户的 `cordis.yml` |
| D12 | 批量新增一次提交（`addMcps`） | 一次 preset 写入 = 该 preset 每台 MCP 重启一轮 |
| D13 | 资源仓库 MCP 经内存接口交给管理器 | 保留资源管理器的数据所有权，同时让加载模式统一生效 |
| D14 | 预设读取经公开 Loader/scope 接口，按代次保存声明 | 不依赖已移除导出，不等待激活，不把旧会话改成新声明 |
| D15 | 配置不完整是独立状态，与加载模式分开 | 「按需可用」是模式的结果，不是用户要处理的状态 |
| D16 | 优化策略粒度分三层，页内「上下文」页签（该页签 2026-10-16 改名「设置」，见 D24） | 规范只给分页与缓存提示，检索/分页/只带名称都得宿主侧做 |
| D17 | 「零拉起 + 宿主级常驻 + 引用计数」是一组取舍（2026-10-15） | 不用就不起、用过就留着、没人用才停（见下文 D17） |
| D18 | 共享目录是 `registerMcpTools` 的必传参数（2026-10-16） | 私有默认实例让设置页目录恒空、清空无效、模式重建丢发现结果；必传让漏接线变成编译错误 |
| D19 | 放弃等待的连接由 `connectLazyWithin` 收尸（2026-10-16） | `connectLazy` 的调用方拥有 client，但超时方收不到它；迟到的 client 必须自关，否则孤儿进程随搜索累积 |
| D20 | 池 claim 按次计数，并行加载收敛为一个视图（2026-10-16） | 按会话计数让一次并行加载共享一个计数、后到覆盖先到（注册与 claim 双双丢失）；按次令牌 + 先到者保留才对得上账 |
| D21 | file-backed 行的发布点接管走 late-hold 同序（2026-10-16） | 先处置后标记是 pitfall 42 的反序：嵌套 Include 的自处置分支会把闸门状态写进用户文件；遮蔽必须在前 |
| D22 | 名册一个平面不分分组，按行标注、按卡片编辑（2026-10-16） | 分组标题把「筛选」读成「隐藏」；卡片可点与「密钥」入口让每行少一次找按钮 |
| D23 | 传输层掉线归池感知：移出池 + 撤回视图 + 下次 `mcp_load` 重开（2026-10-16） | 旧行为只认「我们自己关掉的」一种结束，子进程崩溃后死连接被反复发出，只能重启宿主（见下文 D23） |
| D24 | 第二个页签命名「设置」并把加载方式移进去；名册不再自述开关语义（2026-10-16） | 加载方式与策略行都是页级偏好，名册页签只留列表与它的视图控件 |
| D25 | 密钥页只留标签、字段与状态句（2026-10-16） | 复述控件本身的说明是噪声；`!!js` 值的显示与写回是另一件事，未动 |
| D26 | 名册行去掉「编辑 / 密钥」按钮、状态排到平面标记之前、页内页签占满整列（2026-10-16） | 行内按钮与「点卡片」是同一件事的第二个入口；状态时有时无，夹在平面标记与按钮之间会把同行的元素推得每行都不一样 |
| D27 | 新增与导入的「平面 + 预设」两级下拉合成一个「落点」下拉（2026-10-16） | 全局肯定不是某个 agent，agent 也肯定不是全局，两级下拉是同一个问题的两个答案；第二级在第一级选「全局」时还是空转 |
| D28 | 必填字段打 `*`、服务器名按 JSON 自动填；行右侧平面标记改成 tab 样式的芯片并上下居中（2026-10-16） | 名册里名字与描述是两行，右侧那组贴着顶线就与下一行的开关错开；`standard` 是纯文字，读不出它是「这一行属于哪个范围」；名册里必填的字段没有任何标记，而名字本来就能从 JSON 推出来 |
| D29 | 删除「导入 Claude 配置」整条链路（2026-10-16） | 用户要求删掉；扫描 + 批量写入 + 导入弹窗 + 两个 Remote + 一套字典键都是为它存在的 |
| D30 | 工具列表按 token 展示、加载态居中；设置页删掉两句说明、加载方式占满整行（2026-10-16） | 工具列表原本只说"默认全部启用"，说不出取消勾选省了多少；等待塞在按钮文字里会把上方提示挤动；两句删除的描述都是控件的复述 |
| D31 | JSON 配置的校验结果显示在该字段的标签行上，鼠标失焦时才判（2026-10-16） | 一个读不出来的文档是**当场**能改的问题，报在表单底部的共用错误行里（还会被弹窗滚动裁掉）等于让用户去找；写一半的文档不该被判错 |
| D32 | 工具列表页去掉「加载工具列表」按钮：进页签即列举、表单变了才重列（2026-10-16） | 那一行只有它一个按钮时，下面的说明句会跟着上下掉一行；而"打开这一页"本来就是列举的触发点，按钮只是把同一件事再说一遍 |
| D33 | 没有可写 Include 时由插件自动创建（2026-10-27） | 默认 profile 只有宿主 root anchor，「全局」永远置灰等于半个功能不可用；创建自己的 Include 是唯一能落地全局行的形状，应由插件代劳 |
| D34 | 空态只留一句「还没有」，删掉解释句与平面按钮（2026-10-27） | 用户点名删掉；计数与落点筛选已经把「这一档是谁」说清，空态再复述一遍并给第二个新增入口是重复 |
| D35 | 所有 MCP 目录统一 SQLite 持久化，仅服务器类型按声明 TTL 或手动刷新（2026-10-28） | 去掉用户 TTL 偏好，目录状态紧随缓存标题；刷新不能启动本地进程 |

### D35 统一工具目录数据库

- **结论**：stdio 与 HTTP/SSE 全部写入 `profileContext.home/cache/dsh-mcp-manager/<sha256(profile.dir)>/catalog.sqlite`。不读旧JSON、不迁移/双写、不保留云端memory-only分支。探测成功须在RPC返回前写完，不保存声明；失败不影响用户直接保存。
- **新鲜度**：删除手动catalogTtlMs。stdio长期保存；HTTP仅按服务器ttlMs过期，下一次检索可限并发重新发现；没有ttlMs则由refreshCatalog按钮显式刷新当前启用HTTP/SSE，绝不启动本地进程。tools/list_changed仍使目录失效，重启不重置fetchedAt。0 TTL本次发现可回答当前请求，但不复用下一请求。
- **身份与安全**：SHA-256覆盖传输、namespace及连接配置，stdio纳入实际cwd/合并环境，HTTP纳入URL/排序headers；数据库只存摘要和公开工具定义，不存原始凭据。目录只供检索，实际调用仍开真实连接、仍先校验允许行与过滤规则。
- **写入**：Node内置SQLite，schema/user_version校验、短BEGIN IMMEDIATE事务与busy timeout，previous snapshot差异合并、共享clear generation拒绝旧writer复活；clear不删除数据库文件。500目录/32MiB逻辑payload上限，不承诺物理数据库页大小上限。坏库/未知schema拒绝覆盖、失败不假报成功，POSIX权限不等于Windows ACL。
- **UI**：目录状态直接位于工具目录缓存标题下；catalogState纯状态不联网，refreshCatalog才刷新服务器，clearCatalog清全部。失败保留旧目录并逐台提示；没有TTL输入和额外兼容开关。

### D1 允许与进上下文分离

- **结论**：composition 行上的 `disabled` 表示用户**允不允许用**（禁用 = 完全不用：不进系统提示里的按需清单，`mcp_load` 拒绝）；`mcp-manager.loading` 表示允许的服务器**什么时候进上下文**。
- **理由**：服务器实际有三态——不用 / 可用但按需 / 常驻。两个正交输入能表达全部三态，且 UI 能把"已配置但未运行"如实显示出来。
- **被否决**：把"不预加载"编码成 `disabled`。那样"允许但按需"无法表达，用户也无法从界面区分"我关掉了它"和"它按需可用"。
- **代价**：设置页与行开关是两处入口，文案必须持续讲清各自语义（`src/client/locales.ts` 的 `mcp.mode.hint` 承担这件事）。

### D2 三种加载模式

- **结论**：
  - `eager`：允许的行照常挂载（由组合/harness 的 mcp-client 挂），不注册任何按需工具。
  - `dynamic`（默认）：允许的行默认不挂载；`mcp_load` 用 MCP SDK 直连**宿主级常驻池**里的那条连接（D4），把**可见工具**用 harness 的适配器原生注册进**调用方 agent 的作用域**（`agent.ctx.get('tools')`）。绑定质量最好，代价是工具列表每次加载变一次，请求缓存前缀随之失效。工具过滤规则与 `query` / `tool` 收窄只决定**注册哪些定义**（见 D8、D16），载体不变。
  - `lazy`：允许的行默认不挂载；同样走池的 SDK 直连，但**不注册任何工具**，把工具 schema 作为结果返回，模型用固定的 `mcp_call` 代理调用。工具列表永不变，请求缓存前缀零失效。
- **理由**：默认值要覆盖大多数场景——既省 token，又保持原生工具绑定。`lazy` 的代理通道要求模型照抄 schema 里的参数，质量风险高于收益，因此不做默认。
- **被否决**：默认 `lazy`（把质量风险推给所有用户）；只留 `eager`/`lazy` 两档（丢掉原生绑定这一最有价值的中间态）；让 `dynamic` 的"整台加载"走 harness 挂载而收窄的走插件注册（同一个模式两种代价，见 D8 的被否决 1）。
- **代价**：`dynamic` 下每次 `mcp_load` 破坏一次前缀，长会话里这是真实成本；选择权交给用户。按需模式（`dynamic` / `lazy`）拿不到 server instructions 与 `mcp-resources` 工具（D8 的已知代价）。
- **实现**：[`src/lazy-mcp.ts`](../src/lazy-mcp.ts) 的 `registerMcpTools`，模式由 `parseMcpLoadingMode` 收敛（无法识别的存量值回退 `dynamic`，不因一个拼错的值让设置提交失败）；三个模式是否注册按需工具、是否注册 `mcp_call` / `mcp_search` 由 `carrierFor`（[`src/mcp-carrier.ts`](../src/mcp-carrier.ts)）与 `mcpRegistrationKey(policy)` 决定。

### D3 注册落在 host 平面

- **结论**：按需工具在插件 `apply` 的 root ctx 上用 `ctx.effect` 注册，不做成 preset 行。
- **理由**：实测把注册做成 preset 行（`inject: ['tools']`，在 preset 的 standing 作用域里注册）后，**preset 每 ~5 秒被重挂一次**，MCP 子进程反复重启；撤掉即恢复。
- **代价**：注册的生命周期由插件自身管理——模式切换时 `dispose()` 旧注册再按新模式注册，交换对所有会话的下一次请求生效。

### D4 连接进宿主级常驻池，按 claim 引用计数释放

- **结论**：连接**属于宿主，不属于加载它的会话**。池（[`src/mcp-pool.ts`](../src/mcp-pool.ts) 的 `createMcpConnectionPool`）按「行身份 + 连接配置指纹」去重：键是 `rowKey`（`preset:<id>:<name>` / `global:<name>`）拼上 `connectionFingerprint(config)`（transport / serverName / command / args / env / cwd / url / headers 的 SHA-256 前 16 位十六进制）。同一台服务器的后续加载——同一会话、别的会话、子代理——**复用同一条连接**（stdio 就是同一个子进程）。
  每个会话对条目持有一个 **claim**：
  - `mcp_load` 命中已有条目直接复用（不重连）；`native` 载体在该 agent 的 tools 上重建**这一代**注册，`proxy` 载体按会话保留 `tools` / `hidden` 视图。
  - `mcp_unload` 只释放**调用方那个会话**的 claim，返回三个字段：`released=false`（本会话没加载过）/ `released=true, stopped=true`（最后一个引用，连接已停）/ `released=true, stopped=false`（别的会话仍在用，连接保留）。
  - 会话销毁（`bindAgentScope` 用 `agent.ctx.effect` 注册一次清理，每个会话只注册一次）同样只释放该会话的 claim；**最后一个 claim 释放时才关闭连接**。
- **存活语义**：连接在宿主进程内保持，直到最后一个会话释放引用、**提交了不同的加载模式**（工具面重建、该模式的引用释放，无人再持有时停止）、或插件卸载。常驻 = **宿主进程生命周期内**，**不是**跨宿主重启持久化——宿主重启后要重新 `mcp_load`；而"启动与声明重建永不 spawn"是无条件的（见 D5、D17）。
- **理由**：旧行为在两头都反着来——没加载时启动又杀掉子进程；加载过的服务器在会话结束时被回收，下一个会话又要等一次冷启（`npx -y` 实测 7.5–23 秒）。而 MCP 服务器是**进程级资源**，"谁加载的"与"谁在用"本来就是两件事：连接共享不代表工具泄漏——工具注册仍然落在**调用方 agent 作用域**（D3、D8）。
- **被否决**：
  1. **每会话一份连接 + 延迟回收**（旧行为）：`npx -y` 冷启 7.5–23 秒，第二个会话复用不上就等于每次会话都付一遍；再叠一个"延迟回收定时器"只是在给错误的粒度打补丁。
  2. **给池加空闲 TTL**（5 分钟级）：没有需求支撑，而且会把"用过就留着"改成"过一会儿再付一次冷启"；留在路线图的待评估项（competitive-landscape P1）。
  3. **让池跨宿主重启持久化**（守护进程 / 开机自启）：超出插件边界，也绕开组合行的授权语义。
- **代价 / 边界**：
  - 一份进程被多个会话共享：服务器自身崩溃或挂死会影响**所有**持有它的会话（旧行为下各会话相互隔离）。
  - 连接配置变化会开出**新条目**，旧连接继续服务仍在用它的会话；指纹只进键与日志，**`env` / `headers` 的值不落日志、不进错误消息**。
  - 池的操作串行化：两个会话同时加载同一台不会开出两条连接。
  - 模式切换会重建工具面并释放该模式的 claim，届时无人再持有的连接才停止——这是既定语义，不是常驻失效。
- **实现**：`src/mcp-pool.ts`（纯 Map + `node:crypto`，不 import harness 包，vitest 直接跑）；`mcp_load` / `mcp_unload` / `mcp_call` 的接线在 [`src/lazy-mcp.ts`](../src/lazy-mcp.ts)，会话清理在 `bindAgentScope`。
- **测试**：`tests/mcp-pool.spec.ts`（指纹去重、claim 引用计数、最后一个引用关闭、配置变化开新条目）、`tests/on-demand-pool.harness.spec.ts`（真实 Loader/registry 下两个会话只 `opened === 1`、会话销毁后连接存活、末位释放才关闭、切回 `eager` 能恢复挂载）。

### D5 预加载靠三条抑制路径，都不写文件

- **结论**：`dynamic`/`lazy` 下"允许但不预加载"覆盖**两个平面**（preset 行与全局行），靠**三条互补的路径**完成，任一条都不写文件：
  - **(a) 发布点抑制**（行在本插件 `apply` 之后才发布）：gate 订阅 Cordis 的 `internal/plugin`，在 fiber 发布那一刻**同步** `fiber.dispose()`。Cordis 在发布之后才解析依赖并激活，被处置的 fiber 直接跳过激活——**`mcp-client` 的 `apply` 从不执行，子进程不会 spawn**。**只对 preset 行用这条**：`vendor/loader/src/index.ts:160-165` 在 fiber 自处置时会 `entry.options.disabled = true` + `entry.parent.tree.write()`，全局行的树正是 file-backed `Include`，**会把闸门状态写回用户的 `cordis.yml`**。
  - **(b) 挂载前拦截**（行在本插件 `apply` 之前就已建好：Loader 先把组合里的 entry 全建出来，再逐个 import 插件，这段窗口没有发布可观察）：`index.ts` 在 `apply` **第一条语句**同步订阅 `loader/entry-init`，交给 `gate.onEntryInit(entry)`。`holdBeforeMount` 只在**这一个 entry 实例**上遮蔽 `disabled` 自身属性（不动声明）、并拦截它**第一次 `update()`**——Loader 正是用 `update` 赋 options、紧接着 import 插件（options 取自该次调用的入参），所以在 update 里确认 `options.name === '@deepseek-ai/dsh-mcp-client'` 再判归属，命中就让 `update` 直接 return，**插件从不被 import**；不是本插件的行立即还原（无副作用）。**file-backed Include 子树里的全局行走这条；写在组合本身里的全局行走 (c)。**
  - **(c) late hold**（全局行的兜底：行写在**组合本身**里——root anchor 或补丁层 `insert`——Loader 在本插件 import 之前就把它建好并 import 完了）：`run()` 在 `!wantMounted && !held && mounted` 时由 `holdMountedGlobal(entry)` 事后接管。**顺序是硬要求：先 `Object.defineProperty` 遮蔽 `disabled`，再 `fiber.dispose()`**——自处置分支只在 entry 已读作 disabled 时才不落盘。切回 `eager` 由 `releaseGlobalHold` 撤销遮蔽；`Entry.update` 不写文件。
- **归属判据分两种树**：preset tree 用三层判定（reader 快照 / entry 祖先链找 `AGENT_PRESET_MODULE` / `scopes.scopeOf(tree.ctx) !== undefined`）；全局 tree 用 `isGlobalPlaneTree`＝有字符串 `filename` 且 `write` 是函数（file-backed `Include` 的特征），`ownsGlobalTree` 额外接受 owner 名为 `cordis:include` / `@deepseek-ai/cordis-plugin-include` 的树。**不能用 `ctx === undefined` 判定**——`EntryTree` 基类给每棵树都设了 `ctx`（第一版就是这么错的）；preset tree 没有 `filename`。
- **触发点**：`tools/change`、`loader/entry-init`、`loader/partial-dispose`、相关 `internal/status`、`agent-preset/selected` 都使快照失效；`reconcile()` 内部串行化、幂等、可重放。**另有两处"取行集合变化"必须自己上报**：`createMcpPreloadGate(..., onRowTaken)` 与 `createPresetMountReader(ctx, scopes, onCaptured)`，`index.ts` 据此 `queueMicrotask(resync)`——被 hold 的行**没有 fiber**，靠 fiber 状态事件驱动清单刷新会让系统提示里的 MCP 清单**一直为空**（真实回归）。
- **抑制不是闩锁**：切回 `eager` 后同一行要能重新挂载。preset 行由 `reconcile()` 在 `wantMounted` 分支先 `releasePreHeldRow(leaf)` 还原遮蔽与 `update` 拦截、再 `entry.update({disabled:false})`；全局行走 `releaseGlobalHold(entryId)`。**这条有真实反面案例**：只还原 `entry.disabled` 而漏掉遮蔽时，该行 `entry.disabled` 恒为 true，静默死亡直到宿主重启。
- **抑制是一等状态**：被抑制的行 fiber/状态都可能读成"已停止"，所以 gate 单独登记 `suppressedEntryIds()`，名册据此报 `fiberPhase: 'held'`（D10）。全局行的 `enabled` 必须读**声明** `entry.options.disabled !== true`，不能读被自己遮蔽的实例 getter——否则被 hold 的行会被读成"用户禁用"，`mcp_load` 直接拒绝（verify-instance 实测到的 G2 缺陷）。
- **理由**：harness 的 `mcp-client` 在 `apply` 里立刻 spawn，事后纠正总是慢一步；但 fiber 的**发布点**比 `apply` 更早，而 `internal/plugin` 是 Cordis 自己的扩展点。发布点仍漏掉"行在本插件 `apply` 之前建好"的顺序（真实 profile 里 `mcp-manager` 行声明在 preset 之前，bundle 层补丁即如此），所以补 (b)；写在组合本身里的全局行连这个窗口都没有，补 (c)。**三条路径都不需要改 harness。**
- **被否决**：
  1. **继续事后纠正**（挂载后再 `entry.update({disabled})`）：每次宿主启动与声明重建都会真的启动再杀掉一轮子进程，代价随行数放大，用户看得见。
  2. **抢在 `import` 阶段拦截**（不加载 mcp-client 模块、不建 fiber）：`Entry._init()` 走完 import 与 fiber 创建是 Loader 的内部流程，插件只能观察不能改写。
  3. **改 harness 的 `mcp-client`**（让它自己知道被抑制）：跨包改 + 发版，插件随之依赖新版本 harness。
  4. **对全局行也用发布点处置**：fiber 自处置会把 `disabled` 写回用户的组合文件（见 (a) 的理由）。
  5. **用 `ctx === undefined` 认全局树**：`EntryTree` 基类给每棵树都设了 `ctx`，这个判据永远为假。
  6. **late hold 先 dispose 再遮蔽**：自处置分支看到 entry 还没读作 disabled，就会把闸门状态写回用户文件。
  7. **让全局行继续"始终挂载"**：与本决策冲突（全局行同样跟随加载方式），也与 D17 的按需语义冲突。
- **已知代价 / 边界**：
  - 依赖 Cordis"发布点早于激活"这一时序，以及 Loader 用 `update` 赋 options、自处置分支的落盘条件；升级 harness / cordis 后要重跑 `fiber-publication` 与 `global-zero-launch`（5 项）。
  - 两种全局行形状的差别（实测）：放在**独立的 file-backed Include 文件**里→(b) 直接挡住，**连插件回调都不发生**；写在**组合本身**里→(c) 事后接管，`mcp-client` 的 `apply` 会被调用一次，**但没有留下子进程**（"形状 B 会多起一个子进程"在真实实例上不成立）。**推荐形状 A**。
  - 一次 `reconcile()` 会真的 kill 掉 MCP 子进程（`entry.update` 走 `Entry._dispose`），所以设置页先等 `gateState`（它内部 await reconcile）再读名册，否则会看到"摘到一半"的名册。
  - 配置不完整的行也不挂载，与"模式不预加载"共用同一条摘行路径（D15）。
- **证据级别（2026-10-15）**：
  - **harness 真实组合回归**：`npm run test:harness` **6 文件 / 25 项通过**——`zero-launch`（4 项）断言 `dynamic` 下 preset 行的 `mcp-client` 回调执行 **0 次**（`eager` 对照 1 次、声明重建后仍 0），含 `holds a row that was declared before the plugin activated`（(b) 路径）；`global-zero-launch`（5 项）覆盖全局行：非 `eager` 下不被 import、`eager` 下照常挂载、被 hold 的行能按需加载、组合已挂载的行由 **(c) late hold** 接管（先遮蔽再 dispose）、切回 `eager` 后连用户文件一起完好。
  - **单元 / Cordis 层**：`tests/mcp-gate.spec.ts` 的挂载前拦截用例与全局行读取用例；`tests/fiber-publication.spec.ts` 固定"发布点处置 → `apply` 不执行"；`tests/mcp-row-state.spec.ts` 固定"明确 `false` 压过 `suppressed` 兜底"。
  - **隔离实例端到端（真实宿主）**：**读数是最终产物 `lib/index.mjs` = `121B8C0A…` / `lib/client.js` = `E1B1051A…`**，宿主 `@deepseek-ai/dsh@0.2.0-rc.2`（隔离 `DSH_HOME`）——`dynamic` 启动后 marker 文件从未创建、进程 0、stderr 为空；两种全局行形状经 1 秒采样复测都是零拉起；`eager` 对照长期存活；多次 `mcp_load` 复用同一条子进程。较早产物 `9B5D8D19…` / `D498FEC7…` 的读数保留在 [testing.md](testing.md) 里作为历史，不再代表当前产物。
  - **验证基线口径**：`0.2.0-rc.2` 就是 npm 上的 `latest` / `next`，也是日常实例实际运行的宿主版本——**实测版本 = 正在使用的版本**。较早的一次兼容性验证在 `0.2.1-alpha.1`（2026-10-07 提交 `19d02aa`，针对 `livePresetMounts` 移除的适配）；该 `alpha` tag 现为 `0.2.1-alpha.4`，本次两条线合并**未**在 alpha 线上复跑（也**不**表示 alpha 线失效，只是没有新读数）。
  - 原始读数与复现命令见 [testing.md](testing.md)。

### D6 工具过滤两点强制

- **结论**：被隐藏的工具既不出现在 `mcp_load` 的结果里，也不能被 `mcp_call` 调用。
- **理由**：只做前者挡不住模型凭历史记忆直呼工具名。
- **两点各自的适用范围**：代理载体（`lazy`）两点都需要——`mcp_call` 的入参校验是它唯一的闸门；原生载体（`dynamic`）在
  `mcp_load` 的返回处过滤，隐藏的工具**根本没有注册**，`mcp_call` 对这类行直接拒绝（工具按名字调用，不在列表里就是不存在）。
- **`mcp_call` 只在 `lazy` 下注册**：那个模式不注册任何工具，代理是唯一的调用通道；`dynamic` 下加载进来的工具按公开名直接调，所以默认模式的工具面只有 `mcp_load` + `mcp_unload`。
- **规则是活闭包**：`filterFor` 每次 load 现读，改规则对下一次 `mcp_load` 生效；已加载的服务器保持加载时那套工具（不追溯），
  服务器自己发 `tools/list_changed` 时也按**加载时那套规则**重新同步。

### D7 结果里的 `hidden` 计数

- **结论**：`mcp_load` 的输出带 `hidden` 字段，render 里有一行提示。
- **理由**：模型需要知道"这台服务器还有工具但不可调用"，否则会照历史里的名字硬调，失败后无法归因。

### D8 载体由加载模式决定，`mount` 已删除

- **结论**：`carrierFor(mode, _filter, _narrowed)` 只返回三种结果：`lazy` → `proxy`；`dynamic` → **`native`**；`eager` → `undefined`（整台交给 harness 的 mcp-client 常驻挂载，规则不生效并 warn）。**规则与 `query` / `tool` 收窄只决定注册哪些定义，不决定载体**——`narrowed` 参数只为调用点兼容保留，它不能改变载体。
- **`mount` 载体已删除**。它把整台服务器交给 harness 的 `mcp-client` 挂进调用方 agent 作用域，而那个插件**按挂载作用域连接**：per-session 挂载必然得到 per-session 子进程，与「一台服务器在宿主内只起一次、跨会话复用」（D4）不可兼得。`native` 与原生挂载共用同一个适配器（`createMcpToolDefinition`），绑定质量不变。
- **理由**：模式回答的正是「绑定质量 ↔ 缓存与 token」这个取舍（D2）。旧实现让"配了规则"把行从原生踢到代理，等于用一条可见性设置替用户改了代价模型；而"整台加载走 mount、收窄加载走 native"是同一个毛病的另一种形态——同一个 `dynamic` 模式两种代价，用户不读文档根本不知道。改完之后 `dynamic` 只有一条路径：**SDK 直连常驻池的连接 → `listTools` → 过滤/收窄 → 原生注册进调用方 agent 作用域**，差别只在注册哪些定义。
- **实现**：[`src/mcp-carrier.ts`](../src/mcp-carrier.ts) 的 `carrierFor`；`nativeDefinitions` / `swapNativeTools` 用 harness 自己的 `createMcpToolDefinition`（`@deepseek-ai/dsh-mcp-client` 的公开根导出，经 loader 取同一实例）造定义，注册进 `agent.ctx.get('tools')`。注册代次按公开名字做 diff 替换：新增的先注册、消失的最后撤销、存活的名字保持原注册。工具名必须用 `mcpToolPublicName` 复刻 mcp-client 的命名契约，否则 `mcp__<serverName>__` 前缀的 toolview 与命名空间会失准。
- **被否决**：
  1. **「配了规则/收窄就换载体」**：隐式改代价，用户无法预期（旧实现的实测教训）。
  2. **保留 `mount` 作为"整台加载"的快速路径**：与本插件自己的常驻池直接冲突（两个进程并存），也是这一轮删掉它的原因。
  3. **改 harness 的 `mcp-client` 加工具过滤字段**：语义上最正，但要跨包改并发版；适配器已是公开导出，插件侧能拿到同样的绑定质量。
  4. **`agent.ctx.tools.restrict({ deny })` 事后遮罩**：它拒绝 scope-local 名字，而原生载体的工具正是 scope-local 的。
- **已知代价（如实记录，不隐去）**：
  - 按需加载（`dynamic` / `lazy`）绕开了 mcp-client，**拿不到 server instructions 与 `mcp-resources` 的共享资源工具**。工具本身的参数绑定、结果、错误与图片呈现与原生挂载一致（同一个适配器）。这是删掉 `mount` 载体换来的：以前只有"过滤行"付这份代价，现在所有按需行都付；要 resources，把该行放到 preset 并选 `eager`。
  - 同一条 `mcp__<serverName>__` 命名空间在同一作用域只能有一个载体占着：同一 (会话, server) 的载体互斥，换载体 / 重载前必须先释放旧的一代。
  - `tools/list_changed` 的重同步由**池装在连接上的 `fallbackNotificationHandler`** 扇出到各会话视图（`resyncView` 不再逐视图串行；池自己的重新列目录是串行的），且**目录只由 `mcp_load` 的发现路径写回，重同步不回写目录缓存**——所以重同步只保证"已加载的会话看到新集合"，不会让缓存悄悄变新。
  - 服务器换工具列表时按**加载时那套规则**重新同步，不重新读设置（与 D6 一致）。

### D9 服务器清单进系统提示

- **结论**：`dynamic`/`lazy` 下，可加载的服务器清单作为一段系统提示出版（`MCP_SERVERS` 位置）：每台一行
  `- <名称> — <用户在设置页写的描述>`，配一句用法说明。原先的 `mcp_list` 工具删掉，它的内容就是这段清单。
- **理由**：按需模式下没有任何 MCP 工具 schema 在请求里，**模型不知道名字就永远加载不了任何服务器**；而列目录工具是
  "为了知道有什么，先花一次工具调用和一轮往返"，对每次会话都要做的事不划算。清单常驻换来的是零往返 + 名字始终可见。
  同时它把工具面从 4 个降到 `dynamic` 2 个 / `lazy` 3 个（优化页打开检索时各多一个 `mcp_search`，见 D16）。
- **成本**：常驻 token 由预算封顶 —— 单条描述截断 80 字符、整段描述预算 900 字符，**名字永远列全**（宁可丢描述，
  也不让一台服务器变得不可加载）。实测本机 4 台服务器约 70 token，与删掉 `mcp_list` 的定义大致相抵。
- **不写加载状态**：那会让每次 `mcp_load` 都重写系统提示，把系统 + 工具 + 历史整个前缀打断一次，比工具列表变化贵得多；
  而"已经加载了什么"本来就在会话历史里。
- **被否决**：
  1. **保留 `mcp_list`、清单不进提示**：模型每次都得先问一次，且清单在压缩后可能丢失，等于把加载能力建立在一次调用上。
  2. **清单里带 scope（`global` / `preset <id>`）**：那是组合词汇，不是模型需要判断的东西；`mcp_load` 只吃名字。
  3. **清单里列每台服务器的工具名**：工具名的规模随服务器增长，正是要避免的部分；工具集合在 `mcp_load` 的结果里。
- **实现**：[`src/mcp-inventory.ts`](../src/mcp-inventory.ts) 的纯渲染器 + `registerMcpTools` 的注册句柄；
  段文本是快照，`refresh()` 在每次 `gate.reconcile()` 与模式提交后重算（见 AGENTS.md 的「按需清单」）。
- **代价**：系统提示里多一段"配置相关"的文本；描述是用户手写的，所以**它现在会到达模型**（设置页的文案与
  `settings.ts` 的契约同步改了）。

### D10 名册读声明 + live fiber，不等激活

- **结论**：设置页的名册由插件自己的 `mcpManager.listMcps`（[`src/mcp-roster.ts`](../src/mcp-roster.ts)）回答：全局行由 `gate.globalRows()` 提供（从 Include 子树递归读，按 entryId 去重），preset 行优先来自 live mount 树的 entry、没挂载时退回该代次声明；**`enabled` 一律读声明**（全局行读 `entry.options.disabled !== true`，preset 行读该代次声明而非 live 行的 `!entry.disabled`），`fiberPhase` 取 live fiber；被抑制的行报 `held`（`gate.suppressedEntryIds()`）。**任何一处都不 await 激活。**
- **理由**：名册原先来自 `remote.pluginInventory.list`，它经 agent-preset registry 的
  `compositionInventory()` → `diagnostic()` → `auditRows()`，而 `auditRows` 会 `tree.await()` 并逐行
  `fiber.await()`。MCP 行的 `apply` 要等子进程完成握手，本机实测 `cmd /c npx -y @upstash/context7-mcp`
  冷启 23.3 秒 / 热启 7.5 秒，`alibabacloud-devops-mcp-server` 8.4 秒；同一次实测里 `loader.create()` 3 毫秒返回、
  紧接着的 `loader.await()` 等了 5004 毫秒。也就是说：**谁 await 激活，谁就把子进程启动时间算进设置页**——
  打开页面、每次新增/开关/导入后的刷新都会卡这么久。
- **被否决**：
  1. **继续用 `pluginInventory.list`，只在前端做乐观刷新**：前端只能藏住等待，名册内容仍然要等激活；
     而且撤销一个 `await` 比在 UI 上打补丁小。
  2. **给名册加缓存**：缓存要自己维护失效点，而声明与 live fiber 本来就同步可读，没有需要缓存的慢读。
- **代价**：preset 未挂载（声明读）时 `!!js` 的 `disabled` 无法求值，报 `conditional` 而不是猜；
  group 的 `disabled` 继承规则在本模块复刻了一份（镜像 Loader 的语义，见 AGENTS.md 的「名册读取」）。
- **两个"被抑制"不是一回事（本轮 bug 的根源）**：`gate.suppressedKeys()` 回答的是"模式正在扣住一个**用户允许**的行"，
  只作设置页的兜底标志，且**被用户停用的行必须退出它**；`gate.suppressedEntryIds()` 回答的是"闸门此刻实际扣住了
  哪些行"，名册据此报 `fiberPhase: 'held'`（D15：不给它加任何标记）。把前者当用户意图的后果是：运行中停用一行后，
  开关仍显示"已启用"，再点只是把 `disabled: true` 重复写一次（幂等 no-op），只有重启实例才显示正确。
  客户端侧的对应规则是 `rowAllowed(enabled, suppressed)`（`src/client/mcp-row-state.ts`，不依赖 React 的纯模块）：
  **Host 明确的 `enabled: false` 优先于兜底标志**。
- **行级只读是第二个判据**：平面可写 ≠ 这一行可写。全局行只有在该行 id 出现在那个可写 Include 的**文件行**里时
  才可写；组合或补丁层声明的行报 `readOnly: 'composed-row'`（平面的问题报 `no-writable-include` /
  `several-writable-includes` / `unreadable-include`）。客户端置灰并说明原因，服务端同时以 `mcp/read-only` 拒绝。

### D11 全局行写文件 + 重读 Include

- **结论**：全局平面的写（新增 / 编辑 / 开关）改 **file-backed Include 自己的文件**（`writeEntryListFile`，
  只写用户自己的行列表），然后调 `Include.refresh()` 让组合重读该文件并重新套用补丁层；**不再用
  `loader.create` / `loader.update`**。
- **可写判据（本轮修正）**：`globalWritable` = 组合里是否**恰好挂着一个用户自己的** file-backed Include。
  `writableGlobalIncludes` **排除宿主的 root anchor**（`app-boot` 固定 Loader id `include` →
  `$DSH_HOME/profiles/<profile>/cordis.yml`，`prepareProfile` 每次启动把它重写成空模板）：把它算进来时，
  "profile 自己声明了一个 Include"的组合会被读成两个 Include，整个平面被判只读。排除之后，**推荐形状 A
  （行写在自己的 Include 文件里）可以真正开关全局行**；只有 anchor → 只读；≥2 个用户 Include → 仍拒绝
  （定不出文件）；唯一那个文件读不出 → `unreadable-include`。行级再判一次文件行（见 D10）。
- **理由**：`loader.create` / `loader.update` 会走到 `EntryTree` 的写回，`Include.write()` 把**带过补丁的树**
  序列化回文件——bundle 层与用户补丁层被拍平进用户的 `cordis.yml`。旧版为避免这一点把全局平面判为只读，
  于是 CLI 默认 profile 里"新增到全局"必然失败。改文件 + `refresh()` 既保住分层，又当场生效（不需要重启）。
- **被否决**：
  1. **维持只读，导流到 preset**：全局平面本来就是这个组合的合法入口，用户明确要求能写；
  2. **把新行插进 profile patch 的顶层 `insert:`**：那要插件自己实现 `configEditor` 的 YAML 文档事务
     （`!!js` 标签、锁、回滚），而 `cordis.yml` 的 Include 就是为此存在的；
  3. **写文件后用 `loader.create` 补一次挂载**：那正是会拍平的那一步；
  4. **把 root anchor 也当成可写目标**：它的文件每次启动都被宿主重写，写进去等于写进一个会被丢弃的模板。
- **代价（如实记录）**：`writeEntryListFile` 用 `yaml.dump` **整表重写**文件，所以**用户文件里的注释会丢**、
  引号风格被规范化、启用后的行会留下显式的 `disabled: false`（实测 1247B → 942B）。功能正确
  （`disabled: true` 确实被移除、行当场生效），但**不回到逐字节原样**——是否改成"只改该行的 `disabled` 键"
  待定。写入后做一次"行确实挂上了"的校验，校验失败就报错而不是假装成功。
- **一次性异常（未复现，不要当成已解决）**：某一轮里 root anchor 曾被写成 46973B 的完整组合树——正是
  "Loader 树的写回把组合烘进 anchor"的形态。此后四次对照（纯运行 / 完整往返六时点 / 两实例并发共用
  `DSH_HOME` / 又一次纯运行）**全部复现不出**，anchor 始终 223B，而且宿主每次启动都会重写它。它**不波及
  用户自己的 Include**（那些文件的内容与行都在），所以按"观察到一次、未能复现、有自愈行为"记录。
- **实现**：`src/mcp-remote.ts` 的 `writeGlobalRow` / `writeGlobalOne`；行查找不能走 `loader.resolve`
  （它只看根 store），见 AGENTS.md 的「MCP 行编写」。

### D12 批量新增走一次写

- **结论**：导入这类批量写入走 `addMcps`（[`src/mcp-remote.ts`](../src/mcp-remote.ts)）：整批**一次 patch 提交**，
  逐行校验、逐行报结果（`outcomes[].entryId === null` + `reason`）。单行编辑仍走 `addMcp`。
- **理由**：一次 preset 写入 = 该 preset 的声明行重建 = 里面**每一台** MCP 重新挂载并重启子进程。导入 N 台按
  `addMcp` 循环就是 N 轮全量重启，本机实测 `cmd /c npx -y …` 一台 7.5–23 秒，四台就是分钟级——用户看到的就是
  "导入卡住"。一次提交把 N 轮压成 1 轮。
- **被否决**：
  1. **前端并发发 N 个 `addMcp`**：Host 侧 `enqueue` 本就串行化写，重挂次数不变；
  2. **只按"逐行失败不中断"的旧要求做单行循环**：那条要求是**报错粒度**，`outcomes` 同样满足它，不必用 N 次写入换。
- **代价**：一个 preset 里若有一条与批次中某行同名的行，冲突检测要同时覆盖"声明里已有的"和"本批次内的"
  （两处都做了）；批内任一行在锁定文件后仍冲突时，会把整批标成失败（保守，不部分写）。
- **实现**：`addMany` / `writeGlobalBatch` / `writePresetBatch`；客户端一次调用，全部成功即关窗，有失败才留在
  弹窗里逐条列出（见 AGENTS.md 的「导入 Claude 配置」）。
  **（2026-10-16 更新：这条路径随「导入 Claude 配置」一起删除，见 D29；D12 的取舍本身仍成立，重做导入时照它做。）**

### D13 资源仓库 MCP 的内存交接

- **结论**：`dsh-resource-manager` 保留仓库同步、文件校验、凭据和 Agent 作用域，向运行中的 `mcpManager` 服务提交已解析的 MCP 定义。管理器持有定义，并让这些定义走**宿主级常驻池**（D4）：`dynamic` / `lazy` 时加入按需清单并由 `mcp_load` 加载；不改写用户组合文件。
- **理由**：资源管理器原先直接 `ctx.plugin(mcp-client)`，这条路径绕过组合行闸门，无法响应加载方式。强行把资源写进 profile patch 会混淆仓库来源与用户配置，还会触发 preset 整体重挂。
- **作用域**：全局资源对所有 Agent 可见；Agent 资源只有在调用方 scope 链包含资源所属的 preset scope 时可见。Agent scope 不可辨认时拒绝托管，防止专属 MCP 泄漏给别的 Agent。
- **切换**：交接前释放资源管理器旧连接。管理器更换定义时释放受影响的按需引用（claim）；切换加载方式时先释放旧模式的 claim、再按新模式注册（无人再持有的连接随之停止，D4）。管理器离线时资源管理器恢复原有直接加载。
- **界面**：资源管理器的 MCP Tab 展示托管状态及当前模式；资源配置与密钥仍从该页维护。管理器的组合行编辑器不把内存定义写回用户配置。

### D14 新注册表的预设代次适配（2026-10-07）

- **结论**：移除顶层 `livePresetMounts` 导入。通过 `ctx.registry.values()` 的 live fibers 及 `entry.parent.tree` 定位 Loader 树；使用宿主内部解析得到的 `createScope` 创建短命、空的父 scope 探针，交给 `agentPresets.composedPreset` 读取身份，随即销毁。不读注册表私有 generations/bindings，不给真实 Agent 重组。
- **代次**：gate 首次接触树时保存不含连接凭据的声明元数据，按每代自己的祖先 `disabled` 和 Loader `evaluate` 判断允许状态。恢复 `eager` 前等待旧 fiber 的卸载收尾，避免旧连接尚未关闭就挂新连接。root-local WeakMap / WeakRef 让 manager-only HMR 或关闭再启用不会把上一次抑制当成用户禁用；宿主树销毁后不保留强引用。模式作用于所有保留代次，清单与连接配置只对加入该代的 Agent 可见。
- **非阻塞**：设置名册可以读未挂载声明；按需清单只能读已发布、带 scope 的代次。初始化、刷新和 `mcp_load` 不调用 `compositionInventory`，避免 `diagnostic → loader.await` 等待 manager 自身。未知或拒绝求值的 `!!js` 不授权加载。
- **宿主准入**：初始声明快照来自经过宿主 compatibility preflight 的树，因此不撤销宿主已经拒绝的 MCP 行。全局 Include 行仍不被 gate 改写。
- **被否决**：空挂载表静默降级（按需模式变常驻）；`inspectCompositions` 代替树（只给 detached 模块引用，无法摘行）；按模块名单猜 preset（同内容可以属于多个预设）；用最新 profile 声明控制旧代（破坏已有会话）；为 activation audit 加 timeout（等待环仍存在）。
- **测试**：`npm test` 覆盖纯 allowance/gate；`npm run test:harness` 先重建实际分发产物，再对真实源码 Loader/registry/scope 验证导入、启动、pending injection、禁用矩阵、代次保留、manager 重载和作用域隔离。`DSH_HARNESS_ROOT` 可指定宿主 checkout。

### D15 配置不完整是独立状态，不是加载模式（2026-10-13）

- **结论**：名册行新增一个**配置诊断**状态（`McpConfigIssue`），与 gate 的"摘行"状态彻底分开。不完整配置只有三类：`command`/`url` 为空、`${env:NAME}` 在本进程解析不出、credential 形状的 `env`/`headers` 值留空。命中任一即：设置页显示「未配置」并**禁止把开关打开**；gate 不挂载该 preset 行（即使模式是 `eager`）；`mcp_load` 直接报出原因。
- **理由**：用户要求"预加载状态不显示，只有未配置时显示"。原先 `dynamic`/`lazy` 下**每一行**都写着「待加载」，那是模式的必然结果、不是任何状态，等于给整张列表加噪声；而真正需要用户动手的"少填了东西"反而被淹没。两者混在一个标签里，UI 无法表达"我允许用它，它也确实能跑，只是现在没进上下文"与"我允许用它，但它根本起不来"的区别。
- **判定口径**：
  - `unsupported-config`：transport 无法识别，或声明连 spec 都解析不出。**保存时直接拒绝**。
  - `unresolved-variable` / `empty-credential`：保存时接受（Host 的环境、或用户后续补的密钥都可能让它在下次启动前变好），但行保持「未配置」且不可开启。
  - 浏览器里的编辑器**不能**判断变量是否解析（它没有环境），所以它只把结构性错误挡在保存前；变量类问题交给名册读回时由 Host 判定，保存成功时弹窗给一句提示说明该行为何还不能开启。
- **`${env:NAME}` 复用资源管理器的语法**：`dsh-resource-manager` 已用同一拼写解析它自己的 MCP 定义，且**未配置变量的行不交接**给本插件。这里不发明第二套语法，配置里写 `"TOKEN": "${env:TOKEN}"` 在两边含义一致。本插件不解析变量、只做诊断与拦截（变量管理不在本次范围内）。
- **被否决**：
  - 把"配置不完整"编码进行上的 `disabled`。那会篡改用户的授权意图：变量在宿主环境里补上后，行不会自己恢复。
  - 为了省一个状态而在 `dynamic`/`lazy` 下继续显示「待加载」。它不指向任何可执行动作。
  - 全局行不参与"配置不完整"判据：闸门不读它们的配置，它们的树是 file-backed `Include`（D5、D11），所以配置不完整只能"标记 + 不许开启"；模式造成的未挂载由 D5 的内存拦截另行处理，两件事不混。
  - 完全放开保存不做检查，或反过来把未解析变量也挡在保存前。前者让配错的行静默存在，后者让用户在浏览器里永远存不下一行等着 Host 填变量的配置。
- **实现**：[`src/mcp-diagnostics.ts`](../src/mcp-diagnostics.ts)（纯函数，环境由参数传入）、[`src/mcp-variable-refs.ts`](../src/mcp-variable-refs.ts)（不引用环境的扫描规则，可进浏览器包）、[`src/mcp-gate.ts`](../src/mcp-gate.ts)、[`src/mcp-remote.ts`](../src/mcp-remote.ts) 的 `assertRunnableConfig`、[`src/client/McpSection.tsx`](../src/client/McpSection.tsx) 的 `statusOf`。
- **测试**：`tests/mcp-diagnostics.spec.ts` 覆盖三类判定与两种输入形状（Claude spec / 归一化 config）；`tests/mcp-gate.spec.ts` 断言 `eager` 下配置不完整的行仍被摘掉。

### D16 优化策略粒度分三层，页内「上下文」页签（2026-10-15，2026-10-16 合并入口）

- **结论**：上下文预算由 MCP 设置页的第二个页签（设置 → MCP 管理 → 上下文）控制，字段全部存在 `mcp-manager` 命名空间的 `optimize` 开映射里，由 `parseMcpOptimizeFlags` 在读点收敛。粒度分三层，互不替代：
  1. **选择**：`mcp_load` 的 `query`（词法匹配，无 embedding）与 `tool`（按名取一个）收窄本次会话**能调用**的集合；**载体不变**——`dynamic` 一律 `native`，收窄只决定注册哪些定义（D8）。已经加载过的服务器再给新 `query` 只会**加宽**（`widen`），永不收窄。
  2. **列表**：`cursor` / `limit` 只分页**结果**，不改变会话能调用的工具（分页是上下文预算，不是能力开关）。默认 `pageSize` 10。
  3. **形态**：`namesOnly` 默认让 `mcp_load` 只带名称与描述；按名字要一个工具（`tool`）时默认 `full`，因为那正是要参数的时机。
  另有 `mcp_search`（规范称之为 Layer 1 目录）、目录缓存（`catalogTtlMs`，同时尊重服务器自己给的 `ttlMs`、`tools/list_changed` 立即失效）、`maxTools` 采集上限，以及注解策略（`annotations` / `hideDestructive`）。
- **理由**：规范侧能用的只有 `tools/list` 的游标分页（**必须**把游标当不透明字符串、空串是合法游标、只有缺 `nextCursor` 才是结束）和 2026-07-28 新增的 `ttlMs` / `cacheScope`（`CacheableResult`，收到通知即失效）；**没有** `query` 参数，也没有「只列名称」的线上形态（`inputSchema` 必填）。官方《Client Best Practices》明确把渐进式发现放在宿主侧（`search_tools` → `get_tool_details` → 执行），并把「提供多档详情」列为实现建议。本插件因此在这一层实现，而不是发明协议字段。
- **命名的对应关系**：`mcp_search` 即 Layer 1（目录：名称 + 一行描述），`mcp_load` 带 `tool` 即 Layer 2（Inspect：单个工具的完整 schema），`mcp_call` / 原生工具即 Layer 3。插件不用单独注册 `get_tool_details`，省一个常驻工具定义。
- **被否决**：
  - **给 `tools/list` 加 `query` 参数**：规范没有这个字段，写了也只有自己的客户端认。
  - **磁盘持久化目录**：冷启动就能检索很诱人，但需要一个本插件并不拥有的数据目录，而且过期目录比空目录更难解释。当前只做进程内缓存。
  - **检索默认允许连接未缓存服务器**：20 台服务器的部署会因为模型问一句就 spawn 20 个子进程。默认关闭，用 `searchIndex` 显式打开（并发 3、单台 8 秒）。
  - **把分页做成能力开关**（只加载当前页的工具）：模型的下一句可能就要第 11 个工具，而它不知道要翻页；用 `query` 精确选择才是根治，分页只用来省上下文。
  - **让 `hideDestructive` 追溯已加载的服务器**：加载后换一套注册会让模型手上有名字、实际不可调；策略在下一次加载生效，与工具过滤同一条契约。
- **代价**：`mcp_load` 的结果多了 `total` / `shown` / `loaded` / `truncated` / `nextCursor` 五个字段，渲染文本变长；检索只覆盖「曾经列出过」的服务器，未索引的服务器只能列出名字让模型先加载。
- **实现**：[`src/mcp-optimize.ts`](../src/mcp-optimize.ts)（纯策略：收敛、匹配、分页、注解）、[`src/mcp-catalog.ts`](../src/mcp-catalog.ts)（有界 TTL 目录）、[`src/lazy-mcp.ts`](../src/lazy-mcp.ts)（`listAllTools` 游标遍历、`mcp_load` / `mcp_search`）、[`src/client/McpOptimizeSection.tsx`](../src/client/McpOptimizeSection.tsx)（页签内容）。
- **测试**：`tests/mcp-optimize.spec.ts`、`tests/mcp-catalog.spec.ts`、`tests/mcp-discovery.spec.ts`；`tests/mcp-load.spec.ts` 用被 mock 的 MCP SDK 驱动真实的 `registerMcpTools`，覆盖分页、收窄、names-only、注解策略、检索与 `tools/list_changed` 失效。

#### 合并入口（2026-10-16）

- **结论**：策略面与名册面合并为**一个** `settings.section`（id `mcp-manager`，order 14），页内用 `SegmentedTabs` 分「服务器 / 上下文」；第二条注册（id `mcp-manager-optimize`）删除。
- **理由**（用户反馈 + 源码核对）：宿主设置壳的 `settings.section` 契约只有 `id` / `order` / `label` 三个选项，没有分组或子级导航，所以一个插件注册两次必然多出一行侧栏入口；而那条注册用的 `order: 15` 与内置插件区（`plugins`）和服务管理（`service-manager`）撞号，稳定排序把「MCP 优化」排到了「内置插件」后面，两个 MCP 入口不相邻；`navIcon()` 只认五个固定 id，两个入口又都拿到同一枚兜底齿轮图标。实现者在注释里写的"正交的另一个问题"是**实现轴**，用户轴是「作用域 × 配置/状态 × 生效时机」，按用户轴这两面属于同一个任务。
- **代价**：深层链接不再能直接打开策略面（宿主设置壳本来也没有按 section 的 URL）；「上下文」页签在名册读取完成前也会挂载（读的是一次内存快照，开销可忽略）。
- **被否决**：保留两条注册、只错开 `order` 并改名（侧栏仍是两行、仍需用户自己判断去哪一页）；为页内分区再声明一个子 slot（为插件内部的两页引入 slot 机制，除非将来还要加第三个 MCP 页）。

#### 名册布局：一个平面、按行标注、按卡片编辑（2026-10-16，D22）

- **结论**：删除「全局 · N 行」「Agent 预设 · N 行」两个分组标题与预设下拉里的「全部 Agent 预设」项；列表恒为一行一卡的平铺列表，全局行在最前并带「全局」标签，预设行的预设名以一行小字报出。工具栏的预设下拉只决定 Agent 行，全局行在任何取值下都列出。点卡片本身打开编辑器（描述、开关、按钮照旧各管各的），行内按钮在**该行配置带 `env`/`headers`** 时是「密钥」并直接落在编辑器新增的「密钥」页，否则仍是「编辑」。（行内按钮与「编辑 / 密钥」两个按钮文案已于同日第三轮按用户要求**删除**，行右侧顺序同轮调换，见 D26。）
- **理由**（用户标注截图 + 代码核对）：分组标题嵌在两张卡片之间，把工具栏上的「筛选」读成了「切换平面」——用户的原话是「有筛选栏，可以选择 agent，agent 下面都显示全局，全局标签就是全局」。两个分组标题同时是两处冗余：「Agent 预设」与控件区标题同义，「全局 · 0 行」只是一句 0 行的说明。行内按钮原名「编辑」而旁边紧跟一个开关，位置关系读起来像「编辑这个开关」；用户要的是「配置密钥」这类明确的入口，「密钥」比一个泛化的「编辑」更贴内容。
- **代价**：
  - 名册接口每条行多一个 `secretKeys: string[]`（键名，绝不含值）；行数为 0 时是空数组，不进日志、不改任何加载语义。
  - 编辑器多一个页签（配置 / 密钥 / 工具列表），`env`/`headers` 与 JSON 是同一份数据的两个视图，不是第二份草稿。
  - 卡片可点 + 行内控件各自可点，需要一次命中判定（`closest('button, input, select, textarea, a, label')` 直接返回），只读行的卡片不进入这条路径。
- **被否决**：
  1. **把「全局」做成范围切换器、全局行只在那一档显示**：与「会话本来就带着全局行」不符，隐藏一个平面比标注它更容易误判组合挂载了什么。
  2. **保留标题、只把文案改短**：用户要的是去掉标题本身。
  3. **卡片做成整块 `<button>`**：描述是就地编辑按钮、开关是 `input`，把交互控件嵌进按钮会同时破坏两者的语义与键盘行为；改为在行容器上命中判定。
  4. **「密钥」对每一行都显示**：没有 `env`/`headers` 的行打开一个空页签只是噪声，所以按钮按是否有密钥在「编辑 / 密钥」之间选择。
- **实现**：[`src/client/McpSection.tsx`](../src/client/McpSection.tsx)（列表、筛选、卡片命中判定）、[`src/client/McpEditor.tsx`](../src/client/McpEditor.tsx)（`config | credentials | tools` 三页与 `tab` 入参）、[`src/client/credential-fields.ts`](../src/client/credential-fields.ts)（JSON 视图的纯读写与「只写改动过的字段」合并）、[`src/mcp-config.ts`](../src/mcp-config.ts) 的 `storedCredentialKeys`、[`src/mcp-roster.ts`](../src/mcp-roster.ts) 的行投影。
- **测试**：`tests/credential-fields.spec.ts`（读、写、只合并改动字段、拒绝不可写形态）、`tests/mcp-roster.spec.ts` 的 `secretKeys` 断言（含「序列化结果里不出现密钥值」）；浏览器验收读数见 [testing.md](testing.md)。

### D17 「零拉起 + 宿主级常驻 + 引用计数」是一组取舍（2026-10-15）

- **结论**：三件事一次定死：
  1. `dynamic`/`lazy` 下允许的行被抑制，**宿主启动与声明重建都不 spawn**（D5 的三条路径）；**两个平面都算**"允许的行"——preset 行与全局行（全局行只在内存里拦，绝不落盘）。
  2. 加载过的连接进**宿主级常驻池**，跨会话、跨子代理复用（D4）；全局行的 `mcp_load` 也走同一个池、同一份连接。
  3. 释放按**每会话 claim 引用计数**，最后一个引用释放才关闭连接（D4）。
  工具注册仍然落在**调用方 agent 作用域**（D3、D8），所以"常驻"说的是连接，不是"工具漏给所有会话"。
- **理由**：旧行为在两个方向上都与"按需"这个名字相反——没加载时启动又杀掉子进程；加载过的服务器在会话结束时被回收，下一个会话又要等一次冷启（`npx -y` 实测 7.5–23 秒）。改完之后：不用就不起、用过就留着、没人用才停。
- **被否决**（本轮合并考虑的替代组合）：
  1. **每会话一份 + 延迟回收**：见 D4 的被否决 1。
  2. **抢在 `import` 阶段拦截**：见 D5 的被否决 2。
  3. **保留 `mount` 载体**：见 D8 的被否决 2。
  4. **把"常驻"做成跨宿主重启持久化**（守护进程 / 开机自启）：没有需求支撑，也绕开组合行的授权语义；边界明确限定为**宿主进程生命周期内**。
  5. **给池加空闲 TTL**：见 D4 的被否决 2（留在路线图的待评估项）。
  6. **对全局行也用发布点处置、或让全局行继续"始终挂载"**：前者会把闸门状态写回用户文件，后者与本决策冲突；三条路径的分工见 D5。
- **代价 / 边界**：
  - 常驻只到宿主重启为止，重新加载要再付一次冷启；**提交不同的加载模式会重建工具面并释放该模式的引用**，届时无人再持有的连接会停止——这是模式切换的既定语义，不是常驻失效。
  - 一份进程被多个会话共享：服务器自身崩溃会影响所有持有它的会话（旧行为下各会话相互隔离），但现在**崩溃可被感知并恢复**（D23）；**挂死**（进程还在、既不结束也不响应）仍然没有超时，那部分影响照旧。
  - **全局行的行为变了**：`dynamic`/`lazy` 下它们不再在启动时被组合挂载，而是被内存拦截、由 `mcp_load` 按需拉起；工具过滤对全局行仍不生效（规则藏不掉组合已经注册的工具，见 D6）。设置页的全局分组文案随之改了。
  - **按需模式拿不到 server instructions 与 `mcp-resources`**（`mount` 载体删除的代价，见 D8）；要这两样把行放 preset 并选 `eager`。
  - "启动零拉起"依赖三条机制都成立（D5）；被 hold 的行没有 fiber，所以取行集合的变化必须由 `onRowTaken` / `onCaptured` 上报。
- **证据**：
  - **框架层**：`npm run test:harness` **6 文件 / 25 项通过**——`zero-launch`（4 项）断言 `dynamic` 下 `mcp-client` 回调执行 **0 次**（`eager` 对照 1 次）；`global-zero-launch`（5 项）把同一条结论扩到全局行（含 late hold 接管与"用户文件完好"）；`on-demand-pool` 断言两次 `mcp_load` 只 `opened === 1`、会话销毁后连接存活、末位释放才关闭、切回 `eager` 能恢复挂载；`global-toggle` 覆盖全局行开关与只读判据。
  - **单测层**：`npm test` **19 文件 / 204 项通过**（`tests/mcp-pool.spec.ts` 的 claim / 引用计数语义、`tests/mcp-gate.spec.ts` 的挂载前拦截与全局行读取、`tests/mcp-row-state.spec.ts` 的 `rowAllowed` 优先序等）。
  - **真实宿主（隔离实例）**：**读数是最终产物 `lib/index.mjs` = `121B8C0A…` / `lib/client.js` = `E1B1051A…`**，宿主 `@deepseek-ai/dsh@0.2.0-rc.2`（= npm `latest`/`next`，也是日常实例实际运行的版本）：`dynamic` 启动后 marker 从未创建、进程 0、stderr 为空；`eager` 对照长期存活；两个真实会话多次 `mcp_load` 只产生 **1 条 spawn / 1 个存活进程**（同一个 pid），末位释放后进程归零；`mcp_unload` 三分支逐条命中；全局行的开关（形状 A）在设置页真正可用，被用户停用的行开关立即显示为关。**较早产物 `9B5D8D19…` / `D498FEC7…` 的读数保留为历史**（见 [testing.md](testing.md)），不再代表当前产物。
  - **已知限制/异常**：全局写入是整表重写（丢注释、留显式 `disabled: false`，见 D11）；root anchor 被写成完整组合树的现象**观察到一次、未能复现**（D11）。
  - **未覆盖**（与 testing.md 一致）：真实 `npx -y` 冷启动路径、GUI 里由模型决定的调用路径、`tools/list_changed` 跨会话 resync、活动实例内运行中切换加载模式、活动实例里的 `lazy` 池复用、`mcp_search` 工具本身、新增/导入/删除行与编辑弹窗「保存」的浏览器实测、用户 Include 的注释保留。
  - 原始读数见 [testing.md](testing.md)。

### D23 传输层掉线由池感知，视图撤回，下次 `mcp_load` 重开（2026-10-16）

- **结论**：连接多了一个「丢失」状态，与「我们自己关掉的」分开：
  1. `LazyClient` 暴露 `onclose` —— SDK 的传输层结束回调。它**对我们自己的 `close()` 同样触发**，所以它本身分不清两者；
  2. 池在 `watch` 里装上它，回调进入这条连接自己的 `end(lost)` 闸门：已经结束过的连接直接返回，于是**主动关闭不会被记成丢失**；
  3. 判定为丢失时，连接立刻移出池、warn 一次（带服务器名，不含凭据），再调 `onConnectionLost`；
  4. 注册侧收到后**撤回每个会话对这条连接的视图**（释放注册与 claim）。服务器行仍留在按需清单里，所以下一次 `mcp_load` 会拉起新进程并注册新的一代工具。
- **理由**：旧行为下池只认一种结束——我们自己 `dispose()`。子进程崩溃后连接对象的 `closed` 仍是 `false`，`acquire` 照旧把它发出去，会话拿到的工具永远调不通，**只能重启宿主**才能恢复。三处独立证据指向同一个洞：本仓 `LazyClient` 根本没有存活信号；[MaxHou-infinity/dsh-mcp-session-recovery](https://github.com/MaxHou-infinity/dsh-mcp-session-recovery) 为同类问题专门发了一个插件；IBM ContextForge 的内置健康检查用「连续 3 次失败标 Offline、恢复自动 Active」处理同一件事。
- **被否决**：
  1. **在池里加自动重连监督器**（照抄宿主 `mcp-client` 的 500ms→30s 退避 + 10 次预算）：池是按需语义，没有「保持在线」的义务；崩溃后最便宜的恢复是下次 `mcp_load` 重开，而不是在后台反复拉起一个当前没人用的进程。宿主 `mcp-client` 需要监督器，是因为 `eager` 行的工具常驻每次请求，掉线必须自动补上。
  2. **保留死工具、只让调用失败**：模型会照历史里的名字反复调一个已经不在的服务器。宿主 `mcp-client` 能这么做，是因为它有重连预算与「耗尽后摘除」的终点；我们没有预算，摘除才是诚实的表达。
  3. **给池加空闲 TTL**：与 D4 的被否决 2 相同，仍留在路线图待评估项。
- **代价 / 边界**：
  - 丢失判定依赖 SDK 触发 `onclose`；**stdio 子进程被强杀后传输层是否必然回调，本轮未实测**（见 [testing.md](testing.md) 未覆盖项）。
  - 撤回视图会让该会话这批工具消失，模型看到的是工具列表变化；行仍在按需清单里，可以重新 `mcp_load`。
  - 丢失的连接仍会走一次 `dispose()` 释放传输，所以 `closed`（能否再用）与 `disposed`（是否已释放）是两个标志；否则「已经不可用」会连带漏掉 transport 句柄。
  - **挂死不等于崩溃**：进程还在、只是不响应时既没有 `onclose` 也没有超时，池不会做任何事。这是本轮明确不解决的边界。
- **证据**：`tests/mcp-pool.spec.ts` 新增 5 项，`tests/mcp-load.spec.ts` 新增 1 项。**并且验证过这些用例会因缺少本次接线而失败**：摘掉 `onclose` 赋值后 4/5 池用例变红；摘掉 `connectionLost` 接线后注册层用例报 `mcp__alpha__a` 仍留在会话里。读数见 [testing.md](testing.md)。

### D24 第二个页签改叫「设置」，加载方式移进去，名册不再自述开关语义（2026-10-16）

- **结论**（三条一次改完）：
  1. 页内两个页签从「服务器 / 上下文」改为「服务器 / 设置」；「设置」页签的内容仍是 D16 的策略行。
  2. 加载方式块（`mcp.mode.*`）从名册页签移到「设置」页签，排在策略行之前。
  3. 删除 `mcp.list.hint` 那句页内说明；标题旁的计数不再带 `· 筛选：{name}` 后缀（`mcp.count.narrowed` 删除，不筛选时改用已有的 `mcp.count.rows`）。
- **理由**（用户截图 + 原话，2026-10-16）：用户按自己读到的页面直接给出三条——「服务器和上下文 tab 改成 服务器、设置」「MCP 加载方式移入设置」「删除 开关决定…这段描述、删除 筛选：standard 这个描述」。加载方式与策略行放在一起，是因为两者都是「改一次、影响之后所有会话」的页级偏好；名册页签因此只剩列表本身与它的视图控件（搜索框、预设下拉）。
- **代价**：
  - D1 那条「开关 = 允不允许用、加载方式决定何时进上下文」的区分不再有一句常驻说明，只由开关控件、加载方式块所在页签与 D9 的按需清单承载；要恢复说明就把 `mcp.list.hint` 加回去。
  - 计数后缀删除后，预设下拉的当前取值只在下拉里显示一次；`mcp.count.narrowed` 从两份字典移除。
  - `activePresetName` 仍被空态文案使用（`mcp.empty.row.hint`），未删除。
- **被否决**：
  1. **页签保留「上下文」、只把加载方式放进去**：同一个页签里既有加载方式又有检索/分页/缓存策略，名字要覆盖两者；用户也已经点名了「设置」。
  2. **加载方式留在名册页签**：那正是用户要求移走的位置，且它不随列表变化，留在列表里会被读成列表的属性。
  3. **把页内说明压成更短的一句**：用户要的是删掉这段。
- **实现**：[`src/client/McpSection.tsx`](../src/client/McpSection.tsx)（`McpTab` 取 `settings`、`loadingSection` 与两个 tabpanel 的 id）、[`src/client/locales.ts`](../src/client/locales.ts)（`mcp.tab.settings` 取代 `mcp.tab.context`，删 `mcp.list.hint` 与 `mcp.count.narrowed`）、[`src/client/McpSection.module.css`](../src/client/McpSection.module.css)（删 `.listHint`）。
- **测试**：`tests/client-css.spec.ts` 会拒绝样式表里没人引用的类，所以删类必须同步删引用；`npm test` 22 文件 / 259 项通过。浏览器读数见 [testing.md](testing.md)。

### D25 密钥页去掉说明句，只留标签 + 字段 + 状态（2026-10-16）

- **结论**：删掉密钥页的三句说明 —— `mcp.credential.envHint` / `headerHint`（`环境变量` / `请求头` 标签下那句）与 `mcp.credential.hint`（面板底部「改完直接点保存…」），两份字典同步删除；保留 `mcp.credential.empty` / `unreadable` / `busy`。
- **理由**（用户看着密钥页截图提的原话：「去掉密钥这里乱七八糟的描述」）：三句里两句只是标签的复述（「子进程的环境变量，值只保存在本机配置里」），第三句讲的是数据模型（`env`/`headers` 与 JSON 是同一份数据），而不是用户此刻要做的事。
- **代价**：`env`/`headers` 与「配置」页 JSON 是同一份数据这件事不再有页内说明；要恢复就把 `mcp.credential.hint` 加回去。
- **被否决**：把它们压缩成更短的一句 —— 用户要的是删掉。空态那句保留：删掉后一个空面板没有任何解释，而空态说的是状态、不是对控件的复述。
- **实现**：[`src/client/McpEditor.tsx`](../src/client/McpEditor.tsx)（`McpCredentialsPane` 的标签下说明与面板底部说明）、[`src/client/locales.ts`](../src/client/locales.ts)（删三键 × 中英各一份）。
- **遗留（另一件事，本轮未动）**：`!!js` 表达式的值以 `{"__jsExpr":"…"}` 原样显示，且在该输入框里改动后会以普通字符串写回、把表达式写坏 —— 复现截图与读码记录见 [testing.md](testing.md) 第十节。

### D26 行内按钮去掉、状态排到平面标记之前、页签占满整列（2026-10-16）

- **结论**（用户看着名册截图一次提了三条，2026-10-16）：
  1. **名册行不再渲染「编辑 / 密钥」按钮**：整张卡片就是编辑入口，有 `env`/`headers` 的行落在编辑器「密钥」页、其余落在「配置」页；行内只剩开关。`mcp.edit` / `mcp.credential.button` / `mcp.credential.buttonHint` 三个字典键与 `.mcpActions` 容器一并删除。
  2. **行右侧顺序改为「状态 → 平面标记（全局标签 / 预设名）→ 开关」**（原先「平面标记 → 状态 → 按钮+开关」）。状态是唯一"有时没有"的元素，原先夹在平面标记与动作组之间，它一出现就把同一行别的元素推位，几行并排看就是没对齐；平面标记贴住恒渲染的开关后，每行的标记右缘与开关左缘都落在同一列。
  3. **页内「服务器 / 设置」两个页签占满整列宽度**：删掉 `.tabs` 的 `max-width: 320px` 与 `align-self: flex-start`，`@container (max-width: 480px)` 里那条 `max-width: none` 随之删除（该覆盖已无对象）。
- **理由**：卡片可点之后按钮与它是同一件事的第二个入口（D22 已经为「编辑」这个读法把按钮改名「密钥」，但它仍是重复入口）；对齐问题的根因是状态的可选性，不是间距，所以只能靠换序解决。
- **被否决**：
  1. **保留按钮、只把它挪到开关之后**：仍是第二个编辑入口，且用户明确要求去掉。
  2. **给状态留一个固定宽度的占位**：54 行的列表里就是 54 个空列，比不给状态更占地方。
  3. **只把平面标记右对齐、状态留在原位**：换序才是用户的要求，且换序后平面标记与开关之间不再有第三个元素。
- **代价**：没有 `env`/`headers` 的行只剩"点卡片"一条路径进编辑器（只读行本来两条都没有）；卡片是 Tab 停靠点、Enter/Space 可开（上一轮已做），键盘路径不受影响。想恢复入口就把按钮加回 `.mcpRight`，并同步补回三个字典键。
- **实现**：[`src/client/McpSection.tsx`](../src/client/McpSection.tsx)（`McpRow` 的右侧区、`openEditor` 不再收页签名、`onEdit(tab)` 改为必传）、[`src/client/McpSection.module.css`](../src/client/McpSection.module.css)（`.tabs` 全宽、删 `.mcpActions`、容器查询删 `.tabs` 覆盖）、[`src/client/locales.ts`](../src/client/locales.ts)（删三键 × 中英各一份）。
- **测试**：`tests/client-css.spec.ts` 会拒绝没人引用的类，所以删 `.mcpActions` 必须同步删 TSX 里的引用；`npm test` **22 文件 / 259 项**、`npm run test:harness` **6 文件 / 25 项**均全绿（项数与改动前相同）。浏览器盒子读数见 [testing.md](testing.md) 第十一节。

### D27 两级下拉合成一个「落点」下拉（2026-10-16）

- **结论**：新增弹窗的「配置范围」（全局 / Agent 预设）与它下面那级「Agent 预设」下拉合并成**一个**「配置范围」下拉，选项是 **全局 + 全部已声明预设**；导入弹窗的「导入到」同样合并（该弹窗原来也是两级）。两个弹窗共用新组件 [`src/client/McpTargetSelect.tsx`](../src/client/McpTargetSelect.tsx)，同一份哨兵语义：**空串 = 全局平面**，否则是该预设 id（预设 id 非空，与名册筛选的 `MCP_ALL_PRESETS` 同一约定）。
- **理由**（用户看着新增弹窗截图的原话：「这两个不能合并成一个吗，全局肯定就不是某个agent agent就肯定不是全局。所以选择范围就可以选择全局或者某个agent」）：两条下拉是同一个问题的两个答案，第一级选「全局」时第二级是个空转的控件；而第一级选「Agent 预设」时用户还得回答第二个问题才知道行写到哪。一个落点就是一个值，一个值就该一个控件。
- **附带的行为**：
  1. **初值**：编辑某行仍只读显示该行自己的平面（不出现下拉）；新增/导入按调用方给的平面与预设开，**全局平面不可写时初值直接回落到第一个预设**（旧行为是停在不可写的「全局」上、把保存按钮禁用），一个落点都没有才禁用保存。
  2. **不可写时那一档在下拉里禁用**，原因写在控件下方（`mcp.global.unavailable`）——它现在解释的是"这个下拉里被灰掉的那一项"，而不是"旁边的另一个下拉为什么不见了"。
  3. 预设项文案统一为 `预设 · <名>`（导入弹窗原来就是这个写法，新增弹窗原来只写名字）；兜底项保留：一个已不在名册里的预设 id 仍会作为一项渲染，控件不会出现"有值但显示不出来"。
- **被否决**：
  1. **保留两级、只在第一级选「全局」时隐藏第二级**：隐藏一个字段不会让问题变少，只是让用户看不见自己在回答什么。
  2. **用 optgroup 把预设分组、再留一个「全局」组**：全局与预设不是同一维度的分类，分组会把"落点"读成"先选类型再选实例"。
  3. **两个弹窗各改一份**：同名控件两份实现必然漂移（同一个 `preset · ` 前缀、同一个哨兵、同一个兜底项），所以抽成一个组件。
- **代价**：`mcp.form.presetScope`（`Agent 预设`）与 `mcp.form.noPreset`（"这个组合里没有可写入的 Agent 预设"）两个字典键不再有任何消费点，中英各删一份；`mcp.form.noTarget` 仍由新增弹窗在"没有预设、也没有可写全局"时使用。要找编辑入口或落点语义，看 `McpTargetSelect.tsx`。
- **实现**：[`src/client/McpTargetSelect.tsx`](../src/client/McpTargetSelect.tsx)（新）、[`src/client/McpEditor.tsx`](../src/client/McpEditor.tsx)（`planeOf` + 两级下拉删除，`initialTarget` / `editorTarget(mode, server, choice)`）、[`src/client/ClaudeImportDialog.tsx`](../src/client/ClaudeImportDialog.tsx)（同上）、[`src/client/locales.ts`](../src/client/locales.ts)（删两键 × 中英各一份）、`tests/client-css.spec.ts`（把新组件纳入"用到的类必须被定义、定义的类必须被引用"的检查名单）。
- **测试**：`npm test` **22 文件 / 259 项**全绿；浏览器读数（两个弹窗各只剩 1 个下拉、选项集合、不可写全局的灰项与原因、保存可用）见 [testing.md](testing.md) 第十二节。

### D28 必填标记与自动命名、平面标记改芯片并居中（2026-10-16）

- **结论**（用户看着名册与新增弹窗提的两条，2026-10-16）：
  1. **新增弹窗的必填字段打 `*`**：`服务器名` 与 `JSON 配置` 的标签后各加一个 `*`（`aria-hidden` 的装饰，控件本身带 `aria-required="true"`）。其余字段（描述、密钥、工具列表）不标，因为空着也能保存。
  2. **能给默认值就默认、能自动就自动**：服务器名在**用户还没自己填**之前由 JSON 现推（`npx -y @upstash/context7-mcp` → `context7`，`https://mcp.yunxiao.com/mcp` → `yunxiao`）；落点下拉已经默认在名册筛到的那个预设上；JSON 框本来就有 stdio 骨架。推断规则进 `src/mcp-spec.ts` 的 `serverNameFromSpec`，与 `serverNameFromCommand` 同一份实现。
  3. **行右侧的平面标记改成 tab 样式的芯片**：`全局` 与预设名现在是同一个 `.rowScope` 芯片（R12 + `--dsw-alias-border-l3` 细线 + `--dsw-alias-bg-layer-3`，就是宿主页签选中态那套 token），不再是一个 `Tag` 加一段纯灰字。
  4. **行右侧那组上下居中**：`.mcpRight` 加 `align-self: center`，让状态、平面芯片、开关落在卡片的中线上；容器 ≤480px 的堆叠布局里改回 `align-self: stretch`，否则那组会缩成内容宽、开关离开右缘。
- **理由**：名册行左边是「名字 + 描述」两行，右边原来贴顶线，于是每张卡片里开关的高度都跟着左边第一行的高度走，而下一张卡片的描述长短不同——同一列看着就是没对齐；平面标记原来是灰字，和旁边的状态、开关不在一个视觉层级上，改成芯片后它与宿主页签同款，读起来才像"我这一行属于哪个范围"。必填标记与自动命名是同一件事的两面：这个表单只有两个字段真的不能空，而其中一个（名字）本来就写在 JSON 里。
- **被否决**：
  1. **只把 `*` 写进字典文案**（`服务器名 *`）：那是把标记画进文案，中英各要维护一遍，而且屏幕阅读器会把 `*` 读出来；分层渲染 + `aria-required` 才是标记与语义各归各位。
  2. **自动命名写成占位符（placeholder）**：占位符不算值，用户以为没填、保存时才发现；写进输入框则一眼可见、可直接改。
  3. **名字一旦自动填过就永远跟随 JSON**：那样用户手填的名字会被下一次粘贴覆盖——名字是行的主键，不能被"顺便"改掉，所以用户一碰这个字段就不再自动填。
  4. **平面标记沿用 `Tag`**：`Tag` 是 11px 的只读徽标，比旁边的状态与开关小一档，读起来像附注；芯片（24px、R12）才与开关同一层级。
  5. **行整体 `align-items: center`**：那会把左边的名字与描述也一起居中，长描述的行读起来会散；只居中右边那组。
- **实现**：`src/mcp-spec.ts`（新增 `serverNameFromSpec`，抽出 `programName`，`serverNameFromCommand` 改为复用它）、[`src/client/McpEditor.tsx`](../src/client/McpEditor.tsx)（`syncName` + `nameTouched`、必填标记与 `aria-required`、`.requiredMark`）、[`src/client/McpSection.tsx`](../src/client/McpSection.tsx)（`planeLabel`，两级标记合成一个芯片）、[`src/client/McpSection.module.css`](../src/client/McpSection.module.css)（`.rowScope` 改芯片、`.mcpRight` 居中与堆叠覆盖、`.requiredMark`）。
- **测试**：新增 `tests/mcp-spec.spec.ts`（5 项：包名推断、命令回退、URL 主机推断、推不出名字的四种形态、文档自带名优先），`npm test` **23 文件 / 264 项**全绿；浏览器读数（芯片几何、右侧组与行中线一致、`*` 与 `aria-required`、粘贴后自动填名、手填名不被覆盖）见 [testing.md](testing.md) 第十三节。

### D29 删除「导入 Claude 配置」（2026-10-16）

- **结论**（用户原话：「删除导入Claude配置的功能」）：整条链路删除 ——
  `src/claude-import.ts`（读 `~/.claude.json`、`~/.claude/settings*.json`、`<cwd>/.mcp.json`）、
  `mcp-remote.ts` 的 `addMcps` 与 `scanClaudeMcp` 两个 Remote 及批次写入的私有实现
  （`addMany` / `writeGlobalBatch` / `writePresetBatch` / `PlannedRow`）、`src/remote.ts` 的两个 descriptor、
  `src/client/ClaudeImportDialog.tsx`、`src/types.ts` 的 `AddMcpBatch*` / `AddMcps*` / `ClaudeMcp*` /
  `ScanClaudeMcp*` 类型、`mcp.import.*` 全部字典键（中英各 33 条）、`.import*` 全部样式、
  `mcpActionError` 样式（只被导入弹窗用）、`tests/claude-import.spec.ts`，以及名册工具栏的「导入」按钮。
- **理由**：功能是用户不要的，不是"暂时不用"；留着就是死代码 + 一套要维护的 RPC 契约 + 一份会让后来者以为它还在的文档。`addMcp`（单行新增）保留，新增弹窗仍走它。
- **代价**：想导入别人的 Claude 配置只能手工粘贴 JSON 到新增弹窗（`parseSpecText` 仍收 `mcpServers` 单键映射与 `{ "name": { … } }` 包装，粘贴一次一行）；恢复要重写扫描与批量写入 —— 批量写入的价值（一次 patch、一次预设重挂）在 D12 有记录，可以照它重建。
- **实现**：见上列文件；`src/mcp-spec.ts` 的解析规则不受影响（它服务于编辑器）。
- **测试**：`npm test` 从 **23 文件 / 264 项**降到 **22 文件 / 253 项**（删掉 `tests/claude-import.spec.ts` 的 11 项）；`npm run typecheck` 通过。浏览器读数见 [testing.md](testing.md) 第十四节。

### D30 工具列表按 token 展示、加载态居中、设置页去掉两句说明（2026-10-16）

- **结论**（用户原话：「描述改成，取消勾选则不加载进入上下文，当前加载 xx token，取消 xx token。下面的方法列表 后面显示token量」「这个连接中应该是一个loding，可以放在中间吗，不要把描述挤下来」「去掉这些描述。然后MCP加载方式下面的tab占满整行」）：
  1. **工具列表页**：每行右侧显示该工具定义估算的 token；提示句换成「取消勾选则不加载进上下文：当前加载 ≈{n} token，取消 ≈{m} token。」，两个数是勾选与未勾选定义之和。
  2. **加载态**：等待时不再把「加载工具列表」按钮的文字换成「连接中……」，而是把转圈 + 同一句文案放到**面板中间**（`.toolsLoading`，`role="status"`），上方的提示句原地不动。
  3. **设置页**：删掉加载方式块标题旁的「立即生效：切换会重建工具面，已加载的连接可能被释放。」（`mcp.mode.when`）与策略区上方那段总述（`opt.intro`）；加载方式的三段控件**占满整块**（与页面页签同宽）。
- **理由**：工具列表是"这次请求要花多少上下文"的界面，而它原来只说"默认全部启用"，用户看不出取消一个大工具省了多少；等待塞在按钮里会让整行文字变长、把下方提示挤动，而这行提示正是解释当前状态的那句；两句被删的描述都是控件自身的复述（加载方式的生效时机由控件与每个模式的说明句承载，策略行各有标题与说明）。
- **token 估算的口径**（`src/mcp-tokens.ts`）：**本地估算，不是 tokenizer** —— 两侧都没有可用的分词器，而这个数字的用途是横向比较（哪个工具贵、勾掉省多少），不是预测计费。算法是"把定义序列化成 JSON（name/title/description/inputSchema）后按约 4 字符/token 计，CJK 约 2 字符/token"，界面一律写 `≈`。**在哪算**：host 侧列出工具的那一次算好、随 `McpToolRow.tokens` 下发 —— schema 本来就在 host 手里，浏览器拿不到也不需要。
- **被否决**：
  1. **把 schema 传给浏览器自己算**：多传一份大对象，还要在浏览器里维护第二份估算规则（违反"规则只实现一份"）。
  2. **用真实 tokenizer**：要在 host 里给一次设置页列举引入一个分词器依赖，且不同 provider 的分词器不同，估算反而更假。
  3. **等待用骨架行**：工具列表的行高与数量都要等第一页才知道，骨架会先给一个错的形状；转圈 + 一句文案更诚实。
  4. **把 `≈` 省掉、只写数字**：那是把估算说成精确值，用户会拿它跟宿主的用量统计对账。
  5. **只删文案、保留占位空行**：用户要的是这两句消失，不是变短。
- **实现**：`src/mcp-tokens.ts`（新）、`src/types.ts`（`McpToolRow.tokens`）、`src/mcp-remote.ts`（列表落点）、[`src/client/McpEditor.tsx`](../src/client/McpEditor.tsx)（每行 chip、提示句、居中加载态）、[`src/client/McpSection.tsx`](../src/client/McpSection.tsx) + [`McpOptimizeSection.tsx`](../src/client/McpOptimizeSection.tsx)（删两句）、`McpSection.module.css`（`.toolTokens`、`.toolsLoading`、`.spinner`、`.modeBlock` 拉伸）。
- **测试**：新增 `tests/mcp-tokens.spec.ts`（5 项：schema 占比、CJK 高于同长度 ASCII、空串兜底、向上取整）；`npm test` **23 文件 / 258 项**全绿。浏览器读数（真实 MCP 服务器的三条工具 ≈26/≈46/≈778、合计 850 = 提示句里的数、取消勾选后 72/778、加载态居中且提示 Y 不变、加载方式控件 564 = 块宽、两句已消失、名册无导入按钮）见 [testing.md](testing.md) 第十五节。

### D31 JSON 校验显示在字段标签行上，失焦才判（2026-10-16）

- **结论**（用户看着新增弹窗的两张截图提的原话：「这个校验在配置json旁边，鼠标失焦的时候就进行显示」，红框画在「JSON 配置 \*」标签右侧）：
  1. **位置**：JSON 文档的校验结果显示在 `JSON 配置 *` 的标签行上、标签右侧（`.fieldError`），不再落在表单底部那条共用错误行里。
  2. **时机**：输入时**不判**（`onChange` 只清掉上一次的结论），**失焦时**才判（`onBlur`）；`aria-invalid` 跟着结论走。
  3. **范围**：只报"这个文档能不能用"——能不能解析（`parseSpecText`）、传输结构是否完整（`diagnoseMcpSpec` 里 `isBlockingConfigIssue` 的那几条）。缺服务器名、落点不可用、Host 拒绝仍走表单自己的错误行。
  4. **联动**：在工具列表页点「加载工具列表」而文档读不出来时，结论进这个字段旁边、并切回「配置」页签——原来它报成工具列表页的连接错误，用户会以为服务器有问题。
- **理由**：读不出来的文档是当场能改的问题，报在表单底部（弹窗内容区还会滚动，实测那条信息被裁在可视区外）等于让用户去找；而"写一半"是编辑中的常态，逐键判定只会一直红着。
- **被否决**：
  1. **放在文本框下面**：正是先试的写法 —— `.editorPanel` 的最小高度 + 弹窗 640px 滚动区把那条信息挤到可视区外（截图 `d31-json-error-from-tools.png` 里被下边缘裁掉），所以才移到标签行。
  2. **逐键校验**：用户明确要求失焦时再显示。
  3. **用 `formError` 那条共用行 + 滚动到该字段**：滚动位置依赖布局，且用户要的是"在旁边"。
  4. **把 Host 才能回答的 `${env:…}` 也算进来**：那是名册读的职责（D15），在浏览器里判会误报。
- **实现**：[`src/client/McpEditor.tsx`](../src/client/McpEditor.tsx)（`jsonError` 状态、`jsonProblem`、`onBlur`/`onChange`、`loadToolsFromForm` 与 `submit` 的分流）、`McpSection.module.css`（`.fieldError`）。
- **测试**：`npm test` **23 文件 / 258 项**全绿；浏览器读数（输入时不报、失焦即报、消息与标签同行 `labelDelta = 0`、在可视区内、改对后消失、从工具列表页触发也会切回配置页）见 [testing.md](testing.md) 第十六节。

### D32 工具列表页去掉加载按钮（2026-10-16）

- **结论**（用户看着加载中的工具列表页提的原话：「这个按钮也去掉，其他按钮都隐藏，导致下面描述掉一行很奇怪」）：
  1. **删掉「加载工具列表」按钮**（`mcp.form.toolsReload` 字典键一并删除）。
  2. **进页签就是列举的触发点**：`pickTab('tools')` 在有话可说时直接列举，新增（add）与编辑（edit）两种模式都算 —— 旧实现只在编辑模式自动列举，新增行只能靠那个按钮。
  3. **表单变了才重列**：记住这次列举所依据的「命名空间 + spec」（`listedFor`），再次进入页签时若表单已改（JSON 或名字）就重新列举，否则保留现有列表（不为了看一眼再连一次）。
  4. **工具行固定占位**：`.toolsHead` 加 `min-height: 28px` 并**始终渲染**；`3/3` 计数与「全选/全不选」只在有列表时出现，下面那行说明（token 合计）因此不会因为按钮出现/消失而上下跳。
- **理由**：那一行原来在"只有按钮"和"计数+按钮"两种状态之间切换，说明句就跟着掉一行；而列举本来就不需要一个额外动作去点 —— 打开这一页就是"我要看它的工具"。新增模式没有按钮后仍要能列举，否则那一页对新行是死的。
- **被否决**：
  1. **保留按钮、只把它变成图标**：用户明确要去掉；而且问题不在外观，在"这一行有时有内容有时没有"。
  2. **只删按钮、其他不动**：新增弹窗的工具页签会变成一个永远空的页面（旧代码只在 `mode === 'edit'` 时自动列举）。
  3. **每次进页签都重列**：`listMcpTools` 会真的连一次（stdio 就是起一个子进程），为没变过的表单重复连接是白花钱。
  4. **把说明句放进固定高度的容器**：那只是把跳动换成一个更难解释的空白块；根因是那一行本身不需要存在。
- **实现**：[`src/client/McpEditor.tsx`](../src/client/McpEditor.tsx)（`pickTab` / `listingTarget` / `listedFor` / `loadToolsFromForm`）、`McpSection.module.css`（`.toolsHead` 的 `min-height`）、`locales.ts`（删 `mcp.form.toolsReload`，`toolsNeedsName` 文案改成不再提按钮）。
- **测试**：`npm test` **23 文件 / 258 项**全绿；浏览器读数（四种状态下提示行都在 y=373、工具行 28px、没有加载按钮、改过表单后重列会进 connecting、新增弹窗也能列举）见 [testing.md](testing.md) 第十七节。

### D33 没有可写 Include 时由插件自动创建（2026-10-27）

- **背景**（用户原话：「我刚安装的，为什么全局置灰，是默认就这些？不能写全局？」）：全新 profile 只挂宿主的 root anchor Include，`globalWritable` 恒为 false，于是「全局」永远置灰、「新增到全局」永远不出现。用户能写预设，却以为整台 MCP 管理只支持预设；这也让插件自述的「全局平面 + 各 agent preset」少了一半。
- **结论**：
  1. **远端新增 `enableGlobalPlane`**：没有可写 Include 时，在 profile 目录写 `mcp.cordis.yml`（`[]`），向 `cordis.patch.yml` 追加一行 `insert` 的 `cordis:include`（`initial: []`），随后经 boot 包的 `readProfilePatches` + `reconcileProfilePatches` 重建组合；返回 `includePath / created / patchChanged / mounted`。
  2. **首次名册读取时自动创建一次**（2026-10-27 晚些的用户要求：「这个还要我手动启用，不能插件自己自动启用一次吗」）：`listMcps` 在每个宿主进程的第一次调用里，若组合没有可写 Include 且存在 `profileContext`，先执行同一次创建再返回名册——打开「MCP 管理」就自动完成，不用点任何按钮。每个进程只试一次；失败只记 warn，名册照常返回 `no-writable-include`，页面保留显式按钮重试。
  3. **只改 profile patch 层，不动宿主 root**：root anchor 的文件每次启动被 `prepareProfile` 重写，写它等于丢；`loader.create` 会触发 Include 写回并把补丁拍平（D11 的老坑）。patch 层追加是唯一同时满足「持久」「不拍平」「能热重载」的路径。
  4. **显式入口保留**：名册按钮与「在新增弹窗里把落点切到「全局」」仍执行同一创建，用于自动创建失败、老宿主或手动重试；写成功但没挂载时返回 `mounted: false` 并提示重启后生效。
- **被否决**：
  1. **默认组合里预置一个 Include**：等于替所有用户改组合，且安装前的 profile 不受控；插件安装本身不应重写组合。
  2. **把全局行写到宿主 root Include**：下次启动即丢（D11）。
  3. **只修文案、让用户自己手改 `cordis.patch.yml`**：这正是用户报的问题本身；能自动做的事不该让用户手工编辑 YAML。
  4. **在 `apply` / 启动阶段创建**：boot 期间更新 root Include 的补丁层有重入与时序风险，且用户可能从不打开 MCP 管理；「首次 roster 读」既是用户真的要用它的时机，又不需要按钮。
- **实现**：[`src/mcp-global-include.ts`](../src/mcp-global-include.ts)（纯计划 `planGlobalInclude` + 落盘 `ensureGlobalInclude`）、[`src/mcp-remote.ts`](../src/mcp-remote.ts)（Remote 方法、`listMcps` 的一次性自动创建、boot 重载）、[`src/mcp-roster.ts`](../src/mcp-roster.ts)（名册带 `globalReason`）、[`src/client/McpSection.tsx`](../src/client/McpSection.tsx) / [`McpEditor.tsx`](../src/client/McpEditor.tsx) / [`McpTargetSelect.tsx`](../src/client/McpTargetSelect.tsx)、`locales.ts`。
- **测试**：`npm test` **24 文件 / 268 项**、`npm run test:harness` **7 文件 / 27 项**全绿（含 `tests/global-auto-enable.harness.spec.ts` 的 2 项自动创建用例）；隔离实例真实点击读数见 [testing.md](testing.md) 第十八、二十节。

### D34 空态只留一句「还没有」（2026-10-27）

- **背景**（用户原话指着名册空态的高亮块说：「然后去掉这个描述和新建按钮」）：预设为空时，空态除了标题「这个筛选下还没有 MCP 服务器」，还有一句解释「当前筛选显示…加上所有全局行（全局行已在上面列出）…」和一个「新增到 Agent 预设」按钮。
- **结论**：
  1. **删掉解释句**（`mcp.empty.row.hint` 字典键一并删除）：它把计数与落点筛选已经说清的事再说一遍，而且在全局平面只读时那句「全局行已在上面列出」是错的。
  2. **删掉空态里的新增按钮**（`mcp.empty.addGlobal` / `mcp.empty.addAgent` 一并删除）：列表右上角的「新增 MCP」是唯一的创建入口，空态不必给第二个，也不该替用户预设落点。
  3. **搜索无命中的分支保留**：`mcp.noMatch` + 「换个关键词，或清空筛选框。」说的不是同一件事（那是搜索没命中，不是这一档为空），原样保留。
- **被否决**：
  1. **保留说明句、只删按钮**：说明句本身就是用户要去掉的「这个描述」，而且它在只读全局时是错的。
  2. **把说明句改成一句更短的**：计数「0 行 · 已启用 0」与筛选下拉已经把同一信息说完，再加一句仍属重复。
  3. **保留按钮、把落点做成两个按钮**：正是 D27 收掉的「同一问题两个答案」。
- **实现**：[`src/client/McpSection.tsx`](../src/client/McpSection.tsx) 的 `emptyList`、`locales.ts`（删三个键）。
- **测试**：`npm test` **24 文件 / 268 项**、`npm run test:harness` **7 文件 / 27 项**全绿；隔离实例真实点击读数见 [testing.md](testing.md) 第十九节。

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
| 未加载时的上下文 | 工具名 + instructions（约百 token） | 0 个工具 schema；常驻清单段（服务器名 + 描述，预算封顶） | 同左 |
| 定义何时进上下文 | 搜索结果内联 `tool_reference` | `mcp_load` 原生注册，进工具段（前缀断一次） | `mcp_load` 结果，作为对话内容 |
| 每轮是否仍发全部定义 | **是**（服务端要靠它展开引用） | 否 | 否 |
| 谁做检索 | 服务端 regex/BM25，或客户端自定义检索 | `mcp_search`（打开时）或模型自己选服务器 | 同左 |
| 粒度 | 单个工具 | 单个工具（`query` / `tool` 收窄）或整台 | 单个工具（同左）或整台 |
| 缓存前缀 | 不破（前缀不动） | 每次 load 断一次 | 永不破 |
| 依赖 | 需支持 `tool_reference` 的模型 + 第一方 API | 纯 harness | 纯 harness |
| 服务器进程 | 发现缓存 / 首用才连 | 加载时才 spawn（连接此后留宿主持久池） | 同左 |

### 可迁移结论

1. **前缀稳定优先于"少发请求"。** Claude 宁可每轮把全部定义发出去，也不动 system 前缀。我们的 `lazy` 更进一步（连定义都不发），`dynamic` 则每次 load 付一次前缀失效——这条支持 D2 把默认值留给用户而不是替用户选。
2. **粒度是下一个可优化维度（已落地一部分）。** Claude 是单工具检索；我们原来只有"整台服务器"这一档，一次 `mcp_load` 会把该行**可见的**全部 schema 倒进历史。D16 补齐了 `query`（只加载命中）与 `tool`（按名取一个及其参数），所以不必再靠工具过滤把可见集合收到能接受的范围。仍未做的是 10,000 工具规模下的相关度排序与上限调优。
3. **检索可以自己做（已实现）。** 官方明确允许自定义 search tool 返回 `tool_reference` 等价物；我们的 `mcp_search`（Layer 1 目录）+ `mcp_load` 的 `tool`（Layer 2 单个工具 schema）+ 原生工具 / `mcp_call`（Layer 3）就是这套分层的对应物，见 D16。
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
