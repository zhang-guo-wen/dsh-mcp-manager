---
paths:
  - "src/mcp-gate.ts"
  - "src/preset-mounts.ts"
  - "src/index.ts"
---

> 覆盖：`src/mcp-gate.ts` 在 `dynamic`/`lazy` 下「允许但不预加载」的三条抑制路径（发布点抑制 / 挂载前拦截 / late hold）、归属判据、`reconcile` 的性质与「两个平面都不写声明」的红线（自原「加载模式、载体与预加载闸门」拆出）。何时读：改闸门、抑制与恢复路径、归属判定，或排查「启动被拉起 / 切回 `eager` 不恢复」时。

# 预加载闸门(src/mcp-gate.ts)

## 预加载闸门(src/mcp-gate.ts)

`dynamic`/`lazy` 下"允许但不预加载"覆盖**两个平面**——preset 行与全局行——靠**三条互补的抑制路径**,都不写文件:

- **(a) 发布点抑制**(行在本插件 `apply` 之后才发布):gate 订阅 Cordis 的 `internal/plugin`,在该 fiber 发布那一刻
  **同步** `fiber.dispose()`。Cordis 紧接着才解析依赖并激活,被处置的 fiber 直接跳过激活 ——
  **`mcp-client` 的 `apply` 从不执行,子进程不会 spawn**。
  **只对 preset 行用这条**:全局行用发布点处置会把闸门状态写回用户文件(见下)。
- **(b) 挂载前拦截**(行在本插件 `apply` 之前就已建好:Loader 先把组合里的 entry 全建出来,再逐个 import 插件,
  这段窗口没有发布可观察):`index.ts` 在 `apply` 第一条语句同步订阅 `loader/entry-init`,交给
  `gate.onEntryInit(entry)`。`holdBeforeMount` 只在**这一个 entry 实例**上遮蔽 `disabled` 自身属性(不动声明)、
  并拦截它**第一次 `update()`** —— Loader 正是用 `update` 赋 options、紧接着 import 插件,所以在 update 里确认
  `options.name === '@deepseek-ai/dsh-mcp-client'`(options 取自该次 `update` 的入参,此时 entry 上还是上一版)
  再判归属,命中就让 `update` 直接 return,**插件从不被 import**;不是本插件的行立即还原(无副作用)。
  **file-backed Include 子树里的全局行走这条;写在组合本身里的全局行走下面的 (c)。**
  **订阅必须装在 `apply` 第一条语句(任何 `await` 之前)**,否则这段窗口已经过去。
- **(c) late hold**(全局行的兜底:行写在**组合本身**里 —— root anchor 或补丁层 insert —— Loader 在本插件 import 之前
  就把它建好并 import 完了,(b) 的窗口也够不着):`run()` 里 `!wantMounted && !held && mounted` 时由
  `holdMountedGlobal(entry)` 事后接管。**顺序是硬要求:先 `Object.defineProperty` 遮蔽 `disabled`,再
  `fiber.dispose()`** —— Loader 的自处置分支只在 entry 已读作 disabled 时才不落盘(`vendor/loader/src/index.ts:160-165`),
  顺序反了就会把 `disabled` 写回用户的组合文件。切回 `eager` 由 `releaseGlobalHold` 撤销遮蔽;`Entry.update` 不写文件。

**两种全局行形状与产品口径(隔离实例 2a–2d + 1 秒间隔采样复测)**:行放在**独立的 file-backed Include 文件**里
(推荐) → 该 Include 作为组合行在本插件之后激活,(b) 直接挡住,**连插件回调都不发生**;行写在**组合本身**里 →
已挂载的行由 (c) late hold 事后接管。**两种形状在这套 fixture 上都是"启动零拉起"**(1 秒采样:四个 marker 从未创建、
进程数 0);差别只在插件回调层面:形状 B 的 `mcp-client` `apply` 会被调用一次(harness `applyCalls === 1`),
但**没有留下子进程** —— "形状 B 会多起一个子进程"在真实实例上不成立。**两种形状的按需加载、池复用、
`mcp_unload` 三分支、不写回都通过**。**未实测**:真实 `npx -y` 服务器的冷启动路径(fixture 直接 `node` 调用,
刻意避开 npx 的 7.5–23 秒),所以"形状 B 在 `npx -y` 下是否会有可观测的瞬时进程"没有实测。
`globalWritable` 的判据在名册侧:**形状 A 现在是 `true`(行写在自己的 Include 文件里,设置页可以开关)**,只有 root anchor
时是 `false`;由组合/补丁层声明的行即使平面可写也**行级只读**(`readOnly: 'composed-row'`)—— 见「名册读取」。

**归属判据分两种树:**

- **preset tree**:三层判定(`presetOwnedTree`,[`src/preset-mounts.ts`](../src/preset-mounts.ts)):① reader 已捕获的树按身份;
  ② entry 祖先链里有 preset 声明(`tree.ctx.fiber.entry` 向上找 `AGENT_PRESET_MODULE`);③ 该 tree 的 `ctx` 属于
  standing preset scope(`scopes.scopeOf(tree.ctx) !== undefined`,与 `observe()` 捕获判据同源)。
  **第 ③ 层是必需的**:preset tree 的 `ctx` 不是由 Loader entry 建成的(它的 fiber 没有 `entry`),只靠 ② 走不到 ——
  这正是第一次隔离实例实测失败的真因(见 [docs/testing.md](../docs/testing.md))。
- **全局 tree**:`isGlobalPlaneTree(tree)` = 有**字符串 `filename`** 且 **`write` 是函数**(file-backed `Include` 的特征);
  `ownsGlobalTree(tree)` 额外接受 owner entry 名为 `cordis:include` / `@deepseek-ai/cordis-plugin-include` 的树
  (全局行自己的 entry 在 Include 建完之前就被观察到,那时只能靠 owner 名认)。
  **不能用 `ctx === undefined` 判定** —— `EntryTree` 基类给每棵树都设了 `ctx`(这是第一版的真缺陷);preset 树没有
  `filename`,host 组合自己的树与别的插件的 detached 子树两种判据都不命中,保持原状。

**全局行绝不能用发布点 `fiber.dispose()`**:`vendor/loader/src/index.ts:160-165` 在 fiber 自处置时会
`entry.options.disabled = true` + `entry.parent.tree.write()`,而全局行的树是 file-backed `Include` ——
**会把闸门状态写回用户的 `cordis.yml`**。全局行只能在内存里拦截(遮蔽 + 拦截首次 `update`),任何时刻都不改它的 options。

**全局行按需加载**(`gate.globalRows()`):从 Include 子树**递归**读行(嵌套 group 也读),返回
`{entryId, enabled, held, mounted}`。**`enabled` 必须读声明 `entry.options.disabled !== true`,不能读实例上的 getter**
—— 被遮蔽的行会被读成"用户禁用",于是 `mcp_load` 直接拒绝(verify-instance 实测到的 G2 缺陷)。
`mcp_load` 对 held 的全局行**不释放 hold**,直接走宿主级常驻池;只有切到 `eager` 时才由
`releaseGlobalHold(entryId)` 撤销拦截并 `entry.update({disabled:false}, false, true)` 让 Loader 真正挂载 ——
`Entry.update` **不写文件**(写文件的只有 `EntryTree.create/update/remove` 与 fiber 自处置)。

`reconcile()` 里原有的 `entry.update({disabled})` 仍然保留:它读每个 preset 代次的**声明快照**、继承祖先分组禁用、
用该行 Loader evaluator 求 `!!js`(拒绝求值则不允许),让 live 行满足 `mounted === (allowed && mode === 'eager')`,
作为幂等、可重放的补充路径(漏网路径与 eager↔dynamic 恢复都靠它)。
**必须读声明,不能读 live 行** —— live 行正是 gate 自己摘掉的,读回来会把摘过的行永久锁死。
四条必须记住的性质:

1. **不写声明,两个平面都不写。** preset 树是 registry 的内存树(`PresetTree`),`write()` 是空实现,所以内存里摘行
   不会碰用户的 profile patch。**全局行同样只在内存里拦截** —— 它们的树是 file-backed `Include`,一旦让 fiber
   自处置(`fiber.dispose()`)或走 `EntryTree` 写路径,`write()` 就会把闸门状态写回用户的 `cordis.yml`;
   所以全局行的 options 一概不改,挂载与摘除都靠实例遮蔽 + `entry.update`(`Entry.update` 不写文件)。
2. **触发点。** `tools/change`、`loader/entry-init`、`loader/partial-dispose`、相关 `internal/status` 和
   `agent-preset/selected` 都使快照失效。entry-init 在 parent/options 赋值前发出，必须下一 microtask 再观察。
   同步批次合并，`reconcile()` 内部串行化、幂等、可重放。
   **另有两处"取行集合变化"必须自己上报**:`createMcpPreloadGate(..., onRowTaken)`(gate 刚接管一行)与
   `createPresetMountReader(ctx, scopes, onCaptured)`(新 preset 代次变得可读),`index.ts` 据此 `queueMicrotask(resync)`。
   被 hold 的行**没有 fiber**,所以过去那些 `internal/status` 事件不会发生 —— 靠 fiber 状态事件驱动清单刷新,会让
   系统提示里的 MCP 清单**一直为空**(真实回归)。
3. **一次 reconcile 会真的 kill 掉 MCP 子进程**(`entry.update` 走 `Entry._dispose`),所以设置页先等
   `gateState`(它内部 await reconcile)再读名册,否则会看到"摘到一半"的名册。
4. **抑制不是闩锁,而且抑制是一等状态。** 切回 `eager` 后同一行要能重新挂载:preset 行由 `reconcile()` 在
   `wantMounted` 分支先 `releasePreHeldRow(leaf)` 还原 (b) 路径的遮蔽与 `update` 拦截,再
   `entry.update({disabled:false})`;全局行走 `releaseGlobalHold(entryId)`(撤销拦截 + `entry.update({disabled:false},
   false, true)` 让 Loader 真正挂载)。
   **这条有真实反面案例**:只还原 `entry.disabled` 而漏掉遮蔽时,该行的 `entry.disabled` 恒为 true,行静默死亡
   直到宿主重启。`zero-launch` 的 `holds a row that was declared before the plugin activated`、
   `global-zero-launch` 的五项(含 late hold 的接管与恢复)与 `on-demand-pool` 的
   `mounts the row under eager and mounts it again after suppression` 固定了这些路径。
   被抑制的行(两个平面、三条路径)的 fiber/状态都可能读成"已停止",所以 gate 单独登记 `suppressedEntryIds()`;
   名册据此报 `fiberPhase: 'held'`(见「名册读取」),UI 对它不显示标记。

同名坑:**`@Remote` 方法的形参名必须是 `request`**。网关按方法签名推导 descriptors,写成 `_request` 会让调用方收到
`args fields do not match the descriptor: unexpected "request"`,而客户端如果吞掉这个错误,表现就是"开关没反应"。

第 5 条性质:**配置不完整的行也不挂载,和"模式不预加载"共用同一条摘行路径。**
`allowed` 是 `declaredRow.enabled === true && diagnoseRowConfig(declaredRow.options.config).length === 0`
(见「配置诊断」)。区别在语义与 UI:模式造成的未挂载不该显示成状态,配置造成的必须显示且不许开启。
preset 行由这条判据直接摘除;全局行不参与这条判据(闸门不读它们的配置),它们的配置问题只由名册标记 ——
与"模式造成的未挂载"是两件事,UI 上分别对应「未配置」与不显示标记。
