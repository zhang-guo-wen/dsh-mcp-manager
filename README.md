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

These screenshots show an earlier UI. Configuration and Tools now use separate tabs in the editor, and Claude configuration import writes to the plane you are on — the Global group, or the preset chosen in the dropdown. The loading mode is a three-way segmented control whose explanation sits underneath, and a switch that fails reports in its own row with a retry.

## Install

Requires DeepSeek Harness, `pnpm`, and Node.js ≥22.18 or ≥24.2.

```sh
npx @deepseek-ai/dsh plugin --profile web add @guowenzhang/dsh-mcp-manager@^1.1.0
```

Restart the host and refresh the page, then open **Settings → MCP management** to add or import servers and describe their purpose. The roster is one list with a Global group first and the Agent rows below it. Dynamic insert is the default; to filter tools, keep only the tools you need under **Edit → Tools**, and use **Settings → MCP optimization** to control how much of a tool list reaches the model.

See [AGENTS.md](https://github.com/zhang-guo-wen/dsh-mcp-manager/blob/master/AGENTS.md) for other installation methods and development instructions.

## Reduce context further: search, paging, names only

Settings → **MCP optimization** controls how much of a tool list reaches the model. The MCP specification has no query parameter on `tools/list` and no names-only listing, and the [client best-practices guide](https://modelcontextprotocol.io/docs/2026-07-28/develop/clients/client-best-practices) places progressive discovery in the host — which is what this page is:

| Setting | Effect |
|---|---|
| **Tool search** (`search`) | Registers `mcp_search`: the model finds tools by keyword across every discovered server and gets names plus one-line descriptions only. |
| **Index uncached servers** (`searchIndex`) | Lets a search connect to a server it has no tool list for (3 at a time, 8 seconds each). Off by default, so a search stays a cheap read. |
| **Items per listing** (`pageSize`) | `mcp_load` / `mcp_search` list at most this many items and return `nextCursor` for the rest. |
| **Names and descriptions only** (`namesOnly`) | `mcp_load` omits argument schemas by default; asking for one tool by name still returns that tool's full schema. |
| **Tools collected per server** (`maxTools`) | Caps the paginated `tools/list` walk, so an enormous server cannot flood a request. |
| **Cache lifetime** (`catalogTtlMs`) | How long a discovery result can answer a search without reconnecting. A shorter `ttlMs` from the server wins, and `notifications/tools/list_changed` invalidates that server immediately. |
| **Show tool annotations** (`annotations`) | Carries the server's `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint` into listings. |
| **Hide destructive tools** (`hideDestructive`) | Keeps tools whose `destructiveHint` is explicitly true out of the session entirely. |

The same page shows what the tool catalogue has cached (servers, tool counts, age) and can clear it. Every switch is a live setting: it applies to the next load, search, or re-index without a restart.

## Notes

- **On-demand loading covers both planes, and nothing starts at host start-up.** Under Dynamic insert (`dynamic`, default) and Lazy loading (`lazy`) an allowed row is suppressed before its plugin ever runs, so host start-up and Agent preset rebuilds start no MCP process at all; the first `mcp_load` starts the connection. Global composition rows follow the same loading mode: Load all (`eager`) mounts them from the composition, while `dynamic` / `lazy` keep them held until `mcp_load` starts one on a connection shared with other sessions. Tool filters still do not take effect on a global row.
- **Load on demand, then reuse.** Connections live in a host-level pool keyed by row and connection configuration: the same server loaded again — by the same session, another session, or a subagent — reuses that one connection (for stdio, the same child process). `mcp_unload` releases only the calling session's reference; the server stops when the last session releases it, and a session that ends releases its references. The connection lives as long as the host process — committing a different loading mode rebuilds the tool set and releases that mode's references, and a host restart means loading the server again. "Nothing starts at start-up" holds whether or not the server was loaded before.
- **Dynamic insert (`dynamic`, default)** adds a server's tools to the session that loads it, registering only the tools your filter and the load request keep; **Lazy loading (`lazy`)** calls tools through a fixed proxy without changing the tool list. The model uses `mcp_load` / `mcp_unload`, and `mcp_load` also accepts `query` (load only matching tools), `tool` (load one tool and return its schema) and `cursor` / `limit` (page a long listing).
- **The roster is one list.** A Global group comes first (it is never filtered out by the preset dropdown), then the Agent rows. The preset dropdown narrows the Agent rows, lists every declared preset (including ones that hold no rows yet), and also picks the destination when you add or import a server; editing a row writes to that row's own plane.
- Tool filters and optimization switches take effect on the next load; already-loaded servers are not updated automatically. Loading a server or listing its tools requires a connection and may wait for a child process to start.
- Import reads only Claude Code and project MCP configurations without modifying the source files. **Servers loaded on demand do not provide server instructions or resource tools**: their tools come from the same Harness adapter with the same binding quality, but the mount path that supplies instructions and shared resources is gone. Put the row in an Agent preset and choose Load all to keep those.
- **Global rows are switchable from the settings page when they live in your own Include file.** A write targets the file of the one file-backed Include that is yours — the host's root anchor is excluded, so a profile that declares its own Include is no longer treated as read-only. Rows declared by the composition itself (or by a patch layer) have no line in that file, so they stay read-only: their switch and Edit are greyed out with the reason, and the server rejects a write with `mcp/read-only`. Such a row still loads on demand, reuses the pool and mounts under Load all. **One known limitation:** a global write rewrites that whole file, so comments and your own quoting style in it are lost and an enabled row keeps an explicit `disabled: false` — the result is functionally right, but not byte-identical to what you wrote.
- **Verification status:** behaviour is verified at three levels. `npm test` passes **19 files / 204 tests** and `npm run test:harness` passes **6 files / 25 tests** (the MCP client callback never runs under `dynamic`; global rows follow the same rules, including a row the composition mounted before this plugin loaded; two sessions share one connection and `mcp_unload` releases one reference at a time; a global row in its own Include file can be switched from the settings page, and a row you disabled reads as off immediately). An isolated instance on the **final build** (`lib/index.mjs` `121B8C0A…`, `lib/client.js` `E1B1051A…`) with `@deepseek-ai/dsh@0.2.0-rc.2` — the release that is `latest`/`next` on npm and the version the everyday instance actually runs — took the readings: no MCP process at start-up under `dynamic` (no marker file ever created, zero processes, empty stderr), the `eager` control keeping four servers alive, and one single child process reused across repeated loads in two sessions. Readings from the earlier builds (`9B5D8D19…`, `D498FEC7…`) remain in the test record as history. An earlier compatibility check ran on `0.2.1-alpha.1` (2026-10-07, adapting to the removal of `livePresetMounts`); that `alpha` tag now points at `0.2.1-alpha.4`, and this work has not been re-run on the alpha line. Not covered: real `npx -y` cold-start timing, the model-driven path in the GUI, `tools/list_changed` resync across sessions, switching the loading mode at runtime inside a live instance, `lazy` pool reuse in a live instance, the `mcp_search` tool itself, browser tests for adding / importing / deleting a row and the editor's Save, and comment preservation in your own Include file.
- Host updates may introduce compatibility changes. See the [design notes](<docs/design-decisions.md>) for detailed limitations. The alpha line is not known to be broken — this work simply has not been re-run on it.

## License

Apache License 2.0 — see [LICENSE](<LICENSE>). Includes MIT-licensed portions derived from DeepSeek Harness; see [NOTICE](<NOTICE>).
