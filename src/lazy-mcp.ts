/**
 * On-demand MCP loading, in two modes.
 *
 * A deployment keeps MCP servers out of every request's tool list — and out of
 * the prompt — by leaving their composition rows disabled, then pulls one in
 * when it is actually needed. `mcp_list` names what is configured and what is
 * running; `mcp_load` starts one; `mcp_unload` stops it again.
 *
 * The mode decides how a loaded server reaches the model:
 *
 * - `dynamic` mounts the mcp-client into the CALLING AGENT's scope, so the
 *   server's tools register natively — best tool binding, but the tool list
 *   changes once per load.
 * - `lazy` talks to the MCP server over the SDK WITHOUT registering anything:
 *   `mcp_load` returns the tool schemas as its result and the model calls them
 *   through the fixed `mcp_call` proxy. The tool list never changes, so the
 *   request-cache prefix is never invalidated.
 *
 * A filtered `dynamic` row cannot take the mount: mcp-client registers every
 * discovered tool and offers no way to hold some of them back. It registers its
 * VISIBLE tools itself through the harness's own `createMcpToolDefinition`
 * adapter, so those tools keep their upstream schemas — the model argues from
 * the real schema in every request — while the hidden ones are never registered
 * at all. A row's `context-injection.mcpTools` rules narrow what a load exposes
 * in every carrier: a hidden tool is neither listed nor callable.
 * @module @guowenzhang/dsh-mcp-manager/lazy-mcp
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { McpToolDefinitionOptions } from '@deepseek-ai/dsh-mcp-client'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { MCP_CLIENT_MODULE } from './mcp-authoring.ts'
import {
  carrierFor,
  nativeDefinitions,
  swapNativeTools,
  visibleToolName,
  type LazyClient,
  type LazyTool,
  type McpCarrier,
  type McpToolAdapter,
  type ToolRegistry,
} from './mcp-carrier.ts'
import { mcpEntryConfig, type McpEntryConfig } from './mcp-config.ts'
import type { McpPreloadGate } from './mcp-gate.ts'
import { mcpRowKey } from './mcp-gate.ts'
import {
  filterMcpTools,
  NO_TOOL_FILTER,
  type McpToolFilter,
} from './mcp-tool-filter.ts'
import type { McpSpec, McpTarget } from './types.ts'

/** How a configured-but-stopped MCP server reaches the model once loaded. */
export type McpLoadingMode = 'eager' | 'dynamic' | 'lazy'

/** Every {@link McpLoadingMode}, used to validate the persisted setting. */
export const MCP_LOADING_MODES: readonly McpLoadingMode[] = ['eager', 'dynamic', 'lazy']

/**
 * Narrow one stored `mcpLoading` value. The settings document is a durable,
 * user-editable file, so an unknown value falls back to `dynamic` instead of
 * failing the commit that carried it.
 * @param value - raw value read from the settings namespace or the plugin config.
 * @returns the matching mode, or `dynamic` when nothing matches.
 */
export function parseMcpLoadingMode(value: unknown): McpLoadingMode {
  return MCP_LOADING_MODES.includes(value as McpLoadingMode) ? value as McpLoadingMode : 'dynamic'
}

/** One configured mcp-client row and where its composition lives. */
interface McpRow {
  readonly target: McpTarget
  readonly entryId: string
  readonly serverName: string
  /** Settings key for this row, shared with the description map and the UI. */
  readonly key: string
  readonly scopeLabel: string
  readonly enabled: boolean
}

/** The mcp-client host plugin object, resolved from the harness module graph. */
interface McpClientModule {
  readonly name: string
  readonly inject: readonly string[]
  apply(ctx: Context, config: unknown): void | Promise<void>
  /**
   * The harness's upstream-tool adapter. The per-tool native carrier builds its
   * definitions with it, so a filtered row's tools keep the same argument
   * binding, canonical result, error, and image projection as a mounted one.
   * Absent only on a harness build older than the adapter: the carrier fails
   * loud there rather than registering a weaker definition.
   */
  createMcpToolDefinition?(ctx: Context, options: McpToolDefinitionOptions): unknown
}

/** A live per-agent server under the `mount` carrier: the harness owns its tools. */
interface MountedMount {
  readonly carrier: 'mount'
  /** Idempotent: `mcp_unload` and the session's own disposal both reach it. */
  dispose(): Promise<void>
}

/** A live per-agent server under the `proxy` carrier: `mcp_call` carries every call. */
interface MountedProxy {
  readonly carrier: 'proxy'
  dispose(): Promise<void>
  /** The connected SDK client. */
  readonly client: LazyClient
  /** The tools this session may use, in the server's own order. */
  tools: readonly LazyTool[]
  /** Discovered tools this row's filter kept out of the model's view. */
  hidden: number
}

/** A live per-agent server under the `native` carrier: the plugin owns the registrations. */
interface MountedNative {
  readonly carrier: 'native'
  dispose(): Promise<void>
  /** The connected SDK client every definition forwards to. */
  readonly client: LazyClient
  tools: readonly LazyTool[]
  hidden: number
  /** Live registrations by public name, re-swapped on `tools/list_changed`. */
  registrations: Map<string, () => void>
  /** Rules this mount was admitted with: read at load, reused by every re-sync. */
  readonly filter: McpToolFilter
  /** The in-flight `tools/list_changed` re-sync, if any. */
  resyncing?: Promise<void>
}

/** A live per-agent server. `dispose` releases whichever carrier started it. */
type MountedServer = MountedMount | MountedProxy | MountedNative

/** The last `:`-separated segment of a loader-qualified row id. */
function leafId(id: string): string {
  const separator = id.lastIndexOf(':')
  return separator < 0 ? id : id.slice(separator + 1)
}

/** Resolve the mcp-client plugin from the Loader's module graph (same instance the composition mounts). */
async function resolveMcpClient(ctx: Context): Promise<McpClientModule> {
  const loader = ctx.get('loader') as
    | { internal?: { import(spec: string, base: string, options: object): Promise<unknown> } }
    | undefined
  const base = (ctx as unknown as { baseUrl?: string }).baseUrl
  if (loader?.internal !== undefined && base !== undefined) {
    try {
      const mod = await loader.internal.import(MCP_CLIENT_MODULE, base, {}) as McpClientModule
      if (typeof mod.apply === 'function') return mod
    } catch {
      // Swallows only the internal-resolver miss; the plain import below is the
      // fallback and reports its own failure if the package is absent.
    }
  }
  return await import('@deepseek-ai/dsh-mcp-client') as McpClientModule
}

/** Every configured mcp-client row: Loader entries (global) plus each agent preset's composition rows. */
async function listRows(ctx: Context): Promise<McpRow[]> {
  const rows: McpRow[] = []
  const loader = ctx.get('loader') as
    | { entries(): Iterable<{ id: string; disabled?: boolean; options: { name?: string; group?: boolean } }> }
    | undefined
  for (const entry of loader?.entries() ?? []) {
    if (entry.options.group === true || entry.options.name !== MCP_CLIENT_MODULE) continue
    const serverName = leafId(entry.id)
    rows.push({
      target: { scope: 'global' },
      entryId: entry.id,
      serverName,
      key: mcpRowKey({ scope: 'global' }, serverName),
      scopeLabel: 'global',
      enabled: entry.disabled !== true,
    })
  }
  const presets = ctx.get('agentPresets') as
    | {
      compositionInventory(): Promise<readonly {
        readonly id: string
        readonly rows: readonly { readonly entryId: string | null; readonly moduleName: string; readonly enabled: boolean | 'conditional' }[]
      }[]>
    }
    | undefined
  if (presets !== undefined) {
    for (const preset of await presets.compositionInventory()) {
      for (const row of preset.rows) {
        if (row.moduleName !== MCP_CLIENT_MODULE) continue
        const entryId = row.entryId ?? ''
        const serverName = leafId(entryId)
        const target: McpTarget = { scope: 'preset', agentPreset: preset.id }
        rows.push({
          target,
          entryId,
          serverName,
          key: mcpRowKey(target, serverName),
          scopeLabel: `preset ${preset.id}`,
          enabled: row.enabled === true,
        })
      }
    }
  }
  return rows
}

/** Read one row's connection spec through the authoring owner. */
async function describeRow(ctx: Context, row: McpRow): Promise<McpSpec> {
  const owner = ctx.get('mcpManager') as
    | { describeMcp(request: { target: McpTarget; entryId: string }): Promise<{ spec: McpSpec }> }
    | undefined
  if (owner === undefined) throw new Error('mcp_load requires the mcpManager service')
  return (await owner.describeMcp({ target: row.target, entryId: row.entryId })).spec
}

/** The tool names one server published into an agent's scope (dynamic mode). */
function toolNamesFor(tools: ToolRegistry, agentCtx: Context, serverName: string): string[] {
  const prefix = `mcp__${serverName}__`
  return tools.schemas(scopeOf(agentCtx)).map(schema => schema.name).filter(name => name.startsWith(prefix))
}

/**
 * Connect one configured server through the MCP SDK without registering anything.
 * @param config - the row's resolved transport and namespace.
 * @returns the connected client and the tools the server published. The caller
 *   owns the client and must close it.
 */
export async function connectLazy(config: McpEntryConfig): Promise<{ client: LazyClient; tools: readonly LazyTool[] }> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js') as {
    Client: new (info: { name: string; version: string }) => LazyClient & { connect(transport: unknown): Promise<void> }
  }
  let transport: unknown
  if (config.transport === 'stdio') {
    // The SDK's own transport options do not overlap this structural cast, so
    // it goes through `unknown`.
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js') as unknown as {
      StdioClientTransport: new (options: Record<string, unknown>) => unknown
    }
    transport = new StdioClientTransport({
      command: config.command,
      args: [...config.args],
      env: { ...process.env, ...config.env },
      ...(config.cwd === '' ? {} : { cwd: config.cwd }),
      stderr: 'ignore',
    })
  } else {
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js') as {
      StreamableHTTPClientTransport: new (url: URL, options?: Record<string, unknown>) => unknown
    }
    transport = new StreamableHTTPClientTransport(
      new URL(config.url),
      Object.keys(config.headers).length === 0 ? {} : { requestInit: { headers: config.headers } },
    )
  }
  const client = new Client({ name: '@guowenzhang/dsh-mcp-manager', version: '0.1' })
  await client.connect(transport)
  const listed = await client.listTools()
  return { client, tools: listed.tools ?? [] }
}

/** Wrap one release step so the session context and `mcp_unload` cannot run it twice. */
function once(release: () => Promise<void>): () => Promise<void> {
  let released = false
  return async () => {
    if (released) return
    released = true
    await release()
  }
}

/**
 * Re-list one native mount and swap its registration generation.
 *
 * The mount's own load-time rules decide the new visible set, so a
 * `tools/list_changed` never applies a rule the session did not load with. A
 * failed re-list leaves the session with the tools it already had.
 * @param mount - the session's native mount for one server.
 * @param row - the composition row the mount came from.
 * @param deps - the session-scoped registry and the harness adapter.
 */
async function resyncNativeTools(mount: MountedNative, row: McpRow, deps: NativeDeps): Promise<void> {
  const listed = await mount.client.listTools()
  const selection = filterMcpTools(listed.tools ?? [], mount.filter)
  const definitions = nativeDefinitions(deps.ctx, deps.adapter, row.serverName, selection.visible, mount.client)
  mount.registrations = swapNativeTools(deps.registry, mount.registrations, definitions)
  mount.tools = selection.visible
  mount.hidden = selection.hidden
}

/** What one native mount needs to rebuild its registrations. */
interface NativeDeps {
  /** The session-scoped tool registry the mount registers into. */
  readonly registry: ToolRegistry
  /** The session context the definitions resolve services through. */
  readonly ctx: Context
  /** The harness `createMcpToolDefinition` export. */
  readonly adapter: McpToolAdapter
}

/**
 * Follow `notifications/tools/list_changed` for one native mount.
 *
 * The SDK installs no dedicated handler for that notification, so it arrives at
 * the client's fallback listener. Re-syncs are serialized per mount, because a
 * server may announce another change while the previous swap is still running.
 * @param mount - the session's native mount.
 * @param row - the composition row the mount came from.
 * @param deps - the session-scoped registry and the harness adapter.
 */
function watchToolListChanges(mount: MountedNative, row: McpRow, deps: NativeDeps): void {
  mount.client.fallbackNotificationHandler = async (notification) => {
    if (notification.method !== 'notifications/tools/list_changed') return
    const previous = mount.resyncing ?? Promise.resolve()
    const next = previous
      .then(() => resyncNativeTools(mount, row, deps))
      .catch((error: unknown) => {
        deps.ctx.logger.warn(
          `mcp-manager: could not follow the tool list change of "${row.serverName}": ${String(error)}`,
        )
      })
    mount.resyncing = next
    await next
  }
}

const SERVER_ROW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true, description: 'MCP serverName namespace.' },
    scope: { type: 'string', required: true, description: 'Composition that owns the row, e.g. "global" or "preset standard".' },
    loaded: { type: 'boolean', required: true, description: 'Whether the server is running for this session.' },
  },
} as const

/**
 * Register the on-demand MCP tools in one composition scope.
 * @param ctx - scope the tools belong to (a preset row's context).
 * @param mode - how a loaded server reaches the model.
 * @param gate - the preload gate; it decides which composed rows this session
 *   is allowed to load, and holds the rest out of every request.
 * @param filterFor - reads one row's tool filter by its settings key. Called at
 *   every load, so a committed rule change applies to the next `mcp_load`.
 * @returns a disposer that unregisters every tool and stops every server this
 *   registration started. `eager` registers nothing, so its disposer is a no-op.
 */
export function registerMcpTools(
  ctx: Context,
  mode: McpLoadingMode,
  gate: McpPreloadGate,
  filterFor: (key: string) => McpToolFilter = () => NO_TOOL_FILTER,
): () => void {
  const tools = ctx.get('tools') as ToolRegistry | undefined
  if (tools === undefined || mode === 'eager') return () => {}
  /**
   * The rows this session may load: composed rows the user has not disabled.
   * The gate is re-read first because a preset composition is also rebuilt when
   * its file changes, and a row that just came back would otherwise be treated
   * as still absent.
   */
  const allowedRows = async (): Promise<McpRow[]> => {
    await gate.reconcile()
    return (await listRows(ctx)).filter(row => gate.stateFor(row.target, row.entryId)?.allowed ?? row.enabled)
  }
  /** Whether a row's tools are in every request already, without an `mcp_load`. */
  const preloaded = (row: McpRow): boolean => {
    const state = gate.stateFor(row.target, row.entryId)
    return state === undefined ? row.enabled : state.allowed && !state.suppressed
  }
  /** Loaded servers keyed by agent id, then serverName. */
  const mounted = new Map<string, Map<string, MountedServer>>()
  /** Sessions whose mounts are already bound to their own context disposal. */
  const scopedAgents = new Set<string>()
  /** Live tool registrations, undone by the returned disposer. */
  const registrations: (() => void)[] = []
  const register = (definition: unknown): void => { registrations.push(tools.register(definition)) }

  const loadedFor = (agentId: string): Map<string, MountedServer> => {
    const existing = mounted.get(agentId)
    if (existing !== undefined) return existing
    const created = new Map<string, MountedServer>()
    mounted.set(agentId, created)
    return created
  }

  /**
   * Close everything one ended session started.
   *
   * The `mount` carrier puts the mcp-client on the agent's own context, so
   * Cordis disposes its connection with that context and nothing is left here.
   * The `proxy` and `native` carriers own a bare SDK client instead — and the
   * native one also owns tool registrations made through that context — so
   * without this they would outlive the session that loaded them: every session
   * that ends without an `mcp_unload` would leave its server running until the
   * plugin unloads.
   * @param agentId - the session that ended.
   */
  const releaseAgent = (agentId: string): void => {
    scopedAgents.delete(agentId)
    const perAgent = mounted.get(agentId)
    if (perAgent === undefined) return
    mounted.delete(agentId)
    for (const server of perAgent.values()) {
      if (server.carrier !== 'mount') void server.dispose()
    }
  }

  /**
   * Bind one session's mounts to its context, so they close when the session
   * ends. Registered once per session: the first load also covers every later
   * load in that session.
   * @param agent - the session that is loading a server.
   */
  const bindAgentScope = (agent: { readonly id: string; readonly ctx: Context }): void => {
    if (scopedAgents.has(agent.id)) return
    scopedAgents.add(agent.id)
    agent.ctx.effect(() => () => { releaseAgent(agent.id) }, `mcp-manager: mcp mounts of ${agent.id}`)
  }

  const stopAll = async (): Promise<void> => {
    const pending: Promise<void>[] = []
    for (const perAgent of mounted.values()) for (const server of perAgent.values()) pending.push(server.dispose())
    mounted.clear()
    scopedAgents.clear()
    await Promise.allSettled(pending)
  }
  register(defineTool({
    name: 'mcp_list',
    description:
      'List the MCP servers this session may use, their scope, and whether each is running. Disabled '
      + 'servers are not listed. Servers that are allowed but not running can be started on demand with '
      + '`mcp_load`; load only what you need, because a running server costs prompt tokens.',
    parameters: {},
    output: {
      schema: { type: 'array', items: SERVER_ROW_SCHEMA },
      render: (_args, rows) => [{
        type: 'text',
        text: rows.length === 0
          ? '(no MCP servers configured)'
          : rows.map(row => `${row.name} [${row.scope}] ${row.loaded ? 'running' : 'not loaded'}`).join('\n'),
      }],
    },
    async execute(_args, exec) {
      const running = exec.agent === undefined ? undefined : mounted.get(exec.agent.id)
      return (await allowedRows()).map(row => ({
        name: row.serverName,
        scope: row.scopeLabel,
        // "Loaded" means this session already pays for the row's tools: either
        // the composition preloaded it, or `mcp_load` pulled it in here.
        loaded: preloaded(row) || running?.has(row.serverName) === true,
      }))
    },
  }))

  register(defineTool({
    name: 'mcp_load',
    description: mode === 'lazy'
      ? 'Start one configured but not-running MCP server for THIS session and return its tools. Call the '
        + 'tools you need afterwards with `mcp_call`, passing the server name and tool name from this result. '
        + 'Only the tools this result lists are callable.'
      : 'Start one configured but not-running MCP server for THIS session and add its tools to the request. '
        + 'Use `mcp_list` first to see the available names.',
    parameters: {
      server: { type: 'string', required: true, description: 'The MCP serverName to start, as reported by mcp_list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          server: { type: 'string', required: true },
          hidden: {
            type: 'number',
            required: true,
            description: 'Discovered tools this session\'s filter keeps out of the result; they cannot be called.',
          },
          tools: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                schema: { type: 'string', required: true, description: 'JSON schema of the tool arguments, empty when the server declared none.' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value.tools.length === 0
          ? `Started MCP server "${value.server}"; it exposed no tools.`
          : `Started MCP server "${value.server}".\n`
            + value.tools.map(tool => `- ${tool.name}: ${tool.description}${tool.schema === '' ? '' : `\n  args: ${tool.schema}`}`).join('\n'))
          + (value.hidden === 0
            ? ''
            : `\n(${value.hidden} further tool(s) on this server are hidden by this row's filter and cannot be called.)`),
      }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('mcp_load requires an owning agent session')
      const serverName = String((args as { server: string }).server)
      const existing = loadedFor(agent.id).get(serverName)
      if (existing !== undefined) {
        return {
          server: serverName,
          // A mounted server reports the names its mcp-client registration
          // published; the two carriers that keep the discovered tools report
          // the schemas they admitted.
          tools: existing.carrier === 'mount'
            ? toolNamesFor(tools, agent.ctx, serverName).map(name => ({ name, description: '', schema: '' }))
            : describeTools(existing, serverName),
          hidden: existing.carrier === 'mount' ? 0 : existing.hidden,
        }
      }
      const row = (await allowedRows()).find(candidate => candidate.serverName === serverName)
      if (row === undefined) {
        throw new Error(
          `unknown or disabled MCP server "${serverName}" — call mcp_list for the servers this session may load`,
        )
      }
      const spec = await describeRow(ctx, row)
      const config = mcpEntryConfig(spec, serverName)
      const filter = filterFor(row.key)
      const carrier = carrierFor(mode, filter)
      if (carrier === undefined) throw new Error('mcp_load is not registered under the "eager" loading mode')

      if (carrier === 'proxy') {
        const { client, tools: listed } = await connectLazy(config)
        const selection = filterMcpTools(listed, filter)
        loadedFor(agent.id).set(serverName, {
          carrier: 'proxy',
          client,
          tools: selection.visible,
          hidden: selection.hidden,
          dispose: once(async () => { await client.close() }),
        })
        bindAgentScope(agent)
        return { server: serverName, tools: selection.visible.map(lazyTool), hidden: selection.hidden }
      }

      if (carrier === 'native') {
        const mod = await resolveMcpClient(ctx)
        const adapter = mod.createMcpToolDefinition
        if (adapter === undefined) {
          throw new Error(
            `this harness build does not export createMcpToolDefinition from @deepseek-ai/dsh-mcp-client, so the `
            + `tools of "${serverName}" cannot be registered individually; select the "lazy" loading mode, or a `
            + 'harness build that provides the adapter',
          )
        }
        const registry = agent.ctx.get('tools') as ToolRegistry | undefined
        if (registry === undefined) throw new Error('mcp_load requires the tools service')
        const { client, tools: listed } = await connectLazy(config)
        const selection = filterMcpTools(listed, filter)
        let registrations: Map<string, () => void>
        try {
          registrations = swapNativeTools(
            registry,
            new Map(),
            nativeDefinitions(agent.ctx, adapter, serverName, selection.visible, client),
          )
        } catch (error) {
          await client.close()
          throw error
        }
        const mount: MountedNative = {
          carrier: 'native',
          client,
          filter,
          tools: selection.visible,
          hidden: selection.hidden,
          registrations,
          dispose: once(async () => {
            for (const dispose of [...mount.registrations.values()].reverse()) dispose()
            await client.close()
          }),
        }
        loadedFor(agent.id).set(serverName, mount)
        watchToolListChanges(mount, row, { registry, ctx: agent.ctx, adapter })
        bindAgentScope(agent)
        return {
          server: serverName,
          tools: selection.visible.map(tool => exposedTool('native', serverName, tool)),
          hidden: selection.hidden,
        }
      }

      const mod = await resolveMcpClient(ctx)
      const plugin = { name: mod.name, inject: mod.inject, apply: mod.apply }
      const handle = await agent.ctx.plugin(plugin as never, config as never) as unknown as { dispose(): Promise<void> }
      loadedFor(agent.id).set(serverName, {
        carrier: 'mount',
        dispose: once(async () => { await handle.dispose() }),
      })
      bindAgentScope(agent)
      return {
        server: serverName,
        tools: toolNamesFor(tools, agent.ctx, serverName).map(name => ({ name, description: '', schema: '' })),
        hidden: 0,
      }
    },
  }))

  // Registered in every on-demand mode: this proxy is what `lazy` serves, and
  // the mode is a live setting, so the registration cannot depend on it.
  register(defineTool({
    name: 'mcp_call',
    description:
      'Call one tool of an MCP server that `mcp_load` started for THIS session. Use the server and tool names '
      + 'from the mcp_load result; pass the tool arguments exactly as that result described them.',
    parameters: {
      server: { type: 'string', required: true, description: 'The MCP serverName, as reported by mcp_load.' },
      tool: { type: 'string', required: true, description: 'The tool name reported by mcp_load.' },
      arguments: { type: 'json', required: true, description: 'Arguments object for that tool, matching its reported schema.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          server: { type: 'string', required: true },
          tool: { type: 'string', required: true },
          text: { type: 'string', required: true, description: 'The tool result rendered as text.' },
          isError: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('mcp_call requires an owning agent session')
      const request = args as { server: string; tool: string; arguments: unknown }
      const mount = loadedFor(agent.id).get(request.server)
      if (mount === undefined) {
        throw new Error(`MCP server "${request.server}" is not loaded for this session — call mcp_load first`)
      }
      if (mount.carrier !== 'proxy') {
        throw new Error(
          `MCP server "${request.server}" was loaded with its tools registered natively — call them by name instead`,
        )
      }
      if (!mount.tools.some(candidate => candidate.name === request.tool)) {
        throw new Error(
          `MCP server "${request.server}" exposes no tool "${request.tool}" in this session — `
          + 'call mcp_load to list the tools this session may call',
        )
      }
      const result = await mount.client.callTool({
        name: request.tool,
        arguments: asRecord(request.arguments),
      })
      return {
        server: request.server,
        tool: request.tool,
        text: renderCallResult(result),
        isError: (result as { isError?: boolean } | null)?.isError === true,
      }
    },
  }))

  register(defineTool({
    name: 'mcp_unload',
    description:
      'Stop an MCP server that `mcp_load` started for THIS session and release it again. Use it when you are '
      + 'done with a server, to keep the prompt small.',
    parameters: {
      server: { type: 'string', required: true, description: 'The MCP serverName to stop.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          server: { type: 'string', required: true },
          stopped: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.stopped
          ? `Stopped MCP server "${value.server}".`
          : `MCP server "${value.server}" was not loaded for this session.`,
      }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('mcp_unload requires an owning agent session')
      const serverName = String((args as { server: string }).server)
      const mount = loadedFor(agent.id).get(serverName)
      if (mount === undefined) return { server: serverName, stopped: false }
      loadedFor(agent.id).delete(serverName)
      await mount.dispose()
      return { server: serverName, stopped: true }
    },
  }))

  return () => {
    for (const dispose of [...registrations].reverse()) dispose()
    registrations.length = 0
    void stopAll()
  }
}

/** One MCP tool projected onto the model-facing shape. */
function lazyTool(tool: LazyTool): { name: string; description: string; schema: string } {
  return {
    name: tool.name,
    description: tool.description ?? '',
    schema: tool.inputSchema === undefined ? '' : JSON.stringify(tool.inputSchema),
  }
}

/** One visible tool as `mcp_load` reports it: named the way this session must call it. */
function exposedTool(carrier: McpCarrier, serverName: string, tool: LazyTool): { name: string; description: string; schema: string } {
  return { ...lazyTool(tool), name: visibleToolName(carrier, serverName, tool.name) }
}

/** The already-loaded server's exposed tool list, re-reported without reconnecting. */
function describeTools(mount: MountedProxy | MountedNative, serverName: string): { name: string; description: string; schema: string }[] {
  return mount.tools.map(tool => exposedTool(mount.carrier, serverName, tool))
}

/** Coerce model-supplied arguments to the object the SDK expects. */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Render one MCP call result as text for the model. */
function renderCallResult(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content
  if (Array.isArray(content)) {
    const text = content
      .map(block => (block as { type?: string; text?: string }).type === 'text' ? (block as { text?: string }).text ?? '' : JSON.stringify(block))
      .filter(part => part !== '')
      .join('\n')
    if (text !== '') return text
  }
  return JSON.stringify(result)
}
