---
description: "MCP server management for DeepSeek Harness: author composition rows, choose when an allowed server loads, and filter which of its tools a session may call."
kind: "plugin-readme"
---

# @guowenzhang/dsh-mcp-manager

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
- **Import an existing Claude Code setup.** One button reads the MCP servers your Claude Code configuration files
  already declare and imports the ones you tick as global rows — no retyping commands, arguments, and API keys.

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
| Dynamic insert (`dynamic`, default) | Allowed servers stay unmounted; `mcp_load` mounts one into the calling session, so its tools join the request — best tool binding, but the tool list changes once per load. **A filtered row mounts only its visible tools**, which keep the server's real argument schemas |
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

A server often publishes dozens of tools while a session uses a few. The rules decide **which tools are visible**: a
hidden tool is absent from the `mcp_load` result and `mcp_call` refuses to invoke it. Filtering does **not** change the
cost model — whether the visible tools enter every request is the **loading mode**'s decision, filter or not.

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
  keeps the tools it was admitted with, and `mcp_unload` followed by `mcp_load` picks up the new rules. When the
  server itself changes its tool list (`tools/list_changed`), the re-sync keeps the rules the load used.
- **The loading mode picks the carrier, not the rules.** Under `lazy` a row's tools always take the proxy carrier
  (`mcp_load` lists, `mcp_call` invokes). Under `dynamic`, a row without rules mounts through the harness as a whole,
  while **a filtered row registers only its visible tools natively in that session** — they carry the server's real
  argument schemas in every request, and the hidden ones are never registered at all.
- **`eager` ignores filters**, because that mode mounts the whole server through the harness's mcp-client. The plugin
  warns at startup when rules are configured for it.
- **A malformed rule set hides nothing**: an unparsable value filters nothing, so a typo never empties a server.

### Importing your Claude Code MCP configuration

**设置 → Harness 兼容 → MCP 管理 → 导入 Claude 配置** reads the configuration files Claude Code writes and offers
every server it finds as a checklist. Selected servers are imported as **global** rows.

| Source | File |
|---|---|
| Claude Code user config | `~/.claude.json` → `mcpServers` |
| Per-directory scope inside it | `~/.claude.json` → `projects["<working directory>"].mcpServers` |
| Claude Code settings | `~/.claude/settings.json`, `settings.local.json` |
| Project scope | `<project root>/.mcp.json` |

`type` may be omitted, as Claude Code itself writes it: a `command` means stdio and a `url` means streamable HTTP.

- **Nothing is modified.** The scan only reads; only the rows you tick are written, through the same path as a manually
  added server (same validation, conflict check, and atomic write).
- **A server whose name is already taken is not pre-selected**, and one that cannot be imported is labelled with the
  reason instead of failing silently.
- **A server is imported on its own.** If one fails, the rest still go through, and the failures are listed with their
  reasons.
- **Credentials come along.** An entry's `env` / `headers` are imported verbatim so the server can connect; the dialog
  only shows the *names* of those keys, never their values.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `mcpLoading` | `dynamic` | How allowed servers enter context by default; the settings-page choice overrides it |

```yaml
- name: '@guowenzhang/dsh-mcp-manager'
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
- **Import reads Claude Code and the project `.mcp.json` only.** Cursor, Cline, Roo, and VS Code configuration files
  are not scanned, and an import always targets the global plane; move a row into a preset afterwards if you want it
  on-demand.
- **A filtered row under `dynamic` gets no server instructions and no resource tools.** The harness's mcp-client
  provides both, and this row registers through the plugin's own carrier instead. The tools themselves — argument
  binding, results, image projection — match a native mount.

## Development

Build, Cordis/Typert plugin contract, the traps, and the MCP lifecycle details live in [AGENTS.md](AGENTS.md).
The loading decisions — why three modes, which alternatives were rejected, and how Claude's tool search compares —
live in [docs/design-decisions.md](docs/design-decisions.md), maintained in Chinese like AGENTS.md. The comparison
against other DSH MCP plugins and the feature roadmap it produces live in
[docs/competitive-landscape.md](docs/competitive-landscape.md).

```sh
npm run build      # host (tsdown) + client (rolldown ModuleLoader handoff)
npm run typecheck
npm test           # vitest; the repository-local vitest.config.ts is required
```

## License

Apache License 2.0 — see [LICENSE](LICENSE). This project includes MIT-licensed portions derived from DeepSeek
Harness; see [NOTICE](NOTICE).
