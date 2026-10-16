> 覆盖：`tools` 规则的语法(allow/deny/通配)、过滤点、`global:` 规则为何不生效、`hidden` 计数，以及编辑弹窗「工具列表」tab 的可视化规则与它的连接时机。何时读：改工具过滤规则、过滤点，或改编辑弹窗的工具列表时。

# 工具过滤与工具选择 UI

## 工具过滤(src/mcp-tool-filter.ts)

一台服务器几十个工具、常用只有几个时,`mcp_load` 一次就把全部 schema 倒进会话历史。过滤规则存在
`mcp-manager` 设置的 `tools` 字段里,键是 `mcpRowKey(target, serverName)`,值是一个字符串数组:

- 不带 `!` 的条目 = 保留(allow);只要有一个 allow 条目,这台服务器就是**白名单**;
- `!` 开头的条目 = 隐藏(deny);只有 deny 条目时是**黑名单**;
- `*` / `?` 通配,其余正则元字符都转义,大小写敏感。

四条实现约束:

1. **过滤点跟着载体走。** `proxy` 载体两个点都要:`mcp_load` 的返回(模型看不到被隐藏的工具名)与 `mcp_call`
   的入参校验(拿旧名字调用会被拒绝)。`native` 载体只需要前者 —— 被隐藏的工具根本没有注册,模型照历史名字调用
   直接得到未知工具;`mcp_call` 对这类行也拒绝(它只服务 `proxy`)。
2. **过滤不切换载体**(见「载体选择」)。`eager` 下规则不生效 —— 该模式由 harness 的 mcp-client 整台挂载,插件没有
   插手的点 —— `index.ts` 的 `warnFiltersWithoutEffect` 会在启动和每次提交时警告。
3. **`global:` 的规则同样不生效,而且 UI 不可改。** 全局行由组合直接挂载,工具已经进了每次请求,规则藏不掉它
   (`mcp_load` 那份是**另一份**实例)。所以:`warnFiltersWithoutEffect` 在非 `eager` 模式下只对 `global:` 键警告;
   编辑弹窗的「工具列表」对全局行**整体只读**(按钮与勾选框全禁用 + 给出原因),切 tab 也不会去连一次服务器,
   保存更不会写规则。要过滤就把行写到 Agent 预设里。
4. **规则 reader 是活闭包而不是快照**:`registerMcpTools(ctx, mode, gate, { filterFor, descriptionFor })` 收的是读者,
   `index.ts` 在 `apply` 里把它们指向 `readSettings().tools` / `readSettings().descriptions`。所以改规则不需要重建注册,
   下一次 `mcp_load` 就读到新值;已经加载的服务器保持加载时那套工具(不追溯),服务器自己发 `tools/list_changed`
   时也按加载时那套规则重算。

`mcp_load` 的结果带 `hidden` 字段(被隐藏的数量),render 里有一行提示 —— 模型需要知道"还有工具但不可调用",
否则会照历史里的名字硬调。

弹窗保存的就是这份 deny 列表 —— 取消勾选 `delete_workitem` 会写成:

```yaml
mcp-manager:
  tools:
    "preset:standard-yunxiao:alibaba-devops-mcp":
      - "!delete_workitem"
```

## 工具选择 UI(src/client/McpEditor.tsx)

编辑弹窗分成「配置」与「工具列表」两个 tab,后者是规则的可视化入口:勾选 = 可见,取消勾选 = 隐藏,默认全勾。

- **数据来自 `mcpManager.listMcpTools`**(`mcp-remote.ts`),它按**表单当前的 spec** 连一次服务器并
  `listTools`,返回 `{name, description}[]`,完成后 close。之所以传 spec 而不是 `entryId`:新增行还没有 entryId,
  而且用户在弹窗里改了 command/url 后点"加载工具列表"应该按新配置拉。连接有 30 秒超时(`withTimeout`)。
- **默认全勾 = 没有规则。** 勾选状态由 `admits(parseMcpToolFilter(toolRulesInitial), name)` 算出,所以手写的
  allow/通配规则在 UI 里也显示正确;保存时展开成 `!<name>` 的 deny 列表,全勾则写空数组 → 删掉该键。
- **连不上就不动规则。** `tools === null` 时保存只提交连接配置 —— 否则一次连接抖动会清掉用户已有的过滤。
- **切到「工具列表」tab 才会真起一个 MCP 连接**(stdio 是新的子进程,`npx -y` 那种 1-3 秒):edit 模式首次切过去
  自动拉,add 模式靠按钮,因为新增时表单里的 spec 常常还是空的。只改描述就不进这个 tab,不会白起一个进程。
- **全局行整块只读**(`toolsReadOnly`):按钮与勾选框禁用、切过去也不连接、保存不写规则,并在原提示位置说明原因
  (`mcp.form.toolsGlobal`)—— 全局行由组合挂载,规则藏不掉它已经进上下文的工具(见「工具过滤」第 3 条)。
- **改 client 后必须重建 `lib/client.js`**;Host 用内容 revision 让浏览器加载新 bundle,`HANDOFF_ID` 不得改变。
  改了 CSS module 要核对类名两边都在:JSX 引用了 CSS 里没有的类只得到 `undefined`,静默无样式。
