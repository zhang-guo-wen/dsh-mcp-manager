---
description: "在 DeepSeek Harness 中便捷管理 MCP，按需加载并筛选工具，减少上下文占用"
kind: "plugin-readme"
---

# @guowenzhang/dsh-mcp-manager

中文 | [English](<README.md>)

## 解决什么问题

DeepSeek Harness 添加 MCP 不够方便，配置多个 MCP 后默认全部加载工具，占用大量上下文。

本插件在设置页提供 MCP 新增、编辑和 Claude Code 配置导入。使用按需加载时，初始上下文只保留 MCP 名称和描述，模型在运行过程中按需启用；同时支持工具过滤，只加载选中的部分工具。

插件列表的显示名称与介绍支持英文和中文，随 Harness 语言设置显示，英文为默认回退；英文名称为去掉 npm scope 的原包名，中文名称说明用途，安装仍使用不变的真实包名。

## 截图

**MCP 管理页**

![MCP 管理页](<docs/images/mcp-settings.png>)

**配置与工具过滤（左）、导入 Claude MCP 配置（右）**

[![MCP 配置、工具过滤与 Claude 配置导入](<docs/images/mcp-editor-import.png>)](<docs/images/mcp-editor-import.png>)

截图为早期界面示例。当前配置与工具列表分为独立标签页，Claude 配置可导入到当前选中的全局或 Agent 预设。

## 安装

需已安装 DeepSeek Harness、`pnpm`，并使用 Node.js ≥22.18 或 ≥24.2。

```sh
npx @deepseek-ai/dsh plugin --profile web add @guowenzhang/dsh-mcp-manager@^1.1.0
```

安装后重启宿主并刷新页面，打开 **设置 → MCP 管理 → Agent**，新增或导入 MCP，填写用途描述。默认使用「动态插入」；需要过滤工具时，在 **编辑 → 工具列表** 中只保留所需工具。

其他安装方式与开发说明见 [AGENTS.md](https://github.com/zhang-guo-wen/dsh-mcp-manager/blob/master/AGENTS.md)。

## 注意事项

- **对于 profile 组合声明行，按需加载与工具过滤适用于 Agent 预设中的 MCP**。全局组合声明行始终加载；「全部加载」（`eager`）也不支持过滤。需要节省上下文时，请添加或导入到 Agent 预设。资源管理器交接的仓库 MCP 也支持按需加载，包括全局资源。
- **动态插入（`dynamic`，默认）**在需要时将工具加入当前会话；**延迟加载（`lazy`）**通过固定代理调用工具，不改变工具列表。模型使用 `mcp_load` / `mcp_unload` 按需加载和卸载。
- 工具过滤在下一次加载时生效，已加载的 MCP 不会自动更新。加载或读取工具列表需要连接服务器，可能等待子进程启动；预设首次激活时也可能短暂启动再停止 MCP。
- 导入只读取 Claude Code 和项目 MCP 配置，不修改来源文件。`dynamic` 模式启用工具过滤后，不提供服务器 instructions 与资源工具。
- 宿主更新可能带来兼容性变化；当前版本已在 DSH `0.2.1-alpha.1` 上验证。遇到不兼容的 MCP 客户端需单独更新；详细限制见 [设计说明](<docs/design-decisions.md>)。

## 许可证

Apache License 2.0，见 [LICENSE](<LICENSE>)。包含源自 DeepSeek Harness 的 MIT 许可部分，见 [NOTICE](<NOTICE>)。
