---
description: "MCP server management for DeepSeek Harness: author composition rows, choose when an allowed server loads, and filter which of its tools a session may call"
kind: "plugin-readme"
---

# @guowenzhang/dsh-mcp-manager

[中文](README.zh.md) | English

Manage MCP servers from DeepSeek Harness settings: add or edit connections, choose how Agent-preset servers load, select the tools available to the model, and batch-import an existing Claude Code setup.

## Background: DeepSeek Harness

DeepSeek Harness (`dsh`) is the open-source agent harness from DeepSeek AI, where nearly every capability is a plugin on [Cordis](https://github.com/cordiverse/cordis). It is in **developer preview** and iterating fast, so expect compatibility-breaking changes ([docs](https://deepseek-harness.github.io/deepseek-harness/), `0.1.7-alpha.*`); this plugin is a standalone third-party package that resolves `@deepseek-ai/*` from the running host.

## The problem this plugin solves

MCP servers were hand-written composition rows whose whole tool set always sat in context, and an existing Claude Code setup had to be retyped; this plugin manages the rows from the settings page, loads a server on demand with only the tools you pick, and imports your Claude MCP configuration in one click.

## Screenshots

### MCP management

![MCP settings](docs/images/mcp-settings.png)

Manage configured servers, check their status, edit their configuration, and enable or disable them. Agent-preset servers support three loading modes; global rows always load.

### Configure a server and import Claude MCP settings

[![Left: MCP configuration and tool selection; right: importing Claude MCP settings](docs/images/mcp-editor-import.png)](docs/images/mcp-editor-import.png)

- **Left — configuration and tools:** paste the server's JSON configuration and select the tools the model may use. Tool filtering applies to Agent-preset rows under `dynamic` / `lazy`, not to global rows or `eager` mode.
- **Right — Claude import:** scan existing Claude Code settings, select servers, and import them together without modifying the source files. The destination follows the active **Global / Agent** tab; on the Agent tab, choose a preset.

The two dialogs are shown side by side; click the image for full size. These screenshots show an earlier UI; the current editor has separate Configuration / Tools tabs, and import is no longer limited to global rows.

## Install

```sh
npx @deepseek-ai/dsh plugin --profile web add @guowenzhang/dsh-mcp-manager@^1.0.1
```

Prerequisites: `pnpm` on `PATH` (`dsh plugin` forwards to it), and Node.js ≥22.18 or ≥24.2 — on v23.x the `dsh` CLI exits silently and installs nothing ([discussion #6273](https://github.com/deepseek-ai/deepseek-harness/discussions/6273)). The `@^1.0.1` floor is deliberate: pnpm 11 withholds versions younger than 24 hours, and a bare package name resolves to 1.0.0, which lacks the `@deepseek-ai/schemastery` dependency.

From the npm registry: <https://www.npmjs.com/package/@guowenzhang/dsh-mcp-manager> — restart the host afterwards; local checkouts, git sources and troubleshooting are in [AGENTS.md](AGENTS.md).

## Host compatibility

The local source adapts to the registry without `livePresetMounts` (tested against DSH `0.2.1-alpha.1`) while preserving on-demand loading, retained preset revisions, and session isolation. The plugin declares its MCP SDK as a runtime dependency instead of relying on the newer host to carry the old SDK. This fix has not been published to npm; the npm command above does not include unpublished local changes.

After rebuilding a local `link:` installation, restart the host and refresh the browser; a page refresh alone does not replace loaded Host code. If the host rejects an older `@deepseek-ai/dsh-mcp-client` as incompatible, the management page still lists its rows as disabled. Update that client separately; this plugin never bypasses host compatibility checks.

## Usage

### Loading modes

The enable switch says **whether a server may be used**; the mode says **when an allowed server enters context**. Set it in **设置 → MCP 管理 → MCP 加载方式**; the choice is stored in the `mcp-manager` settings namespace and applies from the next request on.

| Mode | Behavior |
|---|---|
| Load all (`eager`) | Allowed servers mount at session start; their tools are always in the request |
| Dynamic insert (`dynamic`, default) | They stay unmounted; `mcp_load` mounts one into the calling session — best tool binding, but the tool list changes once per load. A filtered row mounts only its visible tools |
| Lazy (`lazy`) | `mcp_load` connects without registering anything and returns the tool schemas, called through the fixed `mcp_call` proxy — the tool list never changes, so the request-cache prefix is never invalidated |

Under `dynamic` / `lazy` the system prompt lists every loadable server as `name — the description you wrote on its row`, and the model calls `mcp_load` / `mcp_unload` by name. Names are always listed; descriptions are truncated to 80 characters under a 900-character budget. **Load state is deliberately absent** — reporting it would rewrite the system prompt on every `mcp_load` and invalidate the whole cache prefix.

Connections are per-session: a repeated `mcp_load` reuses one, different sessions each get their own, and a session that ends closes what it opened; `eager` shares one standing instance instead. Toggling a row shows a brief `starting / stopping` state while the child process comes up.

Repository MCPs supplied by `dsh-resource-manager` use these modes too, including global resources. The resource plugin retains synchronization and credential ownership; its MCP tab shows management status and the current mode. Repository MCPs do not write user composition files or appear as editable composition rows here.

### Tool filters

Settings → MCP management → an Agent-preset row's **Edit** → **Tools** lists the server's tools, all checked by default. Under `dynamic` / `lazy`, unchecking a tool prevents the next load from exposing it to the model. Global rows show this tab as read-only, and `eager` ignores filters.

For wildcards, write the rules yourself in the `mcp-manager` settings under `tools`, keyed by the row key (`preset:<preset id>:<serverName>`):

| Form | Meaning |
|---|---|
| `create_workitem` | **Allow list**: one entry without `!` keeps only matching tools |
| `!delete_*` | **Deny list**: when every entry starts with `!`, matching tools are hidden |
| `*`, `?` | Wildcards: `*` matches any run of characters, `?` matches exactly one |

Rules are read at the next `mcp_load`; an already-loaded server keeps the tools it was admitted with. `eager` ignores filters, and an unparsable rule set hides nothing.

### Importing a Claude Code configuration

**Settings → MCP management → Import Claude configuration** scans Claude Code's configuration files and lists the servers for selection. Selected servers are imported into the active **Global / Agent** tab; on the Agent tab, choose the destination preset.

| Source | File |
|---|---|
| Claude Code user config | `~/.claude.json` → `mcpServers` |
| Per-directory scope inside it | `~/.claude.json` → `projects["<working directory>"].mcpServers` |
| Claude Code settings | `~/.claude/settings.json`, `settings.local.json` |
| Project scope | `<project root>/.mcp.json` |

Source files are read-only. Selected servers are validated individually and accepted rows are saved in one batch; one rejected row does not stop the rest. `env` / `headers` are preserved so the server can connect, but the dialog shows only the key names.

## Notes and caveats

- **Enabling a server still waits on the child process** (`npx -y …` / `uvx …`, usually 1–3 seconds). The UI never blocks; installing the server as a direct executable shortens this noticeably.
- **Switching to the edit dialog's Tools tab connects to that server once** (to list its tools), with the same 1–3 second cost; renaming a row only never connects.
- **Global-plane rows ignore the loading mode**: they always mount.
- **A preset's first mount starts and then kills each server once.** Runtime unmounting cannot beat the child process's spawn. Newer hosts activate presets on declaration registration, so this cost can occur during host startup or configuration rebuilds.
- **Import reads Claude Code and the project `.mcp.json` only.** Cursor, Cline, Roo, and VS Code configuration files are not scanned. For on-demand loading and tool filtering, import from the Agent tab into a preset.
- **A filtered row under `dynamic` gets no server instructions and no resource tools.** The harness's mcp-client provides both, and this row registers through the plugin's own carrier instead. The tools themselves — argument binding, results, image projection — match a native mount.

## License

Apache License 2.0 — see [LICENSE](LICENSE). This project includes MIT-licensed portions derived from DeepSeek Harness; see [NOTICE](NOTICE).

## Further reading

- [AGENTS.md](AGENTS.md) — full install variants, build and wiring, deployment and live-update semantics, release steps, the traps, and the tests.
- [docs/design-decisions.md](docs/design-decisions.md) — why three loading modes, which alternatives were rejected, and how Claude's tool search compares.
- [docs/competitive-landscape.md](docs/competitive-landscape.md) — comparison with other DSH MCP plugins and the feature roadmap it produces.
- [DeepSeek Harness documentation](https://deepseek-harness.github.io/deepseek-harness/).
