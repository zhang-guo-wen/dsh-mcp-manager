---
paths:
  - "src/mcp-inventory.ts"
  - "src/mcp-optimize.ts"
  - "src/mcp-catalog.ts"
  - "src/client/McpOptimizeSection.tsx"
  - "src/client/McpOptimizeSection.module.css"
---

> 覆盖：系统提示里的按需清单(快照语义、预算与截断、模型可见原文)、`optimize` 的三层粒度(选择/列表/形态)、游标分页语义、目录缓存失效与 `mcp_search` 的连接纪律。何时读：改按需清单、`mcp_load`/`mcp_search` 的参数与返回，或改优化策略与目录缓存时。

# 上下文预算：按需清单与优化策略

## 按需清单(src/mcp-inventory.ts)

`dynamic`/`lazy` 下请求里没有任何 MCP 工具 schema,所以**服务器名单必须主动出版**:`registerMcpTools` 在
`systemPrompt.section` 上注册 `mcp-manager:on-demand`,位置用 harness 预留的 `MCP_SERVERS`(与 mcp-client 放
server instructions 同一个位置)。四条契约:

1. **渲染是纯函数。** `renderMcpInventory(rows, mode, search)` 只吃「名字 + 描述」与两个开关,不碰 Loader/preset,所以 vitest 能直接跑。
2. **段文本是快照,装配时不能 await。** 系统提示装配是同步的,所以注册句柄持有 `inventory` 字符串,由返回的
   `refresh()` 重读 allowed rows 再渲染;`index.ts` 在 `gate.reconcile()` 之后、以及模式提交后各调一次。
   漏调的表现是模型看到上一版名单 —— 新增的行它永远加载不了。
3. **绝不写"是否已加载"。** 那会让每次 `mcp_load` 都重写系统提示 → 整个前缀(系统 + 工具 + 历史)失效,
   比工具列表变化贵得多。加载状态本来就在会话历史里。
4. **预算只削描述,不删名字。** 单条 80 字符、整段描述预算 900 字符;超预算先丢描述,**服务器名永远列全**
   (模型看不到名字的服务器就加载不了)。`interpolate: false` —— 描述是用户文本,`{{...}}` 必须原样保留。
5. **只提这次真的注册了的工具。** 那句导语按模式点名 `mcp_load` / `mcp_unload` / `mcp_call`,并在
   `searchEnabled` 为真时才提 `mcp_search`。`searchEnabled` 在注册时取一次(不是每次装配读活设置),
   否则设置刚提交、注册还没重建的那一瞬间,模型会被指向一个不存在的工具。

`registerMcpTools` 因此返回 `{ dispose, refresh, toolsChanged }`;第四参数是三个活闭包 `{ filterFor, descriptionFor, optimize? }`,第五个是宿主级常驻池 `pool`,第六个是 `external`、第七个是 `catalog`。

清单段的原文(每行 `名字 — 描述`,描述取自该行的设置;这段是模型可见文本,改动要同步快照):

```
MCP servers available on demand: call `mcp_load` with one of these names to add that server's
tools to this session — pass `query` to add only what matches, or `tool` for one tool and its
argument schema — and `mcp_unload` with the same name to release it again.

- alibaba-devops-mcp — 云效MCP，任务管理工具，可以操作
- playwright
```

`search` 打开时导语多一句前置说明:`MCP servers available on demand: Use \`mcp_search\` to find tools by
what they do without loading a server, and call \`mcp_load\` …`。

## 优化策略(src/mcp-optimize.ts、src/mcp-catalog.ts、src/client/McpOptimizeSection.tsx)

规范侧能用的只有两件:游标分页,以及 2026-07-28 的 `CacheableResult`(`ttlMs` / `cacheScope`)。`tools/list`
**没有** `query` 参数,也**没有**「只列名称」的线上形态(`inputSchema` 必填),所以检索、只带名称、目录缓存
都只能做在宿主侧 —— 官方《Client Best Practices》正是这么要求的(`search_tools` → `get_tool_details` → 执行)。
三条粒度互不替代,写在 `optimize` 字段里,由 `parseMcpOptimizeFlags` 收敛:

1. **选择**:`mcp_load` 的 `query`(词法匹配,离线、无 embedding)与 `tool`(按名取一个)收窄**能调用**的集合;
   **载体不变**(`dynamic` 一律 `native`,收窄只决定注册哪些定义,见「载体选择」)。已经加载过的服务器再给新
   `query` 只会**加宽**(`widen`),永不收窄。
   **不带 `query`/`tool` 的调用 = 整台**:它会把已收窄的会话视图**加宽回当前可见全集**,并在结果里如实报
   `widened: true`(render 里也有一行说明)——所以"只加宽、永不收窄"是自洽的,不是漏判。
2. **列表**:`cursor` / `limit` 只分页结果(默认 `pageSize`),`loaded` 仍是全部被选中的工具 —— 分页是上下文预算,
   不是能力开关。模型要知道"还有工具",靠 `nextCursor`,不靠少注册几个工具。
   **`cursor` 的空白串(`''` 或纯空白)等价于"从头开始"**(`mcp-optimize.ts` 的偏移解析),与"空串是合法游标"对称;
   `undefined` 才是"没给",只有 `nextCursor === undefined` 表示列完。
3. **形态**:`namesOnly` 默认让 `mcp_load` 只带名称与描述;`tool`(按名要一个)默认升到 `full`,因为那正是要参数的时机。

其余开关与实现约束:

- **`mcp_search` 只在 `search` 打开时注册**,所以 `index.ts` 用 `mcpRegistrationKey(policy)` 参与"是否重建注册"的
  判断(与加载模式同一条 `external.transition` 路径)。**其余策略字段一律在调用点读活值**,不要为它们重建注册。
- **`listAllTools(client, maxTools)` 是唯一的发现入口。** 游标按规范当**不透明字符串**:空串是合法游标,
  只有 `nextCursor === undefined` 才是结束(写成 `if (!next)` 会静默丢掉第二页);页数封顶 `MAX_TOOL_PAGES=64`,
  采集量封顶 `maxTools`,被截断时结果带 `truncated: true`。
- **全部工具目录进 SQLite**：stdio 与 HTTP/SSE 统一以工具公开定义 + SHA-256配置摘要存入宿主 home/cache 下 profile 隔离的 catalog.sqlite。不读旧JSON、不双写、不保留云端memory-only流程。探测成功须 await flush；配置声明单独保存，失败探测不挡保存。
- **新鲜度只有服务器声明**：删除catalogTtlMs设置、默认值、范围、控件和文案。本地stdio不按时间过期；HTTP有ttlMs时按该值过期、下一次检索限并发重新发现（即使searchIndex关闭）；HTTP无TTL长期保留，显式refreshCatalog只刷新当前启用HTTP/SSE、不spawn本地。通知list_changed依旧invalidate对应数据库记录；clear全部目录并await flush，epoch+DB generation防旧发现回写。
- **`searchIndex` 只控制尚无目录的冷发现**（3并发、8秒预算）；关闭时仍允许刷新已知过期HTTP，未知服务器以pending返回。缓存必须先按当前允许行与连接摘要检索，不能从数据库恢复凭据或调用授权。
- **收窄到空的加载不建立 mount。** `query` 没命中时返回空结果并关掉连接;`tool` 给的名字不存在时直接报错。
  否则会话会挂着一个空 mount,之后连"加载整台"都只能看到空列表(要 `mcp_unload` 才能恢复)。
- **注解是策略输入,不是承诺。** `hideDestructive` 只认显式 `destructiveHint: true`(规范里缺省值是 true,
  按缺省处理会把没有注解的服务器整台藏掉);`annotations` 只把服务器**真的声明过**的提示带进列表。
- **策略是同一个设置页的「上下文」页签**(2026-10-16 起,不再是独立的 `settings.section`),复用同一个 controller
  与 inject face。它按字段 merge 写 `optimize` 开映射,每个字段有自己的保存中/已保存状态(按字段存,不用单个
  `savingField`,否则两个字段同时写会互相清掉提示;「已保存」2.5 秒后自动消失)。目录状态位于**工具目录缓存标题下同组**,没有TTL偏好行；纯状态读取 `catalogState`、显式服务器刷新 `refreshCatalog`、全量清空 `clearCatalog` 三个 Remote(注意:新增 Remote 要三处齐,
  见「Typert Remote」)。策略解析复用 `src/mcp-optimize.ts`,**不要在浏览器侧再写一份默认值**,否则两侧会漂移。
