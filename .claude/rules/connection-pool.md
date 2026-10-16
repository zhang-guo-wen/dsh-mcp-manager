---
paths:
  - "src/mcp-pool.ts"
  - "src/index.ts"
  - "src/mcp-carrier.ts"
---

> 覆盖：宿主级常驻池的去重键、claim 引用计数、`mcp_unload` 三分支返回值、存活语义、**传输层掉线的感知与恢复**与凭据纪律，以及「按需工具注册不要放 preset 作用域」的实测坑。何时读：改池、常驻/释放语义、掉线恢复、模式切换时的连接回收，或排查「重复起子进程 / 连接不释放 / 崩溃后工具永久失效」时。

# 按需连接池(src/mcp-pool.ts)

**连接属于宿主,不属于加载它的会话。** 池条目按「行身份 + 连接配置指纹」去重(`rowKey` + 连接相关字段
transport / serverName / command / args / env / cwd / url / headers 的 SHA-256 前 16 位十六进制),宿主级持有;
同一台服务器的后续加载——同一会话、别的会话、子代理——都复用同一条连接(stdio 就是同一个子进程)。
每个**加载**对条目持有一个 **claim 令牌**(按次唯一,`<agentId>\u0000<序号>`,视图持有并随视图释放):

- `mcp_load` 命中已有条目直接复用(不重连):`native` 载体在这个 agent 的 tools 上重建**这一代**注册,
  `proxy` 载体按会话保留 `tools` / `hidden` 视图。
- claim 在 `acquire` 之后**立刻**取下,所有错误路径释放同一令牌:不存在"零 claim 窗口";`release` 只结算
  它真正拿过的令牌——释放一个从未 claim 的令牌什么都不关,不会砍掉别人正在装载的连接;`claim` 拒绝已关闭
  的连接,死连接不得登记回池。
- 同一会话对同一台服务器的并行 `mcp_load` 收敛为一个视图:先完成者保留,后完成者撤销自己的注册与令牌、
  对先到视图做 widen,不会互相覆盖。
- `mcp_unload` 只释放**调用方那个视图**的 claim 令牌,结果是三个字段:`released=false`(本会话没加载过)/
  `released=true, stopped=true`(最后一个引用,进程已停)/`released=true, stopped=false`(别的会话仍在用,
  进程与连接都保留)。
- 会话销毁(`bindAgentScope` 用 `agent.ctx.effect` 注册一次清理,每个会话只注册一次)同样只释放该会话的令牌;
  **最后一个 claim 释放时才关闭连接**。
- **存活语义**:连接在宿主进程内保持,直到最后一个会话释放引用、或**提交了不同的加载模式**(工具面重建、
  该模式的引用释放,无人再持有时停止)、或插件卸载。常驻 = **宿主进程生命周期内**,**不是**跨宿主重启持久化
  ——宿主重启后需要重新 `mcp_load`;而"启动与声明重建永不 spawn"是无条件的(见「预加载闸门」)。
- **掉线感知与恢复(2026-10-16)**:连接有**两种结束**——我们自己 `dispose()` 的,和传输层自己断的——必须分开。
  `LazyClient.onclose` 是 SDK 的传输结束回调,它**对我们自己的 `close()` 同样触发**,所以它本身分不清两者;
  池在 `watch` 里把它接到这条连接自己的 `end(lost)` 闸门上,已结束过的连接直接返回,**主动关闭不会被记成丢失**。
  判定为丢失时:连接**立刻移出池**(下一次 `acquire` 因此新开一条,而不是接着发死连接)、warn 一次(带服务器名,
  不含凭据)、调 `ConnectionOpener.onConnectionLost`;注册侧(`McpToolRegistration.connectionLost`)收到后
  **撤回每个会话对这条连接的视图**(释放注册与 claim),行仍留在按需清单里,所以下次 `mcp_load` 会把服务器拉起来
  并注册新的一代工具。据此四条硬约束:
  1. **`closed`(能否再用)与 `disposed`(是否已释放传输)是两个标志。** 丢失的连接 `closed` 为真、`disposed` 为假,
     所以末位释放仍会走一次 `dispose()` 释放 transport;用 `closed` 挡掉 `dispose()` 会漏掉句柄。
  2. **不要复用 `closed` 代替 `disposed` 做幂等判据**,否则第二次 `release` 或丢失后的 `release` 行为会漂。
  3. **`claim` 拒绝丢失的连接**(它 `closed`),死连接不得登记回池。
  4. **不要给池加自动重连监督器或空闲 TTL**:池是按需语义,没有"保持在线"的义务;崩溃后最便宜的恢复是下次
     `mcp_load` 重开。理由与否决方案见 [docs/design-decisions.md](../docs/design-decisions.md) D23。
  **未覆盖**:stdio 子进程被强杀后传输层是否**必然**回调,本轮没有实测;**挂死**(进程还在、既不结束也不响应)
  既没有 `onclose` 也没有超时,池不会做任何事。
- 池的操作串行化,两个会话同时加载同一台不会开出两条连接;连接配置变化会开出**新条目**,旧连接继续服务仍在
  用它的会话。指纹只进键与日志,**`env`/`headers` 的值不落日志、不进错误消息**(易崩清单第 12 条)。
- `eager` 不走池:preset 是 standing mount,全局共享一个实例。

**坑(实测):不要把注册放在 preset 作用域。** 曾把按需工具做成 preset 行(`inject: ['tools']`,在 preset 的
standing 作用域里 `ctx.tools.register`),结果 **preset 每 ~5 秒被重挂一次**(MCP 子进程反复重启)。
撤掉该行即恢复。所以注册落在 **host 平面**(插件 `apply` 时的 root ctx):`ctx.effect` 收口。

模式是**活的用户设置**:`readMcpSettings(config)` 读 Config 的 volatile 字段,`index.ts` 在
`loader/volatile-update` 上先 `dispose()` 掉旧注册(工具面重建、该模式的会话 claim 一并释放,无人再持有的连接
随之停止)再按新模式注册 —— 交换对**所有会话的下一次请求**生效。池对象本身跨这次重建存活,只在插件卸载时
整体 `dispose()`(见「按需连接池」)。`parseMcpLoadingMode` 把无法识别的存量值收敛回 `dynamic`(设置文档是用户可编辑的,
不能因为一个拼错的值让提交失败)。UI 侧是 `McpSection.tsx` 的 `McpLoadingPicker`(一个 `SegmentedControl` 三选一,
选中项的说明显示在下方),读写 `loading` 字段。
