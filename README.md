---
description: "Manage MCP servers in DeepSeek Harness, load them on demand, and filter tools to reduce context usage"
kind: "plugin-readme"
---

# @guowenzhang/dsh-mcp-manager

[中文](<README.zh.md>) | English

## The problem this plugin solves

Adding MCP servers to DeepSeek Harness is inconvenient, and loading every configured server's tools by default consumes substantial context.

This plugin adds server creation, editing, and Claude Code configuration import to the settings page. With on-demand loading, the initial context contains only MCP names and descriptions; the model enables servers as needed during a session. Tool filtering lets you load only the tools you select.

In the plugin list, display names and descriptions follow the Harness language setting in English or Chinese (English is the default fallback); English names use the package name without its npm scope, Chinese names describe the purpose, and installation still uses the unchanged real package name.

## Screenshots

**MCP management**

![MCP management](<docs/images/mcp-settings.png>)

**Configuration and tool filtering (left), Claude MCP import (right)**

[![MCP configuration, tool filtering, and Claude configuration import](<docs/images/mcp-editor-import.png>)](<docs/images/mcp-editor-import.png>)

These screenshots show an earlier UI. Configuration and Tools now use separate tabs, and Claude configuration import supports the selected Global or Agent-preset destination.

## Install

Requires DeepSeek Harness, `pnpm`, and Node.js ≥22.18 or ≥24.2.

```sh
npx @deepseek-ai/dsh plugin --profile web add @guowenzhang/dsh-mcp-manager@^1.1.0
```

Restart the host and refresh the page, then open **Settings → MCP management → Agent** to add or import servers and describe their purpose. Dynamic insert is the default; to filter tools, keep only the tools you need under **Edit → Tools**.

See [AGENTS.md](https://github.com/zhang-guo-wen/dsh-mcp-manager/blob/master/AGENTS.md) for other installation methods and development instructions.

## Notes

- **For profile composition rows, on-demand loading and tool filtering apply to Agent-preset MCP servers**. Global composition rows always load, and Load all (`eager`) does not support filtering either. Add or import servers into an Agent preset to save context. Repository MCP servers handed over by Resource Manager can also load on demand, including global resources.
- **Dynamic insert (`dynamic`, default)** adds tools to the current session when needed. **Lazy loading (`lazy`)** calls tools through a fixed proxy without changing the tool list. The model uses `mcp_load` / `mcp_unload` to load and unload servers on demand.
- Tool filters take effect on the next load; already-loaded servers are not updated automatically. Loading a server or listing its tools requires a connection and may wait for a child process to start. A preset's first activation may also briefly start and stop its MCP servers.
- Import reads only Claude Code and project MCP configurations without modifying the source files. Filtered servers in `dynamic` mode do not provide server instructions or resource tools.
- Host updates may introduce compatibility changes; this version has been tested with DSH `0.2.1-alpha.1`. Incompatible MCP clients must be updated separately. See the [design notes](<docs/design-decisions.md>) for detailed limitations.

## License

Apache License 2.0 — see [LICENSE](<LICENSE>). Includes MIT-licensed portions derived from DeepSeek Harness; see [NOTICE](<NOTICE>).
