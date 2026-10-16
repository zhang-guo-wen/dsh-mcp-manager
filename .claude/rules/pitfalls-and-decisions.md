---
paths:
  - "docs/design-decisions.md"
  - "docs/competitive-landscape.md"
---

> 覆盖：44 条易崩清单（每条都是踩过的真实故障）与 D1–D17 技术决策表（自原「工程契约与历史台账」拆出）。何时读：改加载/闸门/池/过滤相关代码前扫一遍踩坑清单，或需要查某条决策的理由与被否决方案时。

# 易崩清单与技术决策

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

实现侧的理由与踩坑在 `.claude/rules/` 各文件(「延迟加载」「载体选择」「按需清单」「预加载闸门」「工具过滤」「优化策略」);同类插件对比与
功能路线图归 [docs/competitive-landscape.md](../docs/competitive-landscape.md)。
