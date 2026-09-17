---
description: "MCP server management for DeepSeek Harness: author composition rows, choose when an allowed server loads, and filter which of its tools a session may call."
kind: "plugin-readme"
---

# @zhang-guo-wen/dsh-mcp-manager

[中文](README.zh.md) | English

## What this plugin does

- **MCP management.** Add, edit, enable, and disable MCP servers from the settings page. Global rows and every preset's
  rows are listed with live status. A toggle shows a brief `starting / stopping` state because the child MCP process
  has to come up; the list never blocks on it.
- **On-demand loading.** A stopped server costs nothing. The model calls `mcp_list`, `mcp_load`, and `mcp_unload` to
  start a server for the calling session only; loaded tools never leak into another session. Connections are
  per-session, and a session that ends closes the connections it opened.
- **MCP tool filters.** The edit dialog lists the methods a server publishes with every one checked; an unchecked
  method never enters context — neither listed nor callable. Wildcards are available by writing `mcp-manager.tools`
  yourself.

MCP management was split out of
[`dsh-claude-compat`](https://github.com/zhang-guo-wen/dsh-claude-compat) into its own plugin. The two do not depend on
each other and install separately; with both installed, the settings page shows **Claude 兼容** and **MCP 管理** as
independent sections.

## Screenshots

### MCP 管理 — every configured server, live

![MCP list](docs/mcp-list.png)

### MCP 管理 — add or edit a server, including the tool picker

![MCP editor](docs/mcp-editor.png)

## Install

The built `lib/` is committed, so the repository installs and runs directly — no build step on your machine.

```sh
# over HTTPS
npx @deepseek-ai/dsh plugin --profile web add git+https://github.com/zhang-guo-wen/dsh-mcp-manager.git

# or over SSH
npx @deepseek-ai/dsh plugin --profile web add git+ssh://git@github.com/zhang-guo-wen/dsh-mcp-manager.git
```

Pin a release tag so a later work-in-progress commit on the default branch is not picked up:

```sh
npx @deepseek-ai/dsh plugin --profile web add "git+ssh://git@github.com/zhang-guo-wen/dsh-mcp-manager.git#v0.1.0"
```

To develop against a local checkout, install the directory: pnpm links it, so rebuilding `lib/` takes effect on the
next start without reinstalling.

```sh
npx @deepseek-ai/dsh plugin --profile web add /absolute/path/to/dsh-mcp-manager
```

## Use

### MCP loading modes

A row's enable switch and the loading mode answer different questions: the switch says **whether a server may be used
at all**, the mode says **when an allowed server enters context**.

| Mode | Behavior |
|---|---|
| Load all (`eager`) | Allowed servers mount at session start; their tools are always in the request |
| Dynamic insert (`dynamic`, default) | Allowed servers stay unmounted; `mcp_load` mounts one into the calling session, so its tools join the request — best tool binding, but the tool list changes once per load |
| Lazy (`lazy`) | Allowed servers stay unmounted; `mcp_load` connects over the MCP SDK **without registering anything** and returns the tool schemas, and the model calls them through the fixed `mcp_call` proxy — the tool list never changes, so the request-cache prefix is never invalidated |

Set it in **设置 → Harness 兼容 → MCP 管理 → MCP 加载方式**. The choice is stored in the user's `mcp-manager`
settings namespace and applies from the next request on, in every session.

### Processes and lifetime

Under `dynamic` / `lazy`, a server that has not been loaded starts **no process at all** — MCP is stopped when the
session begins, until some `mcp_load`.

Once loaded, connections are per-session: a repeated `mcp_load` in one session reuses the same one, while **different
sessions each get their own** (for stdio, one child process each); subagents and forked sessions count as separate
sessions. **A session that ends closes the connections it opened**, with no `mcp_unload` required. `eager` is the
opposite — the preset is a standing mount, so one shared instance serves every session.

> MCP rows on the **global plane** (written directly into `cordis.yml`) are outside on-demand loading: they always
> start, as if permanently `eager`. Put a server in a preset to make it on-demand.

### MCP tool filters

A server often publishes dozens of tools while a session uses a few. Once filtered, **only the tools the rules admit
are handed to the model when the server loads**: a hidden tool is absent from the `mcp_load` result and `mcp_call`
refuses to invoke it.

**In the settings page:** Settings → Harness 兼容 → MCP 管理 → a row's **Edit** → the **Tools** block at the bottom of
the dialog.

Opening it connects to that server once, lists the methods it publishes, and **checks every one of them**. Unchecking a
method disables it; the change applies on save. The block carries an `enabled/total` count, `Load tools` (re-read after
editing the JSON), and `All` / `None`.

- Rules are only rewritten when the server actually answered; a failed connection leaves the stored rules untouched.
- Everything checked = no rules for that row, so every published tool stays visible (also the state of a new row).

**For wildcards, write them yourself.** Rules live in the `mcp-manager` settings namespace under `tools`, keyed by the
row key (`preset:<preset id>:<serverName>`, the same key the description map uses):

| Form | Meaning |
|---|---|
| `create_workitem`, `get_workitem` | **Allow list**: one entry without `!` means only matching tools stay visible |
| `!delete_*` | **Deny list**: when every entry starts with `!`, matching tools are hidden and the rest stay |
| `*`, `?` | Wildcards: `*` matches any run of characters, `?` matches exactly one |

What the dialog saves is exactly that deny list, so unchecking `delete_workitem` writes:

```yaml
mcp-manager:
  tools:
    "preset:standard-yunxiao:alibaba-devops-mcp":
      - "!delete_workitem"
```

What to expect:

- **Rules are read at load time.** A committed change applies to the **next `mcp_load`**; an already-loaded server
  keeps the tools it was admitted with, and `mcp_unload` followed by `mcp_load` picks up the new rules.
- **A filtered row always takes the proxy carrier** (`mcp_load` lists, `mcp_call` invokes), even under the `dynamic`
  mode: native registration publishes every discovered tool and offers no way to hold some back.
- **`eager` ignores filters**, because that mode mounts the whole server through the harness's mcp-client. The plugin
  warns at startup when rules are configured for it.
- **A malformed rule set hides nothing**: an unparsable value filters nothing, so a typo never empties a server.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `mcpLoading` | `dynamic` | How allowed servers enter context by default; the settings-page choice overrides it |

```yaml
- name: '@zhang-guo-wen/dsh-mcp-manager'
  config:
    mcpLoading: lazy
```

## Known limitations

- **Enabling a server still waits on the child process** (`npx -y …` / `uvx …`, usually 1–3 seconds). The UI never
  blocks; installing the server as a direct executable shortens this noticeably.
- **Opening the edit dialog connects to that server once** (to list its tools), with the same 1–3 second cost.
- **Global-plane rows ignore the loading mode**: they always mount.
- **A preset's first mount starts and then kills each server once.** On-demand loading works by unmounting rows at
  runtime, which cannot beat the child process's spawn, so the first session to use a preset after a host restart pays
  one short start-up.

## Development

Build, Cordis/Typert plugin contract, the traps, and the MCP lifecycle details live in [AGENTS.md](AGENTS.md).

```sh
npm run build      # host (tsdown) + client (rolldown ModuleLoader handoff)
npm run typecheck
```

## License

Apache License 2.0 — see [LICENSE](LICENSE). This project includes MIT-licensed portions derived from DeepSeek
Harness; see [NOTICE](NOTICE).
